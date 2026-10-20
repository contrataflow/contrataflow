import { uuidv7 } from '@contrataflow/observability';
import { AUDIT_ACTIONS } from '@contrataflow/types';
import type { DomainEventEnvelope } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { InlineEventHandler, InlineHandlerContext } from './inline-handlers.js';
import { rowHashOf } from '../admin/platform-audit.js';
import type { AuditRow } from '../admin/platform-audit.js';
import { classifyJobError } from '../queues/job-errors.js';

/*
 * `EtpEstimateSynchronizer` (US-022 · RN-ETP-29/31): mantém o valor estimado do ETP vinculado à
 * pesquisa de preços (`estimatedValueSource = PRICE_RESEARCH`) igual ao `totalEstimatedValue` da
 * pesquisa, a cada `PriceResearchRecalculated` (`price_research.recalculated`) ou
 * `PriceResearchCompleted` (`document.finalized.price_research` — DEC-018: concluir a pesquisa é
 * finalizar o documento); no cancelamento da pesquisa (`document.canceled.price_research`) desfaz o
 * vínculo e preserva o último valor (FA-04 — lacuna 2 da story).
 *
 * Roda no job do `domain-events`, na transação do tenant do evento (papel `cf_worker`, RLS). Lê o
 * ESTADO atual (não o payload, que não traz valores — DEC-030), então é idempotente por natureza: o
 * `UPDATE … WHERE estimated_total_value IS DISTINCT FROM total` de uma reentrega (ou de um evento
 * antigo fora de ordem) não acha linha, não sobe a versão nem grava auditoria (RN-ETP-29: o par
 * `priceResearchId` + `lastCalculatedAt` já está refletido no valor). Só ETPs em `DRAFT`/`RETURNED`
 * recebem o valor novo (RN-ETP-30: o valor de um ETP em análise/finalizado é o da versão); o
 * desvínculo vale para todo ETP não excluído (o vínculo com pesquisa cancelada não tem uso). Cada
 * mudança grava `document.draft_update` (`SYSTEM`, sem valores — `metadata.trigger`) e sobe a versão
 * do ETP (o `If-Match` aberto na tela vira 412). Logs sem valores.
 */

export type EtpEstimateSyncTrigger = 'recalculated' | 'completed' | 'canceled';

const TRIGGERS: Readonly<Record<string, EtpEstimateSyncTrigger>> = {
  'price_research.recalculated': 'recalculated',
  'document.finalized.price_research': 'completed',
  'document.canceled.price_research': 'canceled',
};

/** Routing keys consumidas (as rotas do fan-out — `routes.ts`). */
export const ETP_ESTIMATE_SYNC_ROUTING_KEYS = Object.keys(TRIGGERS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Status do documento ETP em que o valor ainda é editável (RN-ETP-30). */
const EDITABLE = ['DRAFT', 'RETURNED'];

export interface EtpEstimateSyncInput {
  readonly tenantId: string;
  readonly priceResearchId: string;
  readonly trigger: EtpEstimateSyncTrigger;
  readonly eventId: string;
  readonly correlationId: string;
  readonly now: Date;
}

/** ETP alterado pela sincronização. */
export interface SyncedEtp {
  readonly id: string;
  readonly processId: string;
  readonly documentId: string;
  readonly version: number;
}

export interface EtpEstimateSyncResult {
  readonly synced: readonly SyncedEtp[];
  /** ETPs vinculados à pesquisa sem nada a aplicar (reentrega ou total inalterado). */
  readonly unchanged: number;
}

interface SyncedRow {
  readonly id: string;
  readonly process_id: string;
  readonly document_id: string;
  readonly version: number;
}

const toSynced = (row: SyncedRow): SyncedEtp => ({
  id: row.id,
  processId: row.process_id,
  documentId: row.document_id,
  version: row.version,
});

/** RN-ETP-29: copia o total atual da pesquisa (não cancelada) para os ETPs editáveis vinculados. */
async function syncValue(client: SqlClient, input: EtpEstimateSyncInput): Promise<SyncedEtp[]> {
  const result = await client.query<SyncedRow>(
    `WITH research AS (
       SELECT pr.id, pr.total_estimated_value
         FROM price_research pr
         JOIN documents rd ON rd.tenant_id = pr.tenant_id AND rd.id = pr.document_id
        WHERE pr.id = $1 AND rd.status <> 'CANCELED' AND rd.deleted_at IS NULL
     ), target AS (
       SELECT e.id
         FROM etps e
         JOIN research r ON r.id = e.price_research_id
         JOIN documents d ON d.tenant_id = e.tenant_id AND d.id = e.document_id
        WHERE e.estimated_value_source = 'PRICE_RESEARCH'
          AND e.estimated_total_value IS DISTINCT FROM r.total_estimated_value
          AND d.status::text = ANY($3::text[]) AND d.deleted_at IS NULL
        FOR UPDATE OF e
     )
     UPDATE etps e
        SET estimated_total_value = r.total_estimated_value, updated_at = $2,
            version = e.version + 1
       FROM target t, research r
      WHERE e.id = t.id
      RETURNING e.id, e.process_id, e.document_id, e.version`,
    [input.priceResearchId, input.now, EDITABLE],
  );
  return result.rows.map(toSynced);
}

/** RN-ETP-31 (FA-04): pesquisa cancelada → vínculo desfeito, o último valor fica como referência. */
async function unlink(client: SqlClient, input: EtpEstimateSyncInput): Promise<SyncedEtp[]> {
  const result = await client.query<SyncedRow>(
    `WITH target AS (
       SELECT e.id
         FROM etps e
         JOIN documents d ON d.tenant_id = e.tenant_id AND d.id = e.document_id
        WHERE e.price_research_id = $1 AND d.deleted_at IS NULL
        FOR UPDATE OF e
     )
     UPDATE etps e
        SET estimated_value_source = NULL, price_research_id = NULL, updated_at = $2,
            version = e.version + 1
       FROM target t
      WHERE e.id = t.id
      RETURNING e.id, e.process_id, e.document_id, e.version`,
    [input.priceResearchId, input.now],
  );
  return result.rows.map(toSynced);
}

async function linkedCount(client: SqlClient, priceResearchId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM etps WHERE price_research_id = $1`,
    [priceResearchId],
  );
  return result.rows[0]?.count ?? 0;
}

function auditRowOf(input: EtpEstimateSyncInput, etp: SyncedEtp): AuditRow {
  const canceled = input.trigger === 'canceled';
  return {
    id: uuidv7(),
    occurredAt: input.now,
    tenantId: input.tenantId,
    actorType: 'SYSTEM',
    actorUserId: null,
    actorName: 'Sistema',
    actorMembershipId: null,
    onBehalfOfUserId: null,
    action: 'document.draft_update',
    category: AUDIT_ACTIONS['document.draft_update'].category,
    result: 'SUCCESS',
    entityType: 'Document',
    entityId: etp.documentId,
    processId: etp.processId,
    changes: null,
    metadata: {
      target: 'HEADER',
      fields: canceled ? ['estimatedValueSource', 'priceResearchId'] : ['estimatedTotalValue'],
      estimatedValueSource: canceled ? null : 'PRICE_RESEARCH',
      priceResearchId: input.priceResearchId,
      trigger: input.trigger,
      eventId: input.eventId,
      version: etp.version,
    },
    reasonCode: null,
    ip: null,
    userAgent: null,
    correlationId: input.correlationId,
    requestId: null,
    sessionIdHash: null,
  };
}

async function insertAudit(client: SqlClient, row: AuditRow): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, actor_name, action, category,
       result, entity_type, entity_id, process_id, metadata, correlation_id, row_hash)
     VALUES ($1, $2, $3, 'SYSTEM', $4, $5, $6::audit_category, $7::audit_result, $8, $9, $10,
       $11::jsonb, $12, $13)`,
    [
      row.id,
      row.occurredAt,
      row.tenantId,
      row.actorName,
      row.action,
      row.category,
      row.result,
      row.entityType,
      row.entityId,
      row.processId,
      JSON.stringify(row.metadata),
      row.correlationId,
      rowHashOf(row),
    ],
  );
}

/**
 * A sincronização numa transação do tenant (RLS): ETPs alterados + auditoria de cada um. Exposta
 * para o teste de integração com o papel `cf_worker`.
 */
export async function syncEtpEstimates(
  client: SqlClient,
  input: EtpEstimateSyncInput,
): Promise<EtpEstimateSyncResult> {
  const synced =
    input.trigger === 'canceled' ? await unlink(client, input) : await syncValue(client, input);
  for (const etp of synced) await insertAudit(client, auditRowOf(input, etp));
  const unchanged = synced.length === 0 ? await linkedCount(client, input.priceResearchId) : 0;
  return { synced, unchanged };
}

let syncedCounter: Counter | undefined;

function countSynced(trigger: EtpEstimateSyncTrigger, count: number): void {
  syncedCounter ??= metrics
    .getMeter('contrataflow-worker')
    .createCounter('etp_estimate_synced_total', {
      description:
        'ETPs atualizados pela pesquisa de preços vinculada (RN-ETP-29/31), por gatilho.',
    });
  syncedCounter.add(count, { trigger });
}

/** O id da pesquisa no evento: `priceResearchId` (recálculo) ou `documentId` (= id da pesquisa). */
function priceResearchIdOf(
  event: DomainEventEnvelope<Record<string, unknown>>,
  trigger: EtpEstimateSyncTrigger,
): string | null {
  const id = trigger === 'recalculated' ? event.payload.priceResearchId : event.payload.documentId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

export class EtpEstimateSynchronizer implements InlineEventHandler {
  readonly name = 'EtpEstimateSynchronizer';
  private readonly logger = new Logger('EtpEstimateSynchronizer');

  constructor(private readonly now: () => Date = () => new Date()) {}

  async handle(
    event: DomainEventEnvelope<Record<string, unknown>>,
    context?: InlineHandlerContext,
  ): Promise<void> {
    const trigger = TRIGGERS[event.routingKey];
    if (trigger === undefined || event.tenantId === null) return;
    const priceResearchId = priceResearchIdOf(event, trigger);
    if (priceResearchId === null) {
      this.logger.warn({ event: 'etp.estimate_sync_bad_payload', eventId: event.eventId });
      return;
    }
    if (context === undefined) {
      throw new Error('EtpEstimateSynchronizer: sem a transação do job de domain-events');
    }
    const { tenantId } = event;
    const correlationId = context.meta.correlationId;
    let result: EtpEstimateSyncResult;
    try {
      result = await context.tenantTransaction((client) =>
        syncEtpEstimates(client, {
          tenantId,
          priceResearchId,
          trigger,
          eventId: event.eventId,
          correlationId,
          now: this.now(),
        }),
      );
    } catch (error) {
      this.logger.error({
        event: 'etp.estimate_sync_failed',
        priceResearchId,
        trigger,
        errorClass: classifyJobError(error),
        correlationId,
      });
      throw error;
    }
    for (const etp of result.synced) {
      this.logger.log({ event: 'etp.estimate_synced', etpId: etp.id, priceResearchId, trigger });
    }
    if (result.synced.length > 0) countSynced(trigger, result.synced.length);
    if (trigger === 'completed' && result.synced.length === 0 && result.unchanged === 0) {
      // US-032 (FA-04): pesquisa concluída sem ETP vinculado — só o processo recebeu o valor.
      this.logger.warn({
        event: 'price_research.etp_sync_skipped',
        priceResearchId,
        correlationId,
      });
    }
    if (result.unchanged > 0) {
      // Reentrega (ou recálculo sem mudança do total): nada aplicado, nenhum efeito duplicado.
      this.logger.warn({
        event: 'etp.estimate_sync_retry',
        priceResearchId,
        trigger,
        linkedEtps: result.unchanged,
        attempt: context.attempt,
        correlationId,
      });
    }
  }
}

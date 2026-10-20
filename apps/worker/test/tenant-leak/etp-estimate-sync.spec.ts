// Sincronização do valor estimado do ETP com a pesquisa de preços (US-022 · RN-ETP-29/31) sobre
// PostgreSQL real, com o papel `cf_worker` (sem BYPASSRLS) e o privilégio de coluna da migração
// `20261019160000_etp_estimate_sync`: o `EtpEstimateSynchronizer` roda pelo `DomainEventsProcessor`
// na transação do tenant do evento, copia o total da pesquisa para o ETP vinculado em DRAFT, grava
// `document.draft_update` (SYSTEM, sem valores) uma única vez mesmo com o evento entregue duas
// vezes, desfaz o vínculo quando a pesquisa é cancelada e nunca toca a Prefeitura B. Com o relay
// fora do ar, o `PriceResearchRecalculated` fica PENDING e o ETP só muda quando o evento chega.
// Processo, documentos, pesquisas e ETPs vêm por SQL com as FKs desligadas
// (`session_replication_role`): o que se prova aqui é o consumidor, não os agregados.
import type { DomainEventEnvelope, JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainEventsProcessor } from '../../src/events/domain-events.processor.js';
import { EtpEstimateSynchronizer } from '../../src/events/etp-estimate-synchronizer.js';
import type { InlineHandlerContext } from '../../src/events/inline-handlers.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import {
  DOC_TYPE_A,
  DOC_TYPE_B,
  TENANT_A,
  TENANT_B,
  seedQueueFixtures,
} from '../support/queue-fixtures.js';

const PROCESS_A = '0192f022-0000-7000-8000-0000000000a1';
const PROCESS_B = '0192f022-0000-7000-8000-0000000000b1';
const USER = '0192f022-0000-7000-8000-0000000000c1';
const RESEARCH_A = '0192f022-0000-7000-8000-0000000000d1';
const RESEARCH_B = '0192f022-0000-7000-8000-0000000000d2';
const ETP_LINKED = '0192f022-0000-7000-8000-0000000000e1';
const ETP_FINALIZED = '0192f022-0000-7000-8000-0000000000e2';
const ETP_MANUAL = '0192f022-0000-7000-8000-0000000000e3';
const ETP_B = '0192f022-0000-7000-8000-0000000000e4';
const ANY = '0192f022-0000-7000-8000-0000000000ff';
const NOW = new Date('2026-10-19T18:00:00.000Z');

let db: TestPostgres;
let worker: WorkerDatabase;
let sequence = 0;

const processSql = (id: string, tenantId: string) => `
  INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
    requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
    origin_id, pca_status, created_by_id)
  VALUES ('${id}', '${tenantId}', '${ANY}', 2026, 'Processo de obras', 'Objeto do processo de obras', '${ANY}', '${ANY}', '${ANY}',
    '${ANY}', '${ANY}', '${ANY}', 'NOT_APPLICABLE', '${USER}');`;

const documentSql = (
  id: string,
  tenantId: string,
  processId: string,
  typeId: string,
  status = 'DRAFT',
) => `
  INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status, created_by_id)
  VALUES ('${id}', '${tenantId}', '${processId}', '${typeId}', 'Documento ${id.slice(-2)}', '${status}',
    '${USER}');`;

const researchSql = (id: string, tenantId: string, processId: string, total: string | null) => `
  INSERT INTO price_research (id, tenant_id, process_id, document_id, reference_date, default_method,
    cv_threshold_percent, min_quotations, direct_quote_max_age_days, similar_contract_max_age_days,
    outlier_lower_percent, outlier_upper_percent, unit_price_decimals, rounding_mode,
    total_estimated_value, last_calculated_at)
  VALUES ('${id}', '${tenantId}', '${processId}', '${id}', '2026-10-01', 'AUTO_CV', 25, 3, 180, 365,
    70, 130, 2, 'HALF_UP', ${total === null ? 'NULL' : `'${total}'`}, '${NOW.toISOString()}');`;

const etpSql = (
  id: string,
  tenantId: string,
  processId: string,
  estimate: { source: string | null; total: string | null; researchId: string | null },
) => `
  INSERT INTO etps (id, tenant_id, process_id, document_id, estimated_total_value,
    estimated_value_source, price_research_id)
  VALUES ('${id}', '${tenantId}', '${processId}', '${id}',
    ${estimate.total === null ? 'NULL' : `'${estimate.total}'`},
    ${estimate.source === null ? 'NULL' : `'${estimate.source}'`},
    ${estimate.researchId === null ? 'NULL' : `'${estimate.researchId}'`});`;

function envelope(
  tenantId: string,
  routingKey: string,
  payload: Record<string, unknown>,
): DomainEventEnvelope<Record<string, unknown>> {
  sequence += 1;
  return {
    eventId: `0192f022-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    eventType: routingKey.startsWith('price_research')
      ? 'PriceResearchRecalculated'
      : 'DocumentFinalized',
    routingKey,
    eventVersion: 1,
    occurredAt: NOW.toISOString(),
    tenantId,
    aggregateType: 'PriceResearch',
    aggregateId: RESEARCH_A,
    processId: PROCESS_A,
    actor: { type: 'USER', userId: USER, membershipId: null },
    correlationId: `corr-${String(sequence)}`,
    causationId: null,
    payload,
  };
}

function metaOf(tenantId: string): JobMeta {
  return {
    schemaVersion: 1,
    tenantId,
    actor: { type: 'SYSTEM', userId: null, membershipId: null },
    correlationId: 'corr-us022',
    causationId: null,
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    enqueuedAt: NOW.toISOString(),
  };
}

/** O job do `domain-events` reduzido ao que o processador usa (o `runJob` real faz o mesmo). */
async function deliver(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
  const tenantId = event.tenantId ?? TENANT_A;
  const context: InlineHandlerContext = {
    meta: metaOf(tenantId),
    attempt: 1,
    jobId: event.eventId,
    tenantTransaction: (work) => worker.tenantTransaction(tenantId, work),
  };
  const processor = new DomainEventsProcessor({
    queues: { add: () => Promise.resolve() },
    // As rotas reais: `document.*` também passa pelas métricas (sem efeito aqui).
    handlers: [
      new EtpEstimateSynchronizer(() => NOW),
      { name: 'BusinessMetricsCollector', handle: () => Promise.resolve() },
    ],
  });
  await processor.process(
    { meta: metaOf(tenantId), payload: { envelope: event } },
    event.eventId,
    context,
  );
}

const etpState = (id: string) =>
  db
    .admin<{
      estimated_total_value: string | null;
      estimated_value_source: string | null;
      price_research_id: string | null;
      version: number;
    }>(
      `SELECT estimated_total_value::text AS estimated_total_value,
            estimated_value_source::text AS estimated_value_source, price_research_id, version
       FROM etps WHERE id = $1`,
      [id],
    )
    .then((rows) => rows[0]);

const syncAudits = (documentId: string) =>
  db.admin<{ actor_type: string; metadata: Record<string, unknown>; changes: unknown }>(
    `SELECT actor_type::text AS actor_type, metadata, changes FROM audit_logs
      WHERE action = 'document.draft_update' AND entity_id = $1 ORDER BY occurred_at, id`,
    [documentId],
  );

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    INSERT INTO users (id, external_subject, email, name) VALUES
      ('${USER}', 'sub-us022', 'ana@a.test', 'Ana');
    SET session_replication_role = replica;
    ${processSql(PROCESS_A, TENANT_A)}
    ${processSql(PROCESS_B, TENANT_B)}
    ${documentSql(RESEARCH_A, TENANT_A, PROCESS_A, DOC_TYPE_A, 'FINALIZED')}
    ${documentSql(RESEARCH_B, TENANT_B, PROCESS_B, DOC_TYPE_B, 'FINALIZED')}
    ${documentSql(ETP_LINKED, TENANT_A, PROCESS_A, DOC_TYPE_A)}
    ${documentSql(ETP_FINALIZED, TENANT_A, PROCESS_A, DOC_TYPE_A, 'FINALIZED')}
    ${documentSql(ETP_MANUAL, TENANT_A, PROCESS_A, DOC_TYPE_A)}
    ${documentSql(ETP_B, TENANT_B, PROCESS_B, DOC_TYPE_B)}
    ${researchSql(RESEARCH_A, TENANT_A, PROCESS_A, '125000.00')}
    ${researchSql(RESEARCH_B, TENANT_B, PROCESS_B, '777.00')}
    ${etpSql(ETP_LINKED, TENANT_A, PROCESS_A, { source: 'PRICE_RESEARCH', total: '125000.00', researchId: RESEARCH_A })}
    ${etpSql(ETP_FINALIZED, TENANT_A, PROCESS_A, { source: 'PRICE_RESEARCH', total: '125000.00', researchId: RESEARCH_A })}
    ${etpSql(ETP_MANUAL, TENANT_A, PROCESS_A, { source: 'MANUAL', total: '10.00', researchId: null })}
    ${etpSql(ETP_B, TENANT_B, PROCESS_B, { source: 'PRICE_RESEARCH', total: '1.00', researchId: RESEARCH_B })}
    SET session_replication_role = origin;
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

describe('EtpEstimateSynchronizer sobre PostgreSQL (US-022 · RN-ETP-29/31)', () => {
  it('[Falha de integração] relay fora: o recálculo fica PENDING no outbox e o ETP só muda quando o evento chega', async () => {
    // O recálculo (US-029) grava o total novo e o evento na mesma transação da API.
    await db.admin(`UPDATE price_research SET total_estimated_value = '130000.00' WHERE id = $1;`, [
      RESEARCH_A,
    ]);
    await db.admin(
      `INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, event_version,
         aggregate_type, aggregate_id, process_id, payload, metadata, occurred_at)
       VALUES (gen_random_uuid(), $1, 'PriceResearchRecalculated', 'price_research.recalculated', 1,
         'PriceResearch', $2, $3, $4::jsonb, '{}'::jsonb, $5)`,
      [
        TENANT_A,
        RESEARCH_A,
        PROCESS_A,
        JSON.stringify({ priceResearchId: RESEARCH_A, itemsCount: 2, itemsWithAlertsCount: 0 }),
        NOW,
      ],
    );
    expect(
      await db.admin(`SELECT status::text AS status FROM outbox_events WHERE aggregate_id = $1`, [
        RESEARCH_A,
      ]),
    ).toEqual([{ status: 'PENDING' }]);
    expect(await etpState(ETP_LINKED)).toMatchObject({ estimated_total_value: '125000.00' });

    // O relay volta: o evento é entregue ao consumidor.
    await deliver(
      envelope(TENANT_A, 'price_research.recalculated', {
        priceResearchId: RESEARCH_A,
        itemsCount: 2,
        itemsWithAlertsCount: 0,
      }),
    );
    expect(await etpState(ETP_LINKED)).toEqual({
      estimated_total_value: '130000.00',
      estimated_value_source: 'PRICE_RESEARCH',
      price_research_id: RESEARCH_A,
      version: 2,
    });
    // RN-ETP-30: o ETP finalizado guarda o valor da versão; o manual não é tocado.
    expect(await etpState(ETP_FINALIZED)).toMatchObject({
      estimated_total_value: '125000.00',
      version: 1,
    });
    expect(await etpState(ETP_MANUAL)).toMatchObject({
      estimated_total_value: '10.00',
      version: 1,
    });
    const audits = await syncAudits(ETP_LINKED);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: 'SYSTEM',
      changes: null,
      metadata: {
        target: 'HEADER',
        fields: ['estimatedTotalValue'],
        estimatedValueSource: 'PRICE_RESEARCH',
        priceResearchId: RESEARCH_A,
        trigger: 'recalculated',
      },
    });
    // Valores nunca vão para a auditoria.
    expect(JSON.stringify(audits)).not.toContain('130000');
  });

  it('[Duplicidade] o mesmo PriceResearchRecalculated entregue duas vezes atualiza uma única vez', async () => {
    await db.admin(`UPDATE price_research SET total_estimated_value = '131000.00' WHERE id = $1`, [
      RESEARCH_A,
    ]);
    const event = envelope(TENANT_A, 'price_research.recalculated', {
      priceResearchId: RESEARCH_A,
      itemsCount: 2,
      itemsWithAlertsCount: 0,
    });
    await deliver(event);
    await deliver(event);
    expect(await etpState(ETP_LINKED)).toMatchObject({
      estimated_total_value: '131000.00',
      version: 3,
    });
    expect(await syncAudits(ETP_LINKED)).toHaveLength(2);
  });

  it('PriceResearchCompleted (document.finalized.price_research) também sincroniza', async () => {
    await db.admin(`UPDATE price_research SET total_estimated_value = '132000.00' WHERE id = $1`, [
      RESEARCH_A,
    ]);
    await deliver(
      envelope(TENANT_A, 'document.finalized.price_research', {
        documentId: RESEARCH_A,
        documentTypeCode: 'PRICE_RESEARCH',
      }),
    );
    expect(await etpState(ETP_LINKED)).toMatchObject({ estimated_total_value: '132000.00' });
    expect((await syncAudits(ETP_LINKED)).at(-1)?.metadata).toMatchObject({ trigger: 'completed' });
  });

  it('[Tenant incorreto] a RLS limita a sincronização ao tenant do evento: a pesquisa de B não é vista com o tenant A', async () => {
    await db.admin(`UPDATE price_research SET total_estimated_value = '999.00' WHERE id = $1`, [
      RESEARCH_B,
    ]);
    // Evento com o id da pesquisa de B, mas no tenant A: nada é lido nem alterado.
    await deliver(
      envelope(TENANT_A, 'price_research.recalculated', {
        priceResearchId: RESEARCH_B,
        itemsCount: 1,
        itemsWithAlertsCount: 0,
      }),
    );
    expect(await etpState(ETP_B)).toMatchObject({ estimated_total_value: '1.00', version: 1 });
    await deliver(
      envelope(TENANT_B, 'price_research.recalculated', {
        priceResearchId: RESEARCH_B,
        itemsCount: 1,
        itemsWithAlertsCount: 0,
      }),
    );
    expect(await etpState(ETP_B)).toMatchObject({ estimated_total_value: '999.00', version: 2 });
    expect(await etpState(ETP_LINKED)).toMatchObject({ estimated_total_value: '132000.00' });
  });

  it('FA-04: pesquisa cancelada → vínculo desfeito com o último valor preservado (inclusive no ETP finalizado)', async () => {
    await db.admin(
      `UPDATE documents SET status = 'CANCELED', cancellation_reason = 'Refazer' WHERE id = $1`,
      [RESEARCH_A],
    );
    await deliver(
      envelope(TENANT_A, 'document.canceled.price_research', {
        documentId: RESEARCH_A,
        documentTypeCode: 'PRICE_RESEARCH',
        fromStatus: 'FINALIZED',
      }),
    );
    expect(await etpState(ETP_LINKED)).toMatchObject({
      estimated_total_value: '132000.00',
      estimated_value_source: null,
      price_research_id: null,
    });
    expect(await etpState(ETP_FINALIZED)).toMatchObject({
      estimated_total_value: '125000.00',
      estimated_value_source: null,
      price_research_id: null,
    });
    expect((await syncAudits(ETP_LINKED)).at(-1)?.metadata).toMatchObject({
      fields: ['estimatedValueSource', 'priceResearchId'],
      estimatedValueSource: null,
      trigger: 'canceled',
    });
    // Recálculo atrasado da pesquisa cancelada não religa nem altera nada.
    await deliver(
      envelope(TENANT_A, 'price_research.recalculated', {
        priceResearchId: RESEARCH_A,
        itemsCount: 2,
        itemsWithAlertsCount: 0,
      }),
    );
    expect(await etpState(ETP_LINKED)).toMatchObject({
      estimated_total_value: '132000.00',
      estimated_value_source: null,
    });
  });

  it('o cf_worker só altera as colunas da sincronização em etps', async () => {
    await expect(
      worker.tenantTransaction(TENANT_A, (client) =>
        client.query(`UPDATE etps SET conclusion = 'VIABLE' WHERE id = $1`, [ETP_MANUAL]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

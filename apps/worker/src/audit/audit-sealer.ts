import { createHash } from 'node:crypto';

import { uuidv7 } from '@contrataflow/observability';
import { AUDIT_ACTIONS } from '@contrataflow/types';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';
import { z } from 'zod';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { rowHashOf } from '../admin/platform-audit.js';
import type { AuditRow } from '../admin/platform-audit.js';
import { classifyJobError } from '../queues/job-errors.js';
import type { HandlerResult, JobHandler, JobHandlerContext } from '../queues/run-job.js';

/*
 * `audit-seal.seal-tenant` — `AuditSealer` (US-074 · ADR-009 · RN-AUD-11..14 · queues.md §4.7).
 * Enfileirado pelo `audit-seal.tick` (minuto 5 de toda hora) por tenant `ACTIVE`. Sela, EM ORDEM,
 * cada hora cheia fechada com atividade posterior ao último selo do tenant — a hora que falhou
 * numa execução é selada na seguinte, antes das mais novas, e a cadeia nunca pula um período.
 *
 * Por período, UMA transação do tenant (RLS) sob trava consultiva por tenant:
 *   1. último selo (`chainHash` anterior; 64 zeros no primeiro — RN-AUD-11);
 *   2. próxima hora fechada com registro que não seja `audit.seal` (RN-AUD-12: sem selo vazio, e o
 *      próprio `audit.seal` não gera o selo seguinte para sempre);
 *   3. `rowHash` do período por `(occurred_at, id)` → `digest`, `chainHash`;
 *   4. `INSERT … ON CONFLICT DO NOTHING` (RN-AUD-13) e, no mesmo `tx` (RN-AUD-01), o `audit.seal`
 *      com `occurredAt = agora` — sempre num período posterior ao selado (RN-AUD-14).
 * A definição de `digest`/`chainHash` é a de `apps/api/src/modules/audit/domain/audit-seal.ts`
 * (vetores fixos nos dois lados).
 */

/** `chainHash` "anterior" do primeiro selo do tenant (RN-AUD-11). */
export const GENESIS_CHAIN_HASH = '0'.repeat(64);

const HOUR_MS = 3_600_000;

/** Folga após o fim da hora antes de selá-la (transações em voo; o tick roda no minuto 5). */
export const SEAL_GRACE_MS = 2 * 60_000;

/** Períodos selados por execução (alcança uma semana de atraso; o resto fica para a próxima). */
export const MAX_PERIODS_PER_RUN = 168;

const ACTOR_NAME = 'audit-seal:seal-tenant';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** `digest` do período: SHA-256 da concatenação dos `rowHash` na ordem `(occurredAt, id)`. */
export function periodDigest(rowHashes: readonly string[]): string {
  return sha256Hex(rowHashes.join(''));
}

/** `chainHash` = SHA-256(`chainHash` anterior ∥ `digest`). */
export function chainHashOf(previousChainHash: string, digest: string): string {
  return sha256Hex(previousChainHash + digest);
}

function hourOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

export interface CreatedSeal {
  readonly id: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly recordCount: number;
  readonly digest: string;
  readonly chainHash: string;
  readonly previousSealId: string | null;
}

export type SealStep =
  | { readonly kind: 'created'; readonly seal: CreatedSeal }
  /** Nenhuma hora fechada com atividade depois do último selo. */
  | { readonly kind: 'up_to_date' }
  /** Outro processo selou o período entre a leitura e o INSERT (sem a trava — RN-AUD-13). */
  | { readonly kind: 'duplicate'; readonly periodStart: Date };

interface SealerInstruments {
  readonly created: Counter;
  readonly failed: Counter;
  readonly duration: Histogram;
}

let instruments: SealerInstruments | undefined;

/** Métricas da selagem (DoD · alerta A21 junto da vivacidade do scheduler `audit-seal-tick`). */
function sealerMetrics(): SealerInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-worker');
  instruments = {
    created: meter.createCounter('audit_seals_created_total', {
      description: 'Selos de auditoria gravados pelo AuditSealer (US-074).',
    }),
    failed: meter.createCounter('audit_seal_failed_total', {
      description: 'Jobs de selagem que esgotaram as tentativas (dead letter — US-074).',
    }),
    duration: meter.createHistogram('audit_seal_duration_ms', {
      description: 'Duração da selagem de um período (leitura dos rowHash, hash e INSERT).',
      unit: 'ms',
    }),
  };
  return instruments;
}

export interface AuditSealerOptions {
  readonly now?: () => Date;
  readonly maxPeriodsPerRun?: number;
}

export class AuditSealer implements JobHandler<Record<string, never>> {
  readonly queue = 'audit-seal' as const;
  readonly name = 'seal-tenant';
  readonly payloadSchema = z.strictObject({});

  private readonly now: () => Date;
  private readonly maxPeriodsPerRun: number;

  constructor(options: AuditSealerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxPeriodsPerRun = options.maxPeriodsPerRun ?? MAX_PERIODS_PER_RUN;
  }

  async handle(
    _payload: Record<string, never>,
    context: JobHandlerContext,
  ): Promise<HandlerResult> {
    const { tenantId } = context.meta;
    if (tenantId === null) return 'skipped';
    // Só horas cujo fim já passou da folga: `period_start < limite`.
    const limit = hourOf(new Date(this.now().getTime() - SEAL_GRACE_MS));
    let sealed = 0;
    try {
      while (sealed < this.maxPeriodsPerRun) {
        const started = Date.now();
        const step = await context.tenantTransaction((client) =>
          this.sealNext(client, tenantId, limit, context.meta.correlationId),
        );
        if (step.kind !== 'created') {
          if (step.kind === 'duplicate') {
            context.logger.log({
              event: 'audit.seal_duplicate',
              tenantId,
              periodStart: step.periodStart.toISOString(),
            });
          }
          break;
        }
        sealed += 1;
        const durationMs = Date.now() - started;
        sealerMetrics().created.add(1);
        sealerMetrics().duration.record(durationMs);
        context.logger.log({
          event: 'audit.seal_created',
          tenantId,
          periodStart: step.seal.periodStart.toISOString(),
          recordCount: step.seal.recordCount,
          durationMs,
        });
      }
    } catch (error) {
      this.reportFailure(error, context, tenantId);
      throw error;
    }
    if (sealed === 0) {
      context.logger.log({
        event: 'audit.seal_skipped_empty',
        tenantId,
        periodStart: new Date(limit.getTime() - HOUR_MS).toISOString(),
      });
    } else if (sealed >= this.maxPeriodsPerRun) {
      context.logger.warn({ event: 'audit.seal_backlog', tenantId, sealed });
    }
    return 'completed';
  }

  /** `warn audit.seal_retry` enquanto houver tentativa; `error audit.seal_failed` na última. */
  private reportFailure(error: unknown, context: JobHandlerContext, tenantId: string): void {
    const errorClass = classifyJobError(error);
    if (errorClass === 'DUPLICATE') return;
    const retries =
      errorClass === 'DEPENDENCY_DOWN' ||
      (errorClass === 'TRANSIENT' && context.attempt < context.maxAttempts);
    const errorName = error instanceof Error ? error.name : 'Error';
    if (retries) {
      context.logger.warn({
        event: 'audit.seal_retry',
        tenantId,
        attempt: context.attempt,
        maxAttempts: context.maxAttempts,
        errorClass,
        errorName,
      });
      return;
    }
    sealerMetrics().failed.add(1);
    context.logger.error({
      event: 'audit.seal_failed',
      alert: true,
      tenantId,
      attempt: context.attempt,
      errorClass,
      errorName,
    });
  }

  /** Sela a próxima hora pendente do tenant (uma transação). */
  async sealNext(
    client: SqlClient,
    tenantId: string,
    limit: Date,
    correlationId: string,
  ): Promise<SealStep> {
    // Cadeia sequencial por tenant: o segundo processo espera e relê o último selo.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `cf:audit-seal:${tenantId}`,
    ]);
    const { rows: lastRows } = await client.query<{
      id: string;
      period_start: Date;
      chain_hash: string;
    }>(
      `SELECT id::text, period_start, chain_hash
         FROM audit_seals
        WHERE tenant_id = $1
        ORDER BY period_start DESC
        LIMIT 1`,
      [tenantId],
    );
    const last = lastRows[0] ?? null;
    const from = last ? new Date(last.period_start.getTime() + HOUR_MS) : null;
    const { rows: nextRows } = await client.query<{ at: Date | null }>(
      `SELECT min(occurred_at) AS at
         FROM audit_logs
        WHERE tenant_id = $1
          AND occurred_at >= COALESCE($2::timestamptz, '-infinity'::timestamptz)
          AND occurred_at < $3
          AND action <> 'audit.seal'`,
      [tenantId, from, limit],
    );
    const at = nextRows[0]?.at ?? null;
    if (at === null) return { kind: 'up_to_date' };

    const periodStart = hourOf(at);
    const next = new Date(periodStart.getTime() + HOUR_MS);
    const { rows } = await client.query<{ id: string; row_hash: string }>(
      `SELECT id::text, row_hash
         FROM audit_logs
        WHERE tenant_id = $1
          AND occurred_at >= $2
          AND occurred_at < $3
        ORDER BY occurred_at, id`,
      [tenantId, periodStart, next],
    );
    const first = rows[0];
    const lastRow = rows.at(-1);
    if (first === undefined || lastRow === undefined) return { kind: 'up_to_date' };

    const digest = periodDigest(rows.map((row) => row.row_hash));
    const seal: CreatedSeal = {
      id: uuidv7(),
      periodStart,
      periodEnd: new Date(next.getTime() - 1),
      recordCount: rows.length,
      digest,
      chainHash: chainHashOf(last?.chain_hash ?? GENESIS_CHAIN_HASH, digest),
      previousSealId: last?.id ?? null,
    };
    const sealedAt = this.now();
    const inserted = await client.query(
      `INSERT INTO audit_seals (id, tenant_id, period_start, period_end, first_audit_id,
         last_audit_id, record_count, digest, previous_seal_id, chain_hash, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, period_start) DO NOTHING`,
      [
        seal.id,
        tenantId,
        seal.periodStart,
        seal.periodEnd,
        first.id,
        lastRow.id,
        seal.recordCount,
        seal.digest,
        seal.previousSealId,
        seal.chainHash,
        sealedAt,
      ],
    );
    if (inserted.rowCount === 0) return { kind: 'duplicate', periodStart };
    await insertSealAudit(client, tenantId, seal, sealedAt, correlationId);
    return { kind: 'created', seal };
  }
}

/** `audit.seal` (SYSTEM) no tenant, com o `rowHash` da API (RN-AUD-08). */
async function insertSealAudit(
  client: SqlClient,
  tenantId: string,
  seal: CreatedSeal,
  occurredAt: Date,
  correlationId: string,
): Promise<void> {
  const row: AuditRow = {
    id: uuidv7(),
    occurredAt,
    tenantId,
    actorType: 'SYSTEM',
    actorUserId: null,
    actorName: ACTOR_NAME,
    actorMembershipId: null,
    onBehalfOfUserId: null,
    action: 'audit.seal',
    category: AUDIT_ACTIONS['audit.seal'].category,
    result: 'SUCCESS',
    entityType: 'AuditSeal',
    entityId: seal.id,
    processId: null,
    changes: null,
    metadata: {
      periodStart: seal.periodStart.toISOString(),
      periodEnd: seal.periodEnd.toISOString(),
      recordCount: seal.recordCount,
      digest: seal.digest,
    },
    reasonCode: null,
    ip: null,
    userAgent: null,
    correlationId: correlationId.slice(0, 64),
    requestId: null,
    sessionIdHash: null,
  };
  await client.query(
    `INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, actor_name, action, category,
       result, entity_type, entity_id, metadata, correlation_id, row_hash)
     VALUES ($1, $2, $3, 'SYSTEM', $4, $5, $6::audit_category, $7::audit_result, $8, $9,
       $10::jsonb, $11, $12)`,
    [
      row.id,
      row.occurredAt,
      tenantId,
      row.actorName,
      row.action,
      row.category,
      row.result,
      row.entityType,
      row.entityId,
      JSON.stringify(row.metadata),
      row.correlationId,
      rowHashOf(row),
    ],
  );
}

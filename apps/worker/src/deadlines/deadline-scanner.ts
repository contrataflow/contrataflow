import { uuidv7 } from '@contrataflow/observability';
import { localDateOf } from '@contrataflow/types';
import { ProcessStageDueSoon, ProcessStageOverdue } from '@contrataflow/validation';
import type { AnyDomainEventDefinition } from '@contrataflow/validation';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';
import { z } from 'zod';

import type { SqlClient } from '#shared/database/outbox-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';

import {
  businessDaysLeft,
  dueSoonCutoff,
  holidayWindowEnd,
  nonBusinessDatesOf,
  warnSettingOf,
} from './deadline-rules.js';
import type { HolidayRow } from './deadline-rules.js';
import { classifyJobError } from '../queues/job-errors.js';
import type { HandlerResult, JobHandler, JobHandlerContext } from '../queues/run-job.js';

/*
 * `deadlines.scan-tenant` — `DeadlineScanner` (US-055 · DEC-031 · RN-TRAM-81..85 · queues.md §4.6).
 * Enfileirado pelo `deadlines.tick` (a cada 15 min) por tenant `ACTIVE`. Varre só as passagens
 * `ACTIVE`, não pausadas e com `dueAt` (RN-TRAM-81):
 *   1. atrasadas (`now > dueAt`, `overdueSince` nulo) → `overdueSince = overdueNotifiedAt = now`,
 *      `processes.overdue_since` (desnormalizado), timeline `STAGE_OVERDUE` e `ProcessStageOverdue`;
 *   2. a vencer (≤ `deadlines.warnBeforeBusinessDays` dias úteis, `dueSoonNotifiedAt` nulo) →
 *      `dueSoonNotifiedAt = now` e `ProcessStageDueSoon` (FA-05: `warn = 0` não avisa).
 * Idempotência: a marca e o evento vão no MESMO `UPDATE … WHERE … IS NULL` + `INSERT` da transação
 * do lote — reexecutar não reemite. Exclusividade por ciclo (RN-TRAM-85): trava consultiva por
 * tenant (`cf:deadlines:{tenantId}`); quem não a obtém conclui como `skipped`. Lotes curtos com
 * `FOR UPDATE SKIP LOCKED` (sem locks longos nem disputa com a tramitação). Banco indisponível =
 * o lote é desfeito e o job falha; o ciclo seguinte reavalia as mesmas passagens. Sem `AuditLog`:
 * o evento e a timeline são o registro (story · "Auditoria").
 */

/** Passagens marcadas por transação (lote curto — story · "Transação"). */
export const DEADLINES_BATCH_SIZE = 200;

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
const WARN_KEY = 'deadlines.warnBeforeBusinessDays';
const OPTIONAL_KEY = 'calendar.optionalHolidaysAreNonBusiness';
const SYSTEM_ACTOR = { type: 'SYSTEM', userId: null, membershipId: null } as const;

export interface DeadlineScanCounts {
  /** Passagens elegíveis (`ACTIVE`, não pausadas, com prazo) no início do ciclo. */
  readonly scanned: number;
  readonly dueSoonEmitted: number;
  readonly overdueEmitted: number;
}

/** Calendário do tenant lido uma vez por ciclo (cache do ciclo — story · "Impacto técnico"). */
interface CycleCalendar {
  readonly timezone: string;
  readonly today: string;
  readonly nonBusiness: ReadonlySet<string>;
  readonly dueSoonBefore: Date | null;
  readonly scanned: number;
}

interface MarkedStageRow {
  readonly id: string;
  readonly process_id: string;
  readonly due_at: Date;
  readonly assignee_id: string | null;
  readonly department_id: string;
  readonly stage_key: string;
  readonly stage_name: string;
}

interface DeadlineInstruments {
  readonly dueSoon: Counter;
  readonly overdue: Counter;
  readonly scanned: Counter;
  readonly duration: Histogram;
}

let instruments: DeadlineInstruments | undefined;

/** Métricas do job (DoD: `scanned`, `dueSoonEmitted`, `overdueEmitted`). */
function deadlineMetrics(): DeadlineInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-worker');
  instruments = {
    dueSoon: meter.createCounter('deadlines_due_soon_emitted_total', {
      description: 'ProcessStageDueSoon emitidos pelo job deadlines (US-055).',
    }),
    overdue: meter.createCounter('deadlines_overdue_emitted_total', {
      description: 'ProcessStageOverdue emitidos pelo job deadlines (US-055).',
    }),
    scanned: meter.createCounter('deadlines_stages_scanned_total', {
      description: 'Passagens ativas com prazo avaliadas pelo job deadlines (US-055).',
    }),
    duration: meter.createHistogram('deadlines_scan_duration_ms', {
      description: 'Duração da varredura de prazos de um tenant (US-055).',
      unit: 'ms',
    }),
  };
  return instruments;
}

export interface DeadlineScannerOptions {
  readonly database: Pick<WorkerDatabase, 'withAdvisoryLock'>;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

export class DeadlineScanner implements JobHandler<Record<string, never>> {
  readonly queue = 'deadlines' as const;
  readonly name = 'scan-tenant';
  readonly payloadSchema = z.strictObject({});

  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(private readonly options: DeadlineScannerOptions) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? DEADLINES_BATCH_SIZE;
  }

  async handle(
    _payload: Record<string, never>,
    context: JobHandlerContext,
  ): Promise<HandlerResult> {
    const { tenantId } = context.meta;
    if (tenantId === null) return 'skipped';
    const started = Date.now();
    let outcome: { acquired: boolean; result?: DeadlineScanCounts };
    try {
      outcome = await this.options.database.withAdvisoryLock(`cf:deadlines:${tenantId}`, () =>
        this.scan(context, tenantId),
      );
    } catch (error) {
      context.logger.error({
        event: 'process.deadlines_job_failed',
        tenantId,
        errorCode: classifyJobError(error),
        errorName: error instanceof Error ? error.name : 'Error',
        attempt: context.attempt,
        correlationId: context.meta.correlationId,
      });
      throw error;
    }
    if (!outcome.acquired || outcome.result === undefined) {
      context.logger.warn({ event: 'process.deadlines_lock_skipped', tenantId });
      return 'skipped';
    }
    const counts = outcome.result;
    const durationMs = Date.now() - started;
    const instrumentsNow = deadlineMetrics();
    instrumentsNow.scanned.add(counts.scanned);
    instrumentsNow.dueSoon.add(counts.dueSoonEmitted);
    instrumentsNow.overdue.add(counts.overdueEmitted);
    instrumentsNow.duration.record(durationMs);
    context.logger.log({
      event: 'process.deadlines_job_run',
      tenantId,
      ...counts,
      durationMs,
      lockAcquired: true,
    });
    return 'completed';
  }

  /** Um ciclo completo do tenant: calendário, atrasos e avisos antecipados, em lotes. */
  async scan(context: JobHandlerContext, tenantId: string): Promise<DeadlineScanCounts> {
    const now = this.now();
    const correlationId = context.meta.correlationId;
    const calendar = await context.tenantTransaction((client) =>
      this.loadCalendar(client, tenantId, now),
    );
    let overdueEmitted = 0;
    for (;;) {
      const marked = await context.tenantTransaction((client) =>
        this.markOverdueBatch(client, tenantId, now, correlationId),
      );
      overdueEmitted += marked;
      if (marked < this.batchSize) break;
    }
    let dueSoonEmitted = 0;
    const before = calendar.dueSoonBefore;
    if (before !== null) {
      for (;;) {
        const marked = await context.tenantTransaction((client) =>
          this.markDueSoonBatch(client, tenantId, now, before, calendar, correlationId),
        );
        dueSoonEmitted += marked;
        if (marked < this.batchSize) break;
      }
    }
    return { scanned: calendar.scanned, dueSoonEmitted, overdueEmitted };
  }

  private async loadCalendar(
    client: SqlClient,
    tenantId: string,
    now: Date,
  ): Promise<CycleCalendar> {
    const tenant = await client.query<{ timezone: string }>(
      'SELECT timezone FROM tenants WHERE id = $1',
      [tenantId],
    );
    const timezone = tenant.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
    const settings = await client.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM tenant_settings WHERE tenant_id = $1 AND key = ANY($2::text[])',
      [tenantId, [WARN_KEY, OPTIONAL_KEY]],
    );
    const valueOf = (key: string): unknown => settings.rows.find((row) => row.key === key)?.value;
    const warn = warnSettingOf(valueOf(WARN_KEY));
    const today = localDateOf(now, timezone);
    const holidays = await client.query<HolidayRow>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, scope::text AS scope, is_active
         FROM holidays
        WHERE tenant_id = $1 AND date BETWEEN $2::date AND $3::date`,
      [tenantId, today, holidayWindowEnd(today, warn)],
    );
    const nonBusiness = nonBusinessDatesOf(holidays.rows, valueOf(OPTIONAL_KEY) === true);
    const eligible = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM process_stages
        WHERE tenant_id = $1 AND status = 'ACTIVE' AND paused_at IS NULL AND due_at IS NOT NULL`,
      [tenantId],
    );
    return {
      timezone,
      today,
      nonBusiness,
      dueSoonBefore: dueSoonCutoff(today, warn, nonBusiness, timezone),
      scanned: Number(eligible.rows[0]?.count ?? 0),
    };
  }

  /** RN-TRAM-83: marca um lote de passagens vencidas e emite `ProcessStageOverdue`. */
  private async markOverdueBatch(
    client: SqlClient,
    tenantId: string,
    now: Date,
    correlationId: string,
  ): Promise<number> {
    const { rows } = await client.query<MarkedStageRow>(
      `WITH picked AS (
         SELECT id FROM process_stages
          WHERE tenant_id = $1 AND status = 'ACTIVE' AND paused_at IS NULL
            AND due_at IS NOT NULL AND due_at < $2
            AND overdue_since IS NULL AND overdue_notified_at IS NULL
          ORDER BY due_at, id
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       ), marked AS (
         UPDATE process_stages ps
            SET overdue_since = $2, overdue_notified_at = $2, updated_at = $2
           FROM picked
          WHERE ps.id = picked.id AND ps.tenant_id = $1
          RETURNING ps.id, ps.process_id, ps.workflow_stage_id, ps.due_at, ps.assignee_id,
                    ps.department_id
       )
       SELECT m.id, m.process_id, m.due_at, m.assignee_id, m.department_id,
              ws.key AS stage_key, ws.name AS stage_name
         FROM marked m
         JOIN workflow_stages ws ON ws.id = m.workflow_stage_id AND ws.tenant_id = $1
        ORDER BY m.due_at, m.id`,
      [tenantId, now, this.batchSize],
    );
    if (rows.length === 0) return 0;
    await client.query(
      `UPDATE processes SET overdue_since = $2
        WHERE tenant_id = $1 AND id = ANY($3::uuid[]) AND overdue_since IS NULL`,
      [tenantId, now, [...new Set(rows.map((row) => row.process_id))]],
    );
    for (const row of rows) {
      const eventId = await insertEvent(client, tenantId, now, correlationId, row.process_id, {
        definition: ProcessStageOverdue,
        payload: {
          ...stagePayloadOf(row),
          overdueSince: now.toISOString(),
        },
      });
      // Mesma projeção do `TimelineProjector` (events.md §5 · `STAGE_OVERDUE`): o evento nasce no
      // worker, então a entrada vai na mesma transação, idempotente por evento + tipo.
      await client.query(
        `INSERT INTO process_timeline_entries (id, tenant_id, process_id, occurred_at, type,
           actor_type, actor_id, actor_name, actor_department_name, entity_type, entity_id,
           movement_id, params, visibility, source_event_id)
         VALUES ($1, $2, $3, $4, 'STAGE_OVERDUE', 'SYSTEM'::actor_type, NULL, NULL, NULL,
           'ProcessStage', $5, NULL, $6::jsonb, 'STANDARD'::timeline_visibility, $7)
         ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING`,
        [
          uuidv7(),
          tenantId,
          row.process_id,
          now,
          row.id,
          JSON.stringify({
            stageName: row.stage_name,
            stageKey: row.stage_key,
            dueAt: row.due_at.toISOString(),
          }),
          eventId,
        ],
      );
    }
    return rows.length;
  }

  /** RN-TRAM-82: marca um lote de passagens a vencer e emite `ProcessStageDueSoon`. */
  private async markDueSoonBatch(
    client: SqlClient,
    tenantId: string,
    now: Date,
    before: Date,
    calendar: CycleCalendar,
    correlationId: string,
  ): Promise<number> {
    const { rows } = await client.query<MarkedStageRow>(
      `WITH picked AS (
         SELECT id FROM process_stages
          WHERE tenant_id = $1 AND status = 'ACTIVE' AND paused_at IS NULL
            AND due_at IS NOT NULL AND due_at >= $2 AND due_at < $3
            AND due_soon_notified_at IS NULL AND overdue_since IS NULL
          ORDER BY due_at, id
          LIMIT $4
          FOR UPDATE SKIP LOCKED
       ), marked AS (
         UPDATE process_stages ps
            SET due_soon_notified_at = $2, updated_at = $2
           FROM picked
          WHERE ps.id = picked.id AND ps.tenant_id = $1
          RETURNING ps.id, ps.process_id, ps.workflow_stage_id, ps.due_at, ps.assignee_id,
                    ps.department_id
       )
       SELECT m.id, m.process_id, m.due_at, m.assignee_id, m.department_id,
              ws.key AS stage_key, ws.name AS stage_name
         FROM marked m
         JOIN workflow_stages ws ON ws.id = m.workflow_stage_id AND ws.tenant_id = $1
        ORDER BY m.due_at, m.id`,
      [tenantId, now, before, this.batchSize],
    );
    for (const row of rows) {
      const dueDate = localDateOf(row.due_at, calendar.timezone);
      await insertEvent(client, tenantId, now, correlationId, row.process_id, {
        definition: ProcessStageDueSoon,
        payload: {
          ...stagePayloadOf(row),
          businessDaysLeft: businessDaysLeft(calendar.today, dueDate, calendar.nonBusiness),
        },
      });
    }
    return rows.length;
  }
}

function stagePayloadOf(row: MarkedStageRow): Record<string, unknown> {
  return {
    processStageId: row.id,
    stageKey: row.stage_key,
    dueAt: row.due_at.toISOString(),
    assigneeId: row.assignee_id,
    departmentId: row.department_id,
  };
}

/** Grava o evento `PENDING` no outbox (o relay publica — falha da fila não perde o fato). */
async function insertEvent(
  client: SqlClient,
  tenantId: string,
  occurredAt: Date,
  correlationId: string,
  processId: string,
  event: { readonly definition: AnyDomainEventDefinition; readonly payload: unknown },
): Promise<string> {
  const resolved = event.definition.resolve(event.payload);
  const eventId = uuidv7();
  await client.query(
    `INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, event_version,
       aggregate_type, aggregate_id, process_id, payload, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8::jsonb, $9::jsonb, $10)`,
    [
      eventId,
      tenantId,
      resolved.eventType,
      resolved.routingKey,
      resolved.eventVersion,
      resolved.aggregateType,
      processId,
      JSON.stringify(resolved.payload),
      JSON.stringify({
        actor: SYSTEM_ACTOR,
        correlationId: correlationId.slice(0, 64),
        causationId: null,
      }),
      occurredAt,
    ],
  );
  return eventId;
}

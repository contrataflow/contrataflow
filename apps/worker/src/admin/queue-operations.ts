import { redact, uuidv7 } from '@contrataflow/observability';
import { DEAD_LETTER_QUEUE, isRegisteredJob } from '@contrataflow/types';
import type { DeadLetterRecord, QueueName } from '@contrataflow/types';
import type { Queue } from 'bullmq';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { OperatorIdentity } from './operator-authenticator.js';
import type { QueueAuditPort } from './platform-audit.js';
import { DEFAULT_JOB_OPTIONS } from '../queues/queue-options.js';

/*
 * Operações auditadas sobre filas (FA-04 · queues.md §5.6/§11.2): listar/detalhar a dead-letter,
 * reprocessar (`dead_letter.retry`) ou descartar (`dead_letter.discard`) um job e republicar um
 * evento `FAILED` do outbox (`outbox.republish`). Só a CLI muta — o Bull Board é somente leitura.
 * Toda mutação exige ticket e motivo e grava auditoria com `actorType = PLATFORM_OPERATOR`.
 */

export class QueueOperationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'QueueOperationError';
  }
}

export interface Justification {
  readonly ticket: string;
  readonly reason: string;
}

export interface QueueOperationsDeps {
  readonly queue: (name: QueueName) => Pick<Queue, 'getJob' | 'getJobs' | 'add'>;
  readonly audit: QueueAuditPort;
  readonly operator: OperatorIdentity;
  /** Transação no papel `cf_relay` (republicação do outbox); ausente = comando indisponível. */
  readonly outboxTransaction?: <T>(work: (client: SqlClient) => Promise<T>) => Promise<T>;
}

export interface DeadLetterFilter {
  readonly queue?: string;
  readonly tenantId?: string;
  /** Só falhas a partir deste instante. */
  readonly since?: Date;
  readonly limit?: number;
}

export interface DeadLetterSummary {
  readonly id: string;
  readonly queue: string;
  readonly jobName: string;
  readonly tenantId: string | null;
  readonly errorClass: string;
  readonly errorName: string;
  readonly attempts: number;
  readonly failedAt: string;
}

function requireJustification(justification: Justification): void {
  if (justification.ticket.trim().length < 2 || justification.reason.trim().length < 5) {
    throw new QueueOperationError(
      'INVALID_ARGUMENT',
      'Informe --ticket e --reason (mín. 5 caracteres).',
    );
  }
}

function summaryOf(id: string, record: DeadLetterRecord): DeadLetterSummary {
  return {
    id,
    queue: record.source.queue,
    jobName: record.source.jobName,
    tenantId: record.meta?.tenantId ?? null,
    errorClass: record.error.class,
    errorName: record.error.name,
    attempts: record.source.attemptsMade,
    failedAt: record.source.failedAt,
  };
}

export class QueueOperations {
  constructor(private readonly deps: QueueOperationsDeps) {}

  async listDeadLetters(filter: DeadLetterFilter = {}): Promise<DeadLetterSummary[]> {
    const jobs = await this.deps
      .queue(DEAD_LETTER_QUEUE)
      .getJobs(['waiting', 'paused'], 0, (filter.limit ?? 100) - 1);
    const since = filter.since?.getTime();
    return jobs
      .map((job) => summaryOf(job.id ?? '', job.data as DeadLetterRecord))
      .filter(
        (summary) =>
          (filter.queue === undefined || summary.queue === filter.queue) &&
          (filter.tenantId === undefined || summary.tenantId === filter.tenantId) &&
          (since === undefined || Date.parse(summary.failedAt) >= since),
      );
  }

  /**
   * Reprocessamento em massa após incidente (`dlq:retry --queue --since`): com `dryRun`, só lista o
   * que seria reenfileirado; cada job reprocessado gera a sua auditoria `dead_letter.retry`.
   */
  async retryDeadLetters(
    filter: DeadLetterFilter & { readonly queue: string; readonly since: Date },
    justification: Justification,
    dryRun: boolean,
  ): Promise<{ readonly dryRun: boolean; readonly ids: readonly string[] }> {
    requireJustification(justification);
    const ids = (await this.listDeadLetters({ ...filter, limit: filter.limit ?? 1_000 })).map(
      (summary) => summary.id,
    );
    if (!dryRun) for (const id of ids) await this.retryDeadLetter(id, justification);
    return { dryRun, ids };
  }

  /** Detalhe com redação de campos sensíveis (queues.md §11.2). */
  async showDeadLetter(id: string): Promise<unknown> {
    const record = await this.recordOf(id);
    return redact({ id, ...record });
  }

  /**
   * Reenfileira os dados originais na fila de origem com `jobId = <jobIdOriginal>.r<n>` (contorna a
   * deduplicação do BullMQ), preservando o `meta`; a cópia sai da dead-letter.
   */
  async retryDeadLetter(id: string, justification: Justification): Promise<string> {
    requireJustification(justification);
    const job = await this.deps.queue(DEAD_LETTER_QUEUE).getJob(id);
    if (!job) throw new QueueOperationError('NOT_FOUND', `Job ${id} não está na dead-letter`);
    const record = job.data as DeadLetterRecord;
    const { queue, jobName, jobId } = record.source;
    if (!isRegisteredJob(queue, jobName)) {
      throw new QueueOperationError('CONFLICT', `Job ${queue}/${jobName} fora do registro`);
    }
    const target = this.deps.queue(queue as QueueName);
    let attempt = 1;
    while (await target.getJob(`${jobId}.r${String(attempt)}`)) attempt += 1;
    const newJobId = `${jobId}.r${String(attempt)}`;
    await target.add(jobName, record.data, { ...DEFAULT_JOB_OPTIONS, jobId: newJobId });
    await job.remove();
    await this.audit('dead_letter.retry', record, justification, { retriedJobId: newJobId, id });
    return newJobId;
  }

  async discardDeadLetter(id: string, justification: Justification): Promise<void> {
    requireJustification(justification);
    const job = await this.deps.queue(DEAD_LETTER_QUEUE).getJob(id);
    if (!job) throw new QueueOperationError('NOT_FOUND', `Job ${id} não está na dead-letter`);
    const record = job.data as DeadLetterRecord;
    await job.remove();
    await this.audit('dead_letter.discard', record, justification, { id });
  }

  /** Evento `FAILED` corrigido volta a `PENDING` para o relay (queues.md §5.6). */
  async republishOutboxEvent(eventId: string, justification: Justification): Promise<void> {
    requireJustification(justification);
    const transaction = this.deps.outboxTransaction;
    if (!transaction) {
      throw new QueueOperationError('INVALID_ARGUMENT', 'DATABASE_URL_RELAY não configurado');
    }
    const rows = await transaction(async (client) => {
      const result = await client.query<{ tenant_id: string | null; event_type: string }>(
        `UPDATE outbox_events
            SET status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = NULL
          WHERE id = $1 AND status = 'FAILED'
          RETURNING tenant_id, event_type`,
        [eventId],
      );
      return result.rows;
    });
    const row = rows[0];
    if (!row) {
      throw new QueueOperationError('NOT_FOUND', `Evento ${eventId} inexistente ou não FAILED`);
    }
    await this.deps.audit.record({
      action: 'outbox.republish',
      result: 'SUCCESS',
      actorUserId: this.deps.operator.userId,
      actorName: this.deps.operator.name,
      tenantId: row.tenant_id,
      entityId: eventId,
      metadata: {
        actorType: 'PLATFORM_OPERATOR',
        eventType: row.event_type,
        ticket: justification.ticket,
        reason: justification.reason,
      },
      correlationId: uuidv7(),
    });
  }

  private async recordOf(id: string): Promise<DeadLetterRecord> {
    const job = await this.deps.queue(DEAD_LETTER_QUEUE).getJob(id);
    if (!job) throw new QueueOperationError('NOT_FOUND', `Job ${id} não está na dead-letter`);
    return job.data as DeadLetterRecord;
  }

  private async audit(
    action: 'dead_letter.retry' | 'dead_letter.discard',
    record: DeadLetterRecord,
    justification: Justification,
    extra: Record<string, string>,
  ): Promise<void> {
    await this.deps.audit.record({
      action,
      result: 'SUCCESS',
      actorUserId: this.deps.operator.userId,
      actorName: this.deps.operator.name,
      tenantId: record.meta?.tenantId ?? null,
      metadata: {
        actorType: 'PLATFORM_OPERATOR',
        sourceQueue: record.source.queue,
        sourceJobName: record.source.jobName,
        sourceJobId: record.source.jobId,
        errorClass: record.error.class,
        ticket: justification.ticket,
        reason: justification.reason,
        ...extra,
      },
      correlationId: record.meta?.correlationId ?? uuidv7(),
    });
  }
}

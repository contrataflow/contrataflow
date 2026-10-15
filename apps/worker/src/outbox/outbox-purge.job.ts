import { z } from 'zod';

import type { OutboxDatabase } from '#shared/database/outbox-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';

import { purgePublishedOutboxEvents } from './outbox-purge.js';
import type { HandlerResult, JobHandler, JobHandlerContext } from '../queues/run-job.js';

/**
 * `maintenance.outbox-purge` (US-083 · DEC-085 · queues.md §4.8): job de plataforma enfileirado
 * pela manutenção diária; apaga os eventos `PUBLISHED` há mais de 7 dias com o papel
 * `cf_maintenance`, sob trava consultiva própria (sem sobreposição entre réplicas).
 */
export class OutboxPurgeJob implements JobHandler<Record<string, never>> {
  readonly queue = 'maintenance' as const;
  readonly name = 'outbox-purge';
  readonly payloadSchema = z.strictObject({});

  constructor(
    private readonly maintenance: OutboxDatabase,
    private readonly locks: Pick<WorkerDatabase, 'withAdvisoryLock'>,
    private readonly purge: typeof purgePublishedOutboxEvents = purgePublishedOutboxEvents,
  ) {}

  async handle(
    _payload: Record<string, never>,
    context: JobHandlerContext,
  ): Promise<HandlerResult> {
    const { acquired, result } = await this.locks.withAdvisoryLock(
      'cf:maintenance:outbox-purge',
      () => this.purge(this.maintenance),
    );
    if (!acquired) return 'skipped';
    context.logger.log({ event: 'outbox.purged', deleted: result ?? 0 });
    return 'completed';
  }
}

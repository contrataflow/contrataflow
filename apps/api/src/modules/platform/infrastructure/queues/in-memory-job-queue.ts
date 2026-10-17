import type { JobData, QueueName } from '@contrataflow/types';

import type { EnqueueJobOptions, JobQueuePort } from '#shared/jobs/job-queue.js';
import { buildJobMeta } from '#shared/jobs/tenant-job.js';

/** Job aceito pela fila em memória (deduplicado por `jobId`, como no BullMQ). */
export interface InMemoryQueuedJob {
  readonly queue: QueueName;
  readonly name: string;
  readonly jobId: string;
  readonly data: JobData<unknown>;
  readonly options: EnqueueJobOptions;
}

/**
 * Fila em memória (modo de identidade fake e testes): mesmo contrato do adaptador BullMQ — `meta`
 * do contexto e deduplicação por `jobId`. `down` simula o Redis de filas fora (FA-05).
 */
export class InMemoryJobQueue implements JobQueuePort {
  private readonly jobs = new Map<string, InMemoryQueuedJob>();
  down = false;

  async enqueue(
    queue: QueueName,
    name: string,
    payload: unknown,
    options: EnqueueJobOptions,
  ): Promise<void> {
    if (this.down) throw new Error('Redis de filas indisponível');
    const key = `${queue}:${options.jobId}`;
    if (this.jobs.has(key)) return;
    const meta = await buildJobMeta(queue, name);
    this.jobs.set(key, { queue, name, jobId: options.jobId, data: { meta, payload }, options });
  }

  /** Testes: os jobs aceitos, na ordem. */
  all(): InMemoryQueuedJob[] {
    return [...this.jobs.values()];
  }

  find(queue: QueueName, jobId: string): InMemoryQueuedJob | undefined {
    return this.jobs.get(`${queue}:${jobId}`);
  }
}

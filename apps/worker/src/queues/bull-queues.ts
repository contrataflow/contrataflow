import { DEAD_LETTER_QUEUE, QUEUE_NAMES } from '@contrataflow/types';
import type { DeadLetterRecord, JobData, QueueName } from '@contrataflow/types';
import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';

import { DEAD_LETTER_JOB } from './dead-letter.js';
import type { DeadLetterSink } from './dead-letter.js';
import type { QueueAddPort } from './job-producer.js';
import { DEAD_LETTER_JOB_OPTIONS, producerConnection, queuePrefix } from './queue-options.js';
import type { SchedulerDefinition, SchedulerSuccessSource } from './schedulers.js';

/*
 * As `Queue`s BullMQ do worker (uma por fila do MVP 1, criadas sob demanda): enfileiramento do
 * `JobProducer`, cópias na `dead-letter`, schedulers e as leituras do painel e dos coletores.
 */
export class BullQueues implements QueueAddPort, DeadLetterSink, SchedulerSuccessSource {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly options: { readonly redisUrl: string; readonly appEnv: string }) {}

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: producerConnection(this.options.redisUrl),
        prefix: queuePrefix(this.options.appEnv),
      });
      queue.on('error', () => undefined);
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Todas as filas do MVP 1 (painel). */
  all(): Queue[] {
    return QUEUE_NAMES.map((name) => this.queue(name));
  }

  async add(
    queue: QueueName,
    name: string,
    data: JobData<unknown>,
    opts: JobsOptions,
  ): Promise<void> {
    await this.queue(queue).add(name, data, opts);
  }

  async park(jobId: string, record: DeadLetterRecord): Promise<void> {
    // `jobId` repetido é descartado pelo BullMQ: gravar de novo após uma queda é inócuo.
    await this.queue(DEAD_LETTER_QUEUE).add(DEAD_LETTER_JOB, record, {
      ...DEAD_LETTER_JOB_OPTIONS,
      jobId,
    });
  }

  /** Execução concluída mais recente (não `skipped`) do job do scheduler. */
  async lastSuccess(definition: SchedulerDefinition): Promise<Date | null> {
    const jobs = await this.queue(definition.queue).getJobs(['completed'], 0, 99);
    let latest: number | null = null;
    for (const job of jobs) {
      if (job.name !== definition.jobName || job.returnvalue !== 'completed') continue;
      if (job.finishedOn !== undefined && (latest === null || job.finishedOn > latest)) {
        latest = job.finishedOn;
      }
    }
    return latest === null ? null : new Date(latest);
  }

  /** Jobs estacionados na `dead-letter`, por fila de origem (gauge `cf_dead_letter_jobs`). */
  async deadLetterCounts(limit = 1_000): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const jobs = await this.queue(DEAD_LETTER_QUEUE).getJobs(['waiting', 'paused'], 0, limit - 1);
    for (const job of jobs) {
      const source =
        (job.data as Partial<DeadLetterRecord> | undefined)?.source?.queue ?? 'unknown';
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    return counts;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

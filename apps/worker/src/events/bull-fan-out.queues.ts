import { Queue } from 'bullmq';

import type { FanOutJob, FanOutQueues } from './domain-events.processor.js';
import type { FanOutQueue } from './routes.js';
import { DEFAULT_JOB_OPTIONS, producerConnection, queuePrefix } from '../queues/queue-options.js';

/** Nome do job nas filas consumidoras alimentadas pelo fan-out. */
export const FAN_OUT_JOB = 'event';

/** Filas consumidoras do fan-out em BullMQ (uma `Queue` por destino, criada sob demanda). */
export class BullFanOutQueues implements FanOutQueues {
  private readonly queues = new Map<FanOutQueue, Queue>();

  constructor(private readonly options: { readonly redisUrl: string; readonly appEnv: string }) {}

  async add(queue: FanOutQueue, job: FanOutJob): Promise<void> {
    await this.queueOf(queue).add(FAN_OUT_JOB, job.data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: job.jobId,
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }

  private queueOf(name: FanOutQueue): Queue {
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
}

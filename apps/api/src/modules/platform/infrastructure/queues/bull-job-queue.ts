import type { QueueName } from '@contrataflow/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import type { EnqueueJobOptions, JobQueuePort } from '#shared/jobs/job-queue.js';
import { buildJobMeta } from '#shared/jobs/tenant-job.js';

/*
 * Produtor BullMQ da API (padrão B — DEC-163 · queues.md §1.2/§2): mesmas convenções do worker —
 * prefixo `cf:{env}:q`, backoff `cf-exponential-jitter` (estratégia registrada nos `Worker`s),
 * retenção de 24 h/7 d — e conexão sem fila offline (falha rápido com o Redis fora; o chamador
 * mantém a linha pendente para o reconciliador). Uma `Queue` por fila, criada sob demanda, no
 * Redis principal (o mesmo `REDIS_URL` das filas do worker).
 */

const ADD_TIMEOUT_MS = 2_000;

@Injectable()
export class BullJobQueue implements JobQueuePort, OnModuleDestroy {
  private readonly logger = new Logger('BullJobQueue');
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async enqueue(
    queue: QueueName,
    name: string,
    payload: unknown,
    options: EnqueueJobOptions,
  ): Promise<void> {
    const meta = await buildJobMeta(queue, name);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Fila ${queue} sem resposta em ${String(ADD_TIMEOUT_MS)} ms`));
      }, ADD_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        this.queue(queue).add(
          name,
          { meta, payload },
          {
            jobId: options.jobId,
            attempts: options.attempts ?? 5,
            backoff: { type: 'cf-exponential-jitter', delay: options.backoffMs ?? 5_000 },
            removeOnComplete: { age: 24 * 3_600 },
            removeOnFail: { age: 7 * 24 * 3_600 },
          },
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        prefix: `cf:${this.config.appEnv}:q`,
        connection: {
          url: this.config.redis.cacheUrl,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 2_000,
          retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
        },
      });
      queue.on('error', (error: Error) => {
        this.logger.warn({ event: 'queue.producer_error', queue: name, cause: error.name });
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}

import { isRegisteredJob } from '@contrataflow/types';
import type { QueueName } from '@contrataflow/types';

import type { JobHandler } from './run-job.js';

/*
 * Handlers de fila registrados neste worker (DEC-052): os módulos donos registram os seus no
 * bootstrap (`onModuleInit`); o `QueueRuntime` sobe um `Worker` BullMQ por fila com handler. Nome
 * fora de `QUEUE_JOBS` é recusado aqui (V-03) — e um teste percorre o registro de produção.
 */

/** Fila ou job de handler fora do registro de `packages/types` (erro de programação). */
export class UnregisteredJobError extends Error {
  constructor(queue: string, name: string) {
    super(`Handler ${queue}/${name} fora do registro QUEUE_JOBS`);
    this.name = 'UnregisteredJobError';
  }
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler<never>>();

  register<P>(handler: JobHandler<P>): this {
    if (!isRegisteredJob(handler.queue, handler.name)) {
      throw new UnregisteredJobError(handler.queue, handler.name);
    }
    const key = `${handler.queue}/${handler.name}`;
    if (this.handlers.has(key)) throw new Error(`Handler ${key} registrado duas vezes`);
    this.handlers.set(key, handler as unknown as JobHandler<never>);
    return this;
  }

  get(queue: string, name: string): JobHandler<never> | undefined {
    return this.handlers.get(`${queue}/${name}`);
  }

  isHandled(queue: QueueName, name: string): boolean {
    return this.handlers.has(`${queue}/${name}`);
  }

  /** Filas com ao menos um handler (as que ganham `Worker`). */
  queues(): QueueName[] {
    return [...new Set([...this.handlers.values()].map((handler) => handler.queue))];
  }

  all(): JobHandler<never>[] {
    return [...this.handlers.values()];
  }
}

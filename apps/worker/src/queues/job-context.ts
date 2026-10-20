import { AsyncLocalStorage } from 'node:async_hooks';

import type { JobMeta } from '@contrataflow/types';

/*
 * Contexto do job em execução (DEC-164 · queues.md §9.2, passo 4): aberto pelo `runJob` e lido
 * pelo `JobProducer`, que deriva o `meta` dos jobs filhos (tenant, ator, correlação, causa) sem
 * que o handler o monte à mão.
 */

export interface ActiveJob {
  readonly meta: JobMeta;
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
}

const storage = new AsyncLocalStorage<ActiveJob>();

export function currentJob(): ActiveJob | undefined {
  return storage.getStore();
}

export function runWithJob<T>(job: ActiveJob, fn: () => T): T {
  return storage.run(job, fn);
}

import { runInJobContext } from '@contrataflow/observability';
import type { JobTraceMeta } from '@contrataflow/observability';
import { Injectable, Logger } from '@nestjs/common';

/** Fila e job de teste da propagação de trace (US-084); o mesmo par da rota interna da API. */
export const TRACE_DEMO_QUEUE = 'platform-demo';
export const TRACE_DEMO_JOB = 'trace-demo';

export interface TraceDemoJob {
  readonly jobId: string;
  /** Tentativa atual, começando em 1. */
  readonly attempt: number;
  readonly meta: JobTraceMeta;
}

/**
 * Job de teste instrumentado (padrão de referência para os processors da US-083): roda no span
 * `platform-demo process`, filho do `traceparent` do `JobMeta`, e loga `job.completed` com o mesmo
 * `correlationId` da requisição de origem. O consumo pela fila BullMQ chega com a US-083.
 */
@Injectable()
export class TraceDemoJobHandler {
  private readonly logger = new Logger('TraceDemoJob');

  async process(job: TraceDemoJob): Promise<void> {
    const startedAt = performance.now();
    await runInJobContext(
      { queue: TRACE_DEMO_QUEUE, jobName: TRACE_DEMO_JOB, jobId: job.jobId, attempt: job.attempt },
      job.meta,
      () => {
        this.logger.log(
          {
            event: 'job.completed',
            durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          },
          'job completed',
        );
      },
    );
  }
}

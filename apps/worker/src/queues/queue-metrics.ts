import { metrics } from '@opentelemetry/api';

import type { JobErrorClass } from './job-errors.js';

/*
 * Métricas das filas (RN-FND-70 · queues.md §15.2) pela API do OpenTelemetry — sem provedor de
 * métricas registrado (até a US-085, que expõe `/metrics`), as chamadas são no-op. Rótulos só de
 * baixa cardinalidade: nunca `tenantId` nem `jobId`.
 */

export type JobOutcome = 'completed' | 'failed' | 'retried' | 'skipped' | 'delayed';

export interface QueueMetrics {
  jobProcessed(queue: string, jobName: string, outcome: JobOutcome, durationMs: number): void;
  jobWaited(queue: string, waitMs: number): void;
  jobRetried(queue: string, errorClass: JobErrorClass): void;
  scheduledJobSkipped(scheduler: string): void;
  schedulerSucceeded(scheduler: string, at: Date): void;
  deadLetterJobs(bySourceQueue: ReadonlyMap<string, number>): void;
  circuitState(dependency: string, value: number): void;
}

/** Valores observados pelos gauges assíncronos (última leitura). */
const gauges = {
  deadLetter: new Map<string, number>(),
  schedulerSuccess: new Map<string, number>(),
  circuit: new Map<string, number>(),
};

let registered: QueueMetrics | undefined;

/** Implementação OpenTelemetry (uma por processo — instrumentos e gauges registrados uma vez). */
export function otelQueueMetrics(): QueueMetrics {
  if (registered) return registered;
  const meter = metrics.getMeter('contrataflow-worker');
  const processed = meter.createCounter('cf_jobs_processed_total', {
    description: 'Jobs processados, por fila, nome e resultado.',
  });
  const retries = meter.createCounter('cf_job_retries_total', {
    description: 'Novas tentativas agendadas, por fila e classe do erro.',
  });
  const duration = meter.createHistogram('cf_job_duration_seconds', {
    description: 'Duração da execução do handler.',
    unit: 's',
  });
  const wait = meter.createHistogram('cf_job_wait_seconds', {
    description: 'Espera na fila (processedOn − timestamp).',
    unit: 's',
  });
  const skipped = meter.createCounter('cf_scheduled_job_skipped_total', {
    description: 'Execuções agendadas que não obtiveram a trava (outra réplica executando).',
  });
  meter
    .createObservableGauge('cf_dead_letter_jobs', {
      description: 'Jobs estacionados na dead-letter, por fila de origem (alerta: > 0).',
    })
    .addCallback((result) => {
      for (const [source, count] of gauges.deadLetter)
        result.observe(count, { source_queue: source });
    });
  meter
    .createObservableGauge('cf_scheduler_last_success_timestamp_seconds', {
      description: 'Último sucesso de cada scheduler (epoch, s).',
    })
    .addCallback((result) => {
      for (const [scheduler, at] of gauges.schedulerSuccess) result.observe(at, { scheduler });
    });
  meter
    .createObservableGauge('cf_circuit_breaker_state', {
      description: 'Estado do breaker por dependência (0 fechado, 1 meia-aberto, 2 aberto).',
    })
    .addCallback((result) => {
      for (const [dependency, value] of gauges.circuit) result.observe(value, { dependency });
    });

  registered = {
    jobProcessed(queue, jobName, outcome, durationMs) {
      processed.add(1, { queue, job_name: jobName, outcome });
      duration.record(durationMs / 1_000, { queue, job_name: jobName, outcome });
    },
    jobWaited(queue, waitMs) {
      wait.record(Math.max(0, waitMs) / 1_000, { queue });
    },
    jobRetried(queue, errorClass) {
      retries.add(1, { queue, error_class: errorClass });
    },
    scheduledJobSkipped(scheduler) {
      skipped.add(1, { scheduler });
    },
    schedulerSucceeded(scheduler, at) {
      gauges.schedulerSuccess.set(scheduler, Math.floor(at.getTime() / 1_000));
    },
    deadLetterJobs(bySourceQueue) {
      gauges.deadLetter.clear();
      for (const [source, count] of bySourceQueue) gauges.deadLetter.set(source, count);
    },
    circuitState(dependency, value) {
      gauges.circuit.set(dependency, value);
    },
  };
  return registered;
}

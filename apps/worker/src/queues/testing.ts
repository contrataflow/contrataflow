import type { DeadLetterRecord } from '@contrataflow/types';

import type { DeadLetterSink } from './dead-letter.js';
import type { JobErrorClass } from './job-errors.js';
import type { JobOutcome, QueueMetrics } from './queue-metrics.js';

/* Fakes das portas das filas para testes unitários e de integração (sem Redis nem OTel). */

export class RecordingQueueMetrics implements QueueMetrics {
  readonly processed: { queue: string; jobName: string; outcome: JobOutcome }[] = [];
  readonly retries: { queue: string; errorClass: JobErrorClass }[] = [];
  readonly skipped: string[] = [];
  readonly schedulerSuccess = new Map<string, Date>();
  readonly circuit = new Map<string, number>();
  readonly waits: number[] = [];
  deadLetter = new Map<string, number>();

  jobProcessed(queue: string, jobName: string, outcome: JobOutcome): void {
    this.processed.push({ queue, jobName, outcome });
  }

  jobWaited(_queue: string, waitMs: number): void {
    this.waits.push(waitMs);
  }

  jobRetried(queue: string, errorClass: JobErrorClass): void {
    this.retries.push({ queue, errorClass });
  }

  scheduledJobSkipped(scheduler: string): void {
    this.skipped.push(scheduler);
  }

  schedulerSucceeded(scheduler: string, at: Date): void {
    this.schedulerSuccess.set(scheduler, at);
  }

  deadLetterJobs(bySourceQueue: ReadonlyMap<string, number>): void {
    this.deadLetter = new Map(bySourceQueue);
  }

  circuitState(dependency: string, value: number): void {
    this.circuit.set(dependency, value);
  }

  outcomes(queue: string): JobOutcome[] {
    return this.processed.filter((entry) => entry.queue === queue).map((entry) => entry.outcome);
  }
}

/** Dead-letter em memória, idempotente pelo `jobId` como a fila BullMQ. */
export class MemoryDeadLetter implements DeadLetterSink {
  readonly records = new Map<string, DeadLetterRecord>();
  /** Ordem das chamadas (para provar a gravação antes de relançar). */
  readonly calls: string[] = [];

  park(jobId: string, record: DeadLetterRecord): Promise<void> {
    this.calls.push(jobId);
    if (!this.records.has(jobId)) this.records.set(jobId, record);
    return Promise.resolve();
  }
}

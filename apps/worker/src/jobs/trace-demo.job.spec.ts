import { injectTraceCarrier, tracer, uuidv7 } from '@contrataflow/observability';
import { captureLogs, installTestTracing } from '@contrataflow/observability/testing';
import type { TestTracing } from '@contrataflow/observability/testing';
import { Logger } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import { __resetOutOfContextForTests } from 'nestjs-pino/PinoLogger.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRACE_DEMO_JOB, TRACE_DEMO_QUEUE, TraceDemoJobHandler } from './trace-demo.job.js';
import { startWorker } from '../bootstrap.js';
import type { ShutdownProcess } from '../graceful-shutdown.js';
import { createWorkerLogger } from '../observability/worker-logger.js';

const TENANT = '0192a000-0000-7000-8000-00000000000a';

class FakeProcess implements ShutdownProcess {
  readonly listeners = new Map<string, () => void>();
  exitCode: number | string | null | undefined = undefined;
  readonly exit = vi.fn<(code: number) => void>();

  once(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  emit(event: string): void {
    this.listeners.get(event)?.();
  }
}

describe('job de teste instrumentado (US-084 — cenário "Falha de integração")', () => {
  let tracing: TestTracing;

  beforeEach(() => {
    tracing = installTestTracing();
    // O nestjs-pino guarda o logger de fora de contexto no primeiro uso do processo.
    __resetOutOfContextForTests();
  });
  afterEach(async () => {
    Logger.overrideLogger(false);
    await tracing.shutdown();
  });

  it('o log do job tem o correlationId da requisição e o span é filho do trace dela', async () => {
    const logs = captureLogs();
    const proc = new FakeProcess();
    const { context, stopped } = await startWorker({
      proc,
      rootLogger: createWorkerLogger(
        { environment: 'test', version: '1.4.2+g3f9c2ab', logLevel: 'info' },
        logs.destination,
      ),
    });

    // Lado API: a requisição grava correlationId e traceparent no JobMeta.
    const { carrier, requestTraceId, requestSpanId } = tracer().startActiveSpan(
      'POST /jobs',
      (span) => {
        const captured = injectTraceCarrier();
        span.end();
        return {
          carrier: captured,
          requestTraceId: span.spanContext().traceId,
          requestSpanId: span.spanContext().spanId,
        };
      },
    );
    const jobId = uuidv7();
    await context.get(TraceDemoJobHandler).process({
      jobId,
      attempt: 2,
      meta: { correlationId: 'corr-req-0001', tenantId: TENANT, ...carrier },
    });

    const job = logs.lines().find((line) => line.event === 'job.completed');
    const consumer = tracing.spans().find((span) => span.name === `${TRACE_DEMO_QUEUE} process`);
    expect(consumer?.kind).toBe(SpanKind.CONSUMER);
    expect(consumer?.spanContext().traceId).toBe(requestTraceId);
    expect(consumer?.parentSpanContext?.spanId).toBe(requestSpanId);
    expect(job).toMatchObject({
      level: 'info',
      service: 'worker',
      env: 'test',
      version: '1.4.2+g3f9c2ab',
      context: 'TraceDemoJob',
      msg: 'job completed',
      correlationId: 'corr-req-0001',
      tenantId: TENANT,
      queue: TRACE_DEMO_QUEUE,
      jobName: TRACE_DEMO_JOB,
      jobId,
      attempt: 2,
      traceId: requestTraceId,
      spanId: consumer?.spanContext().spanId,
    });
    expect(typeof job?.durationMs).toBe('number');

    // Fora do job, as linhas não carregam o contexto dele.
    expect(logs.lines().find((line) => line.event === 'worker.started')).not.toHaveProperty(
      'correlationId',
    );
    proc.emit('SIGTERM');
    await stopped;
  });

  it('JobMeta sem traceparent vira trace novo, sem erro', async () => {
    await new TraceDemoJobHandler().process({
      jobId: uuidv7(),
      attempt: 1,
      meta: { correlationId: 'corr-sem-trace', tenantId: null },
    });
    const [consumer] = tracing.spans();
    expect(consumer?.parentSpanContext).toBeUndefined();
  });
});

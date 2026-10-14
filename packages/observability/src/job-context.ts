import { AsyncLocalStorage } from 'node:async_hooks';

import { SpanKind } from '@opentelemetry/api';

import type { LogContextFields } from './logger.js';
import { extractTraceContext, injectTraceCarrier, withSpan } from './tracing.js';
import type { SpanAttributeInput, TraceCarrier } from './tracing.js';

/*
 * Propagação HTTP → job (RN-FND-74/76 · DEC-164 · queues.md §3/§9): o produtor grava
 * `correlationId` e `traceparent` no `JobMeta`; o consumidor abre o span `<fila> process` como
 * filho desse contexto e loga com o mesmo `correlationId`. O outbox (US-082) e o `JobProducer`/
 * `runJob` (US-083) usam estes helpers em vez de montar o contexto à mão.
 */

/** Campos de rastreio do `JobMeta` (DEC-164) — o restante do `JobMeta` é da US-083. */
export interface JobTraceMeta extends TraceCarrier {
  readonly correlationId: string;
  readonly tenantId: string | null;
  readonly causationId?: string | null;
}

export interface JobDescriptor {
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
  /** Tentativa atual, começando em 1. */
  readonly attempt: number;
}

const storage = new AsyncLocalStorage<LogContextFields>();

/** Campos de log do job em execução (`undefined` fora de um job). */
export function currentJobLogFields(): LogContextFields | undefined {
  return storage.getStore();
}

/**
 * Lado produtor: abre o span `PRODUCER` `<fila> publish` e devolve o `JobTraceMeta` cujo
 * `traceparent` aponta para ele (o job vira filho da requisição que o disparou).
 */
export async function captureJobTraceMeta(
  queue: string,
  origin: { readonly correlationId: string; readonly tenantId: string | null },
  attributes: SpanAttributeInput = {},
): Promise<JobTraceMeta> {
  return withSpan(
    `${queue} publish`,
    { 'messaging.destination.name': queue, 'messaging.operation.type': 'publish', ...attributes },
    () => ({
      correlationId: origin.correlationId,
      tenantId: origin.tenantId,
      causationId: null,
      ...injectTraceCarrier(),
    }),
    { kind: SpanKind.PRODUCER },
  );
}

/**
 * Lado consumidor: executa `fn` no span `CONSUMER` `<fila> process`, filho do `traceparent` do
 * `JobMeta`, com `correlationId`/`tenantId`/`queue`/`jobName`/`jobId`/`attempt` em todo log.
 */
export async function runInJobContext<T>(
  job: JobDescriptor,
  meta: JobTraceMeta,
  fn: () => T | Promise<T>,
): Promise<T> {
  const fields: LogContextFields = {
    correlationId: meta.correlationId,
    tenantId: meta.tenantId,
    queue: job.queue,
    jobName: job.jobName,
    jobId: job.jobId,
    attempt: job.attempt,
  };
  return storage.run(fields, () =>
    withSpan(
      `${job.queue} process`,
      {
        'messaging.destination.name': job.queue,
        'messaging.operation.type': 'process',
        'messaging.message.id': job.jobId,
        'cf.job.name': job.jobName,
        'cf.job.attempt': job.attempt,
        'cf.tenant.id': meta.tenantId,
      },
      fn,
      { kind: SpanKind.CONSUMER, parent: extractTraceContext(meta) },
    ),
  );
}

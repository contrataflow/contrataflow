import { Writable } from 'node:stream';

import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

import { createSampler } from './telemetry.js';

/*
 * Apoio aos testes de web, api e worker (não usado em produção): captura das linhas do logger e
 * provedor de traces em memória com contexto por AsyncLocalStorage.
 */

export type LogLine = Readonly<Record<string, unknown>>;

export interface CapturedLogs {
  /** Destino para `createLogger({ destination })`. */
  readonly destination: Writable;
  /** Linhas já emitidas, como objetos. */
  lines(): LogLine[];
  /** Linhas cru (texto JSON), para buscas por valores proibidos. */
  raw(): string[];
  clear(): void;
}

export function captureLogs(): CapturedLogs {
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      for (const line of String(chunk).split('\n')) if (line.trim()) raw.push(line);
      callback();
    },
  });
  return {
    destination,
    lines: () => raw.map((line) => JSON.parse(line) as LogLine),
    raw: () => [...raw],
    clear: () => {
      raw.length = 0;
    },
  };
}

export interface TestTracing {
  spans(): ReadableSpan[];
  reset(): void;
  shutdown(): Promise<void>;
}

/** Registra um provedor global com exportação síncrona em memória (ou o exportador dado). */
export function installTestTracing(
  exporter: SpanExporter = new InMemorySpanExporter(),
): TestTracing {
  trace.disable();
  context.disable();
  propagation.disable();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const provider = new TracerProvider({
    sampler: createSampler(1),
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
  const memory = exporter instanceof InMemorySpanExporter ? exporter : null;
  return {
    spans: () => memory?.getFinishedSpans() ?? [],
    reset: () => memory?.reset(),
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
    },
  };
}

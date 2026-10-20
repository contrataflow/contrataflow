import { randomUUID } from 'node:crypto';

import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import type { ReadableSpan, Sampler, SpanExporter } from '@opentelemetry/sdk-trace';
import type { Logger } from 'pino';

export { ExportResultCode };
export type { NodeSDK };

/*
 * Bootstrap do OpenTelemetry Node SDK (RN-FND-75/77 · observability.md §4.1/§4.4), carregado
 * antes do código da aplicação (`node --import ./dist/otel.js` na api e no worker;
 * `instrumentation.ts` no web). Cada app escolhe as próprias instrumentações.
 */

/** Rotas fora do log automático e da instrumentação HTTP (FA-05 · reservadas à US-085). */
export function isIgnoredHttpPath(path: string | undefined): boolean {
  if (!path) return false;
  const pathname = path.split('?', 1)[0] ?? '';
  return pathname === '/metrics' || pathname === '/health' || pathname.startsWith('/health/');
}

/** Intervalo mínimo entre dois avisos `tracing.export_failed` (observability.md §2.5). */
export const EXPORT_FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * Exportador que nunca propaga a falha do Collector para a aplicação (FA-04): registra `warn`
 * `tracing.export_failed` — no máximo um por minuto, com a contagem de lotes suprimidos — e segue.
 */
export class WarnOnFailureSpanExporter implements SpanExporter {
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(
    private readonly inner: SpanExporter,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      this.inner.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) this.warn(spans.length, result.error);
        resultCallback(result);
      });
    } catch (error) {
      this.warn(spans.length, error);
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  private warn(spanCount: number, error: unknown): void {
    const now = this.now();
    if (now - this.lastWarnAt < EXPORT_FAILURE_LOG_INTERVAL_MS) {
      this.suppressed += 1;
      return;
    }
    this.lastWarnAt = now;
    const suppressed = this.suppressed;
    this.suppressed = 0;
    this.logger.warn({
      event: 'tracing.export_failed',
      spanCount,
      suppressed,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
  }
}

export interface TelemetryOptions {
  readonly serviceName: 'contrataflow-web' | 'contrataflow-api' | 'contrataflow-worker';
  readonly serviceVersion: string;
  /** `deployment.environment.name` (`APP_ENV`). */
  readonly environment: string;
  /** URL base do Collector (`OTEL_EXPORTER_OTLP_ENDPOINT`); o caminho `/v1/traces` é anexado. */
  readonly endpoint: string;
  /** Fração de traces raiz amostrados no SDK (`OTEL_TRACES_SAMPLER_ARG`); 1 = todos. */
  readonly samplerRatio: number;
  readonly instrumentations: NonNullable<NodeSDKConfiguration['instrumentations']>;
  /** Logger que recebe o aviso de falha de exportação. */
  readonly logger: Pick<Logger, 'warn'>;
  readonly region?: string;
  /** Substitui o exportador OTLP (testes). */
  readonly exporter?: SpanExporter;
}

/** `ParentBased(AlwaysOn)` por padrão; o corte real é o *tail sampling* do Collector (RN-FND-77). */
export function createSampler(ratio: number): Sampler {
  const root = ratio >= 1 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(ratio);
  return new ParentBasedSampler({ root });
}

/**
 * URL OTLP/HTTP de traces a partir do endpoint base (barras finais descartadas). Corte por índice:
 * `/\/+$/` é quadrático em muitas `/` seguidas de outro caractere (CodeQL `js/polynomial-redos`).
 */
export function otlpTracesUrl(endpoint: string): string {
  let end = endpoint.length;
  while (end > 0 && endpoint[end - 1] === '/') end -= 1;
  return `${endpoint.slice(0, end)}/v1/traces`;
}

export function createTelemetrySdk(options: TelemetryOptions): NodeSDK {
  const exporter =
    options.exporter ?? new OTLPTraceExporter({ url: otlpTracesUrl(options.endpoint) });
  return new NodeSDK({
    resource: resources.resourceFromAttributes({
      'service.name': options.serviceName,
      'service.version': options.serviceVersion,
      'deployment.environment.name': options.environment,
      'service.instance.id': randomUUID(),
      ...(options.region ? { 'cloud.region': options.region } : {}),
    }),
    // Só os atributos acima: os detectores automáticos expõem host e linha de comando.
    autoDetectResources: false,
    sampler: createSampler(options.samplerRatio),
    // W3C Trace Context sem *baggage* (observability.md §4.2).
    textMapPropagator: new W3CTraceContextPropagator(),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new WarnOnFailureSpanExporter(exporter, options.logger),
      }),
    ],
    instrumentations: options.instrumentations,
  });
}

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

import { metrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { createDenyListAttributesProcessor, MeterProvider } from '@opentelemetry/sdk-metrics';
import { resources } from '@opentelemetry/sdk-node';

import type { ReadinessProbe } from './health.js';

/*
 * Métricas (US-085 · RN-FND-82/83 · observability.md §5): OpenTelemetry Metrics SDK com leitor
 * *pull* Prometheus, servido em `/metrics` (HLT-03) SOMENTE na porta interna `METRICS_PORT` — nunca
 * na porta pública (V-03). As métricas já emitidas pelos módulos via `@opentelemetry/api`
 * (filas, outbox, auditoria, sessão…) passam a ser exportadas assim que o provedor é instalado.
 */

/** Rótulos de cardinalidade aberta, proibidos em qualquer série (RN-FND-82 · V-02). */
export const FORBIDDEN_METRIC_LABELS: readonly string[] = [
  'tenantId',
  'tenant_id',
  'cf.tenant.id',
  'userId',
  'user_id',
  'processId',
  'process_id',
  'eventId',
  'event_id',
  'jobId',
  'job_id',
  'email',
  'url.full',
  'url.path',
  'http.target',
  'path',
];

/** Normaliza para comparar com os nomes já sanitizados pelo Prometheus (`tenant_id`, `tenantid`). */
function normalizedLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const FORBIDDEN_NORMALIZED = new Set(FORBIDDEN_METRIC_LABELS.map(normalizedLabel));

/** Nomes de *label* proibidos encontrados num texto Prometheus (teste de cardinalidade). */
export function findForbiddenLabels(prometheusText: string): string[] {
  const found = new Set<string>();
  for (const line of prometheusText.split('\n')) {
    if (line.startsWith('#')) continue;
    const open = line.indexOf('{');
    const close = line.lastIndexOf('}');
    if (open < 0 || close < open) continue;
    for (const match of line.slice(open + 1, close).matchAll(/([A-Za-z_][A-Za-z0-9_]*)="/g)) {
      const label = match[1] ?? '';
      const normalized = normalizedLabel(label);
      if (
        FORBIDDEN_NORMALIZED.has(normalized) ||
        normalized.includes('tenant') ||
        normalized.includes('email')
      ) {
        found.add(label);
      }
    }
  }
  return [...found].sort();
}

/** Buckets de latência HTTP alinhados aos SLOs (observability.md §5.1), em segundos. */
export const HTTP_DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 0.8, 1, 1.5, 2.5, 5, 10,
];

export interface MetricsOptions {
  readonly serviceName: 'contrataflow-web' | 'contrataflow-api' | 'contrataflow-worker';
  readonly serviceVersion: string;
  readonly environment: string;
}

export interface MetricsHandle {
  readonly provider: MeterProvider;
  readonly exporter: PrometheusExporter;
  /** Responde `GET /metrics` no formato Prometheus. */
  handle(request: IncomingMessage, response: ServerResponse): void;
  shutdown(): Promise<void>;
}

const HANDLE_KEY = Symbol.for('contrataflow.metrics');
const store = globalThis as typeof globalThis & { [HANDLE_KEY]?: MetricsHandle | undefined };

/** Provedor instalado no processo (ou `undefined` sem `installMetrics`). */
export function installedMetrics(): MetricsHandle | undefined {
  return store[HANDLE_KEY];
}

/**
 * Instala o `MeterProvider` global uma vez por processo (idempotente: o `otel.ts` instala antes da
 * aplicação; o bootstrap reaproveita). Um *view* `*` descarta os rótulos proibidos de qualquer
 * instrumento, como defesa em profundidade além da revisão (V-02).
 */
export function installMetrics(options: MetricsOptions): MetricsHandle {
  const existing = store[HANDLE_KEY];
  if (existing) return existing;
  const exporter = new PrometheusExporter({ preventServerStart: true, withoutScopeInfo: true });
  const provider = new MeterProvider({
    resource: resources.resourceFromAttributes({
      'service.name': options.serviceName,
      'service.version': options.serviceVersion,
      'deployment.environment.name': options.environment,
      'service.instance.id': randomUUID(),
    }),
    readers: [exporter],
    views: [
      {
        instrumentName: '*',
        attributesProcessors: [createDenyListAttributesProcessor([...FORBIDDEN_METRIC_LABELS])],
      },
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  const meter = provider.getMeter('contrataflow-runtime');
  const stopRuntime = registerRuntimeMetrics(meter);
  registerBuildInfo(meter, options);
  const handle: MetricsHandle = {
    provider,
    exporter,
    handle: (request, response) => {
      exporter.getMetricsRequestHandler(request, response);
    },
    shutdown: async () => {
      stopRuntime();
      await provider.shutdown();
      store[HANDLE_KEY] = undefined;
      metrics.disable();
    },
  };
  store[HANDLE_KEY] = handle;
  return handle;
}

/** `cf_build_info{version}` = 1 — base das anotações de deploy dos dashboards (RN-FND-84). */
function registerBuildInfo(meter: Meter, options: MetricsOptions): void {
  meter
    .createObservableGauge('cf_build_info', {
      description: 'Versão em execução (1 por instância); muda a cada deploy.',
    })
    .addCallback((result) => {
      result.observe(1, { version: options.serviceVersion });
    });
}

/**
 * Runtime Node (USE — observability.md §5.2): atraso do *event loop* (p50/p99/máx da janela entre
 * coletas), memória residente e heap V8, CPU e duração de GC. Devolve a função que desliga os
 * observadores.
 */
export function registerRuntimeMetrics(meter: Meter): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const startTimeSeconds = Math.round(Date.now() / 1_000 - process.uptime());

  const delayP50 = meter.createObservableGauge('nodejs_eventloop_delay_p50_seconds', {
    description: 'Atraso do event loop, p50 da janela entre coletas.',
    unit: 's',
  });
  const delayP99 = meter.createObservableGauge('nodejs_eventloop_delay_p99_seconds', {
    description: 'Atraso do event loop, p99 da janela entre coletas.',
    unit: 's',
  });
  const delayMax = meter.createObservableGauge('nodejs_eventloop_delay_max_seconds', {
    description: 'Atraso máximo do event loop na janela entre coletas.',
    unit: 's',
  });
  const rss = meter.createObservableGauge('process_resident_memory_bytes', {
    description: 'Memória residente do processo.',
    unit: 'By',
  });
  const heap = meter.createObservableGauge('nodejs_heap_size_bytes', {
    description: 'Heap V8 por estado (used, total).',
    unit: 'By',
  });
  const cpu = meter.createObservableCounter('process_cpu_seconds', {
    description: 'Tempo de CPU consumido pelo processo, por modo (user, system).',
    unit: 's',
  });
  const started = meter.createObservableGauge('process_start_time_seconds', {
    description: 'Início do processo (epoch, s) — anotações de deploy/reinício.',
    unit: 's',
  });
  meter.addBatchObservableCallback(
    (result) => {
      const toSeconds = (ns: number) => (Number.isFinite(ns) ? ns / 1e9 : 0);
      result.observe(delayP50, toSeconds(histogram.percentile(50)));
      result.observe(delayP99, toSeconds(histogram.percentile(99)));
      result.observe(delayMax, toSeconds(histogram.max));
      histogram.reset();
      const memory = process.memoryUsage();
      result.observe(rss, memory.rss);
      result.observe(heap, memory.heapUsed, { state: 'used' });
      result.observe(heap, memory.heapTotal, { state: 'total' });
      const usage = process.cpuUsage();
      result.observe(cpu, usage.user / 1e6, { mode: 'user' });
      result.observe(cpu, usage.system / 1e6, { mode: 'system' });
      result.observe(started, startTimeSeconds);
    },
    [delayP50, delayP99, delayMax, rss, heap, cpu, started],
  );

  const gc = meter.createHistogram('nodejs_gc_duration_seconds', {
    description: 'Duração das pausas de GC.',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.001, 0.01, 0.1, 1, 2, 5] },
  });
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gc.record(entry.duration / 1_000);
  });
  observer.observe({ entryTypes: ['gc'] });

  return () => {
    histogram.disable();
    observer.disconnect();
  };
}

export interface MetricsServerOptions {
  readonly handle: Pick<MetricsHandle, 'handle'>;
  /** METRICS_PORT (porta interna de administração; `0` = livre, nos testes). */
  readonly port: number;
  readonly host?: string;
  /**
   * Rotas extras da porta interna (no worker, `/health/*`); devolve `true` quando respondeu.
   */
  readonly extra?: (request: IncomingMessage, response: ServerResponse) => boolean;
}

export interface RunningMetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Servidor HTTP da porta interna: `GET /metrics` (e as rotas extras); o resto é 404. */
export async function startMetricsServer(
  options: MetricsServerOptions,
): Promise<RunningMetricsServer> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?', 1)[0];
    if (path === '/metrics' && (request.method === 'GET' || request.method === 'HEAD')) {
      options.handle.handle(request, response);
      return;
    }
    if (options.extra?.(request, response)) return;
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

const STATUS_VALUE = { pass: 0, warn: 1, fail: 2 } as const;

/**
 * Readiness como métrica (base do alerta A04 e do D1): a cada coleta, `cf_health_ready` (1 = pronta
 * para tráfego/trabalho, 0 = `fail`) e `cf_health_check_status{dependency}` (0 pass, 1 warn,
 * 2 fail). Usa o resultado em cache do `/health/ready` (5 s) — no worker, sem balanceador, é o que
 * transforma o `fail` em alerta.
 */
export function observeReadiness(probe: Pick<ReadinessProbe, 'check'>): void {
  const meter = metrics.getMeter('contrataflow-health');
  const ready = meter.createObservableGauge('cf_health_ready', {
    description: 'Instância pronta (1) ou com dependência crítica indisponível (0).',
  });
  const status = meter.createObservableGauge('cf_health_check_status', {
    description: 'Estado de cada dependência no /health/ready (0 pass, 1 warn, 2 fail).',
  });
  meter.addBatchObservableCallback(
    async (result) => {
      const health = await probe.check().catch(() => null);
      result.observe(ready, health && health.status !== 'fail' ? 1 : 0);
      for (const [key, checks] of Object.entries(health?.checks ?? {})) {
        const dependency = key.split(':', 1)[0] ?? key;
        const value = checks[0] ? STATUS_VALUE[checks[0].status] : STATUS_VALUE.fail;
        result.observe(status, value, { dependency });
      }
    },
    [ready, status],
  );
}

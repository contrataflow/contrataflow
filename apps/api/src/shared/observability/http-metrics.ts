import { HTTP_DURATION_BUCKETS_SECONDS } from '@contrataflow/observability/metrics';
import { metrics } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';

/*
 * Métrica RED da API (US-085 · RN-FND-83 · observability.md §5.2):
 * `http_server_request_duration_seconds{http_request_method, http_route, http_response_status_code,
 * slo_class}` — taxa = contagem, erros = status, duração = histograma com os buckets dos SLOs. Só
 * conjuntos fechados: rota-template (nunca o caminho bruto), método, status e a classe de SLO
 * calculada pelo mapa rota → classe abaixo (base da *recording rule* `cf:slo_latency_p95`).
 */

/** Classes de SLO (observability.md §1.1/§5.2), mais `export`/`internal`/`other` fora dos SLOs. */
export type SloClass =
  | 'read'
  | 'search'
  | 'summary'
  | 'command'
  | 'write'
  | 'dashboard'
  | 'upload'
  | 'export'
  | 'internal'
  | 'other';

const UPLOAD_ROUTE = /\/(attachments(\/:[\w]+\/confirm)?|upload-version|download)$/;

/**
 * Mapa rota → classe de SLO (SLO-02..08). Comandos de transição (`/forward`, `/decide`…) e criações
 * (`POST`) contam como `command` (p95 ≤ 1 s); `PATCH`/`PUT` (inclusive autosave de seção) como
 * `write` (p95 ≤ 500 ms); `GET` com `?q=` como `search`.
 */
export function sloClassOf(method: string, route: string, hasSearchQuery: boolean): SloClass {
  if (route.startsWith('/internal/')) return 'internal';
  if (!route.startsWith('/api/v1/')) return 'other';
  const verb = method.toUpperCase();
  if (route.startsWith('/api/v1/dashboard')) return 'dashboard';
  if (route.endsWith('/export')) return 'export';
  if (UPLOAD_ROUTE.test(route) && (verb === 'POST' || route.endsWith('/download'))) return 'upload';
  if (verb === 'GET' || verb === 'HEAD') {
    if (route.endsWith('/summary')) return 'summary';
    return hasSearchQuery ? 'search' : 'read';
  }
  if (verb === 'PATCH' || verb === 'PUT') return 'write';
  if (verb === 'POST' || verb === 'DELETE') return 'command';
  return 'other';
}

let histogram: Histogram | undefined;

/** Registra a duração de uma requisição concluída (chamado no `finish` da resposta). */
export function recordHttpRequest(input: {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
  readonly hasSearchQuery: boolean;
}): void {
  histogram ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('http_server_request_duration_seconds', {
      description:
        'Duração das requisições HTTP da API, por rota-template, método, status e classe.',
      unit: 's',
      advice: { explicitBucketBoundaries: [...HTTP_DURATION_BUCKETS_SECONDS] },
    });
  histogram.record(input.durationSeconds, {
    http_request_method: input.method,
    http_route: input.route,
    http_response_status_code: String(input.statusCode),
    slo_class: sloClassOf(input.method, input.route, input.hasSearchQuery),
  });
}

/** Só para testes: descarta o instrumento criado com outro provedor. */
export function resetHttpMetricsForTests(): void {
  histogram = undefined;
}

import 'server-only';

import { HTTP_DURATION_BUCKETS_SECONDS } from '@contrataflow/observability/metrics';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas do login e da sessão (US-087/US-088 · DoD): `auth_logins_total{result}`, a latência do
 * callback (`auth_callback_duration_ms`) e as renovações de token (`auth_refresh_total{result}`),
 * pela API do OpenTelemetry — sem provedor de métricas registrado (até a US-085), as chamadas são
 * no-op. Rótulos só de baixa cardinalidade (nunca usuário/tenant). As expirações
 * (`auth_sessions_expired_total{reason}`) são contadas pela varredura da API, uma vez por sessão.
 */

let instruments:
  { readonly logins: Counter; readonly callback: Histogram; readonly refresh: Counter } | undefined;

function meter() {
  if (!instruments) {
    const web = metrics.getMeter('contrataflow-web');
    instruments = {
      logins: web.createCounter('auth_logins_total', {
        description: 'Logins por resultado (US-087).',
      }),
      callback: web.createHistogram('auth_callback_duration_ms', {
        description: 'Processamento do callback OIDC no BFF + API, sem o tempo no Authentik.',
        unit: 'ms',
      }),
      refresh: web.createCounter('auth_refresh_total', {
        description: 'Renovações do access token por resultado (US-088).',
      }),
    };
  }
  return instruments;
}

/** Resultado de um login: `SUCCESS`, `NO_MEMBERSHIP`, `USER_BLOCKED`, motivos de recusa… */
export function recordLogin(result: string, durationMs?: number): void {
  const { logins, callback } = meter();
  logins.add(1, { result });
  if (durationMs !== undefined) callback.record(durationMs, { result });
}

/** Renovação: `ok`, `invalid_grant`, `transient` ou `lock_timeout` (espera pela outra réplica). */
export function recordRefresh(result: 'ok' | 'invalid_grant' | 'transient' | 'lock_timeout'): void {
  meter().refresh.add(1, { result });
}

let http: { readonly server: Histogram; readonly client: Histogram } | undefined;

function httpInstruments() {
  if (!http) {
    const web = metrics.getMeter('contrataflow-web');
    const advice = { explicitBucketBoundaries: [...HTTP_DURATION_BUCKETS_SECONDS] };
    http = {
      server: web.createHistogram('http_server_request_duration_seconds', {
        description: 'Duração das requisições do proxy /api/v1 no BFF (US-085).',
        unit: 's',
        advice,
      }),
      client: web.createHistogram('http_client_request_duration_seconds', {
        description: 'Duração das chamadas BFF → API (latência BFF × API — D1).',
        unit: 's',
        advice,
      }),
    };
  }
  return http;
}

/**
 * Rota do proxy com cardinalidade fechada: só o primeiro segmento do recurso (`/api/v1/processes/*`)
 * — o caminho vem do navegador e nunca vira label inteiro (RN-FND-82).
 */
export function proxyRouteLabel(path: string): string {
  const resource = path.split('/')[1] ?? '';
  return /^[a-z][a-z0-9-]{0,40}$/.test(resource) ? `/api/v1/${resource}/*` : '/api/v1/other';
}

/** RED do proxy (US-085): método, rota agregada e status; `upstreamSeconds` só com resposta da API. */
export function recordProxyRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationSeconds: number;
  readonly upstreamSeconds?: number;
}): void {
  const { server, client } = httpInstruments();
  const status = String(input.status);
  server.record(input.durationSeconds, {
    http_request_method: input.method,
    http_route: proxyRouteLabel(input.path),
    http_response_status_code: status,
  });
  if (input.upstreamSeconds !== undefined) {
    client.record(input.upstreamSeconds, { http_response_status_code: status });
  }
}

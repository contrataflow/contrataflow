import 'server-only';

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

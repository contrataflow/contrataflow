import 'server-only';

import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas do login (US-087 · DoD): `auth_logins_total{result}` e a latência do callback
 * (`auth_callback_duration_ms`), pela API do OpenTelemetry — sem provedor de métricas registrado
 * (até a US-085), as chamadas são no-op. Rótulos só de baixa cardinalidade (nunca usuário/tenant).
 */

let instruments: { readonly logins: Counter; readonly callback: Histogram } | undefined;

function meter() {
  instruments ??= {
    logins: metrics
      .getMeter('contrataflow-web')
      .createCounter('auth_logins_total', { description: 'Logins por resultado (US-087).' }),
    callback: metrics.getMeter('contrataflow-web').createHistogram('auth_callback_duration_ms', {
      description: 'Processamento do callback OIDC no BFF + API, sem o tempo no Authentik.',
      unit: 'ms',
    }),
  };
  return instruments;
}

/** Resultado de um login: `SUCCESS`, `NO_MEMBERSHIP`, `USER_BLOCKED`, motivos de recusa… */
export function recordLogin(result: string, durationMs?: number): void {
  const { logins, callback } = meter();
  logins.add(1, { result });
  if (durationMs !== undefined) callback.record(durationMs, { result });
}

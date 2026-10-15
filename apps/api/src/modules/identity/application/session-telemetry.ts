import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

/*
 * Métricas da varredura de sessões (US-088 · DoD): `auth_sessions_expired_total{reason}`. Pela API
 * do OpenTelemetry: sem provedor de métricas registrado (até a US-085) as chamadas são no-op.
 * Rótulo de baixa cardinalidade (motivo de expiração); nunca usuário, instituição ou sessão.
 */

interface SessionInstruments {
  readonly expired: Counter;
}

let instruments: SessionInstruments | undefined;

export function sessionMetrics(): SessionInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    expired: meter.createCounter('auth_sessions_expired_total', {
      description:
        'Sessões expiradas (ociosidade, fim absoluto, renovação recusada) com a auditoria gravada.',
    }),
  };
  return instruments;
}

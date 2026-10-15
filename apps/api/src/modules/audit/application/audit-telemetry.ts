import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da auditoria (US-073 · DoD): `audit_recorded_total{category,result}`,
 * `audit_write_failed_total{reason}`, `audit_coalesced_total`, `audit_sampled_out_total` e a duração
 * de `AuditService.record` (meta p95 < 15 ms). Pela API do OpenTelemetry: sem provedor de métricas
 * registrado (até a US-085), as chamadas são no-op. Rótulos só de baixa cardinalidade.
 */

interface AuditInstruments {
  readonly recorded: Counter;
  readonly writeFailed: Counter;
  readonly coalesced: Counter;
  readonly sampledOut: Counter;
  readonly duration: Histogram;
}

let instruments: AuditInstruments | undefined;

export function auditMetrics(): AuditInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    recorded: meter.createCounter('audit_recorded_total', {
      description: 'Registros de auditoria gravados, por categoria e resultado (US-073).',
    }),
    writeFailed: meter.createCounter('audit_write_failed_total', {
      description: 'Falhas ao gravar auditoria (a transação de negócio é desfeita).',
    }),
    coalesced: meter.createCounter('audit_coalesced_total', {
      description: 'Chamadas coalescidas (RN-AUD-06), sem registro próprio.',
    }),
    sampledOut: meter.createCounter('audit_sampled_out_total', {
      description: 'access.denied excedentes da janela de amostragem (RN-AUD-07).',
    }),
    duration: meter.createHistogram('audit_record_duration_ms', {
      description: 'Duração de AuditService.record (mascaramento, hash e INSERT).',
      unit: 'ms',
    }),
  };
  return instruments;
}

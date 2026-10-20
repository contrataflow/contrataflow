import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas do relay (queues.md §5.7 · US-082): pela API do OpenTelemetry — sem provedor de
 * métricas registrado (até a US-085), as chamadas são no-op. Rótulos só de baixa cardinalidade
 * (`event_type` vem do registro fechado de `packages/types`).
 */

export interface OutboxInstruments {
  readonly published: Counter;
  readonly publishErrors: Counter;
  readonly failed: Counter;
  readonly lag: Histogram;
  readonly batchSize: Histogram;
  readonly batchDuration: Histogram;
}

let instruments: OutboxInstruments | undefined;

export function outboxMetrics(): OutboxInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-worker');
  instruments = {
    published: meter.createCounter('cf_outbox_published_total', {
      description: 'Eventos publicados na fila domain-events, por event_type.',
    }),
    publishErrors: meter.createCounter('cf_outbox_publish_errors_total', {
      description: 'Falhas do relay, por reason (invalid_row, cycle).',
    }),
    failed: meter.createCounter('cf_outbox_failed_total', {
      description: 'Linhas que viraram FAILED após 10 tentativas (alerta crítico).',
    }),
    lag: meter.createHistogram('cf_outbox_publish_lag_seconds', {
      description: 'published_at − occurred_at (SLO p95 < 5 s — ADR-004).',
      unit: 's',
    }),
    batchSize: meter.createHistogram('cf_outbox_batch_size', {
      description: 'Linhas por lote do relay.',
    }),
    batchDuration: meter.createHistogram('cf_outbox_batch_duration_seconds', {
      description: 'Duração do ciclo do relay (SELECT … SKIP LOCKED até o COMMIT).',
      unit: 's',
    }),
  };
  return instruments;
}

/** Registra o gauge `cf_outbox_relay_leader` (1 na réplica líder; a soma deve ser 1). */
export function observeRelayLeader(isLeader: () => boolean): void {
  metrics
    .getMeter('contrataflow-worker')
    .createObservableGauge('cf_outbox_relay_leader', {
      description: '1 na réplica que detém a trava de líder do relay.',
    })
    .addCallback((result) => {
      result.observe(isLeader() ? 1 : 0);
    });
}

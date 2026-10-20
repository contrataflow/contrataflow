import { metrics } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';

/*
 * Métrica da caixa de tarefas (DoD da US-056 — `inbox_query_duration_ms`, p95 < 500 ms por visão
 * — RN-INBOX-12). Convenção do repositório: `cf_<módulo>_<fato>`; `view` = a visão de TSK-01 ou
 * `COUNTERS` (TSK-02).
 */

let duration: Histogram | undefined;

export function recordInboxQuery(view: string, durationMs: number, outcome: 'ok' | 'error'): void {
  duration ??= metrics.getMeter('contrataflow-api').createHistogram('cf_inbox_query_duration_ms', {
    description: 'Duração das consultas da caixa de tarefas (TSK-01 por visão e TSK-02).',
    unit: 'ms',
  });
  duration.record(durationMs, { view, outcome });
}

import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas do painel (DoD da US-076 — duração por indicador e taxa de acerto do cache; RN-DASH-11:
 * p95 < 1 s por indicador). Convenção do repositório: `cf_<módulo>_<fato>`; `widget` = a chave do
 * indicador ou `SUMMARY` (DSH-01).
 */

let duration: Histogram | undefined;
let cacheLookups: Counter | undefined;

export function recordDashboardWidget(
  widget: string,
  durationMs: number,
  outcome: 'ok' | 'error',
  cacheHit: boolean,
): void {
  duration ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('cf_dashboard_widget_duration_ms', {
      description: 'Duração das consultas do dashboard (DSH-01 e DSH-02 por indicador).',
      unit: 'ms',
    });
  duration.record(durationMs, { widget, outcome, cache: cacheHit ? 'hit' : 'miss' });
}

/** `result`: `hit`, `miss` ou `unavailable` (Redis fora — RN-DASH-10). */
export function recordDashboardCacheLookup(
  widget: string,
  result: 'hit' | 'miss' | 'unavailable',
): void {
  cacheLookups ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_dashboard_cache_lookups_total', {
      description: 'Consultas ao cache do dashboard por resultado (taxa de acerto).',
    });
  cacheLookups.add(1, { widget, result });
}

import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da renderização em PDF (US-067 · RN-DOC-70 · DoD "métricas de duração/p95"): duração do
 * PEDIDO ao `READY` (base do SLO: prévia p95 ≤ 15 s; versão p95 ≤ 30 s) e contagem por resultado.
 * Sem rótulo de tenant nem de documento (observability.md). `result` ∈ `READY`/`FAILED`/`RETRY`/
 * `DEFERRED`.
 */

interface RenderInstruments {
  readonly renders: Counter;
  readonly duration: Histogram;
}

let instruments: RenderInstruments | undefined;

function renderInstruments(): RenderInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    renders: meter.createCounter('cf_document_renders_total', {
      description: 'Renderizações de PDF por tipo e resultado.',
    }),
    duration: meter.createHistogram('cf_document_render_duration_seconds', {
      description: 'Duração do pedido do PDF até READY/FAILED (SLO RN-DOC-70).',
      unit: 's',
    }),
  };
  return instruments;
}

export function recordRender(kind: string, result: string, durationMs: number | null): void {
  const { renders, duration } = renderInstruments();
  renders.add(1, { kind, result });
  if (durationMs !== null) duration.record(durationMs / 1000, { kind, result });
}

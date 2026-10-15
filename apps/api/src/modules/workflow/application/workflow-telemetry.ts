import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

interface WorkflowInstruments {
  readonly validationDuration: Histogram;
  readonly publications: Counter;
  readonly definitionCache: Counter;
}

let instruments: WorkflowInstruments | undefined;

/** Métricas da definição de workflow (US-040 · DoD: validação e publicação). */
function workflowInstruments(): WorkflowInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    validationDuration: meter.createHistogram('cf_workflow_validation_duration_ms', {
      description: 'Duração da validação completa de uma versão de workflow (meta p95 < 200 ms).',
      unit: 'ms',
    }),
    publications: meter.createCounter('cf_workflow_publications_total', {
      description: 'Publicações de versão de workflow por resultado (published/invalid).',
    }),
    definitionCache: meter.createCounter('cf_workflow_definition_cache_total', {
      description: 'Leituras da definição publicada por resultado do cache (hit/miss/unavailable).',
    }),
  };
  return instruments;
}

export function recordValidation(durationMs: number, valid: boolean): void {
  workflowInstruments().validationDuration.record(durationMs, { valid: String(valid) });
}

export function recordPublication(result: 'published' | 'invalid'): void {
  workflowInstruments().publications.add(1, { result });
}

export function recordDefinitionCache(result: 'hit' | 'miss' | 'unavailable'): void {
  workflowInstruments().definitionCache.add(1, { result });
}

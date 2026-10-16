import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

interface WorkflowInstruments {
  readonly validationDuration: Histogram;
  readonly publications: Counter;
  readonly definitionCache: Counter;
  readonly engineDuration: Histogram;
  readonly ruleFailures: Counter;
  readonly resolutionDuration: Histogram;
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
    engineDuration: meter.createHistogram('cf_workflow_engine_duration_ms', {
      description:
        'Duração do motor de workflow por operação (actions/checklist — US-041, meta p95 < 150 ms).',
      unit: 'ms',
    }),
    ruleFailures: meter.createCounter('cf_workflow_rule_failures_total', {
      description:
        'Regras não avaliáveis em runtime por tipo e causa (tratadas como não satisfeitas).',
    }),
    resolutionDuration: meter.createHistogram('cf_workflow_resolution_duration_ms', {
      description:
        'Duração da resolução do workflow aplicável por desfecho (WF-06 — US-042, meta p95 < 100 ms).',
      unit: 'ms',
    }),
  };
  return instruments;
}

export function recordEngine(operation: 'actions' | 'checklist', durationMs: number): void {
  workflowInstruments().engineDuration.record(durationMs, { operation });
}

export function recordRuleFailure(ruleType: string, cause: string): void {
  workflowInstruments().ruleFailures.add(1, { rule_type: ruleType, cause });
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

export function recordResolution(
  via: 'RULE' | 'UNCONDITIONAL' | 'DEFAULT' | 'NONE',
  durationMs: number,
): void {
  workflowInstruments().resolutionDuration.record(durationMs, { via });
}

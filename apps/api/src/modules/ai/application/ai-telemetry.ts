import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da camada de IA (US-115 · "Logs"): contagens, tokens, custo e duração — nunca texto de
 * entrada ou de saída (DEC-138). Rótulos de cardinalidade baixa (alvo, tipo, status, modelo, código).
 */

interface AiInstruments {
  readonly generations: Counter;
  readonly tokens: Counter;
  readonly cost: Counter;
  readonly duration: Histogram;
  readonly groundingReplacements: Counter;
  readonly providerErrors: Counter;
}

let instruments: AiInstruments | undefined;

function aiInstruments(): AiInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    generations: meter.createCounter('cf_ai_generations_total', {
      description: 'Gerações com IA por alvo, tipo e status.',
    }),
    tokens: meter.createCounter('cf_ai_tokens_total', {
      description: 'Tokens consumidos por direção (input/output) e modelo.',
    }),
    cost: meter.createCounter('cf_ai_cost_usd_total', {
      description: 'Custo em USD pela tabela de preços da plataforma, por modelo.',
    }),
    duration: meter.createHistogram('cf_ai_generation_duration_seconds', {
      description: 'Duração da geração, do pedido ao término.',
      unit: 's',
    }),
    groundingReplacements: meter.createCounter('cf_ai_grounding_replacements_total', {
      description: 'Trocas por [a confirmar] feitas pelos ganchos de pós-processamento.',
    }),
    providerErrors: meter.createCounter('cf_ai_provider_errors_total', {
      description: 'Falhas do provedor de IA por código.',
    }),
  };
  return instruments;
}

export function countGeneration(target: string, kind: string, status: string): void {
  aiInstruments().generations.add(1, { target, kind, status });
}

export function recordUsage(model: string, inputTokens: number, outputTokens: number): void {
  const { tokens } = aiInstruments();
  if (inputTokens > 0) tokens.add(inputTokens, { direction: 'input', model });
  if (outputTokens > 0) tokens.add(outputTokens, { direction: 'output', model });
}

export function recordCost(model: string, costUsd: string | null): void {
  if (costUsd === null) return;
  const value = Number(costUsd);
  if (value > 0) aiInstruments().cost.add(value, { model });
}

export function recordDuration(seconds: number, target: string, kind: string): void {
  aiInstruments().duration.record(seconds, { target, kind });
}

export function recordGroundingReplacements(count: number): void {
  if (count > 0) aiInstruments().groundingReplacements.add(count);
}

export function countProviderError(code: string): void {
  aiInstruments().providerErrors.add(1, { code });
}

import type { AiGenerationOutput } from '@contrataflow/validation';

import type { SanitizedContext } from './context-sanitizer.js';
import { countToConfirm } from './output-converter.js';

/*
 * Ganchos de pós-processamento (RN-AI-07 · fluxo principal, passo 7): rodam em ordem sobre a
 * proposta já convertida, antes de gravar. A cadeia nasce vazia nesta story; a US-122 registra o
 * `GroundingGuard` (troca por `[a confirmar]` todo número/valor/prazo que não esteja nas entradas)
 * e cada gancho informa as trocas em `section.groundingReplacements`. Determinísticos e sem efeito
 * fora da proposta: nada de banco, rede ou log de conteúdo.
 */

export interface PostProcessingInput {
  readonly output: AiGenerationOutput;
  /** Contexto sanitizado que a IA recebeu (a base do que é "fato" para o GroundingGuard). */
  readonly context: SanitizedContext;
}

export interface AiOutputPostProcessor {
  /** Nome estável para logs e métricas. */
  readonly name: string;
  process(input: PostProcessingInput): AiGenerationOutput;
}

export interface PostProcessingResult {
  readonly output: AiGenerationOutput;
  readonly placeholdersCount: number;
  readonly groundingReplacements: number;
}

/** Aplica a cadeia e recalcula as contagens de marcações por seção. */
export function runPostProcessors(
  chain: readonly AiOutputPostProcessor[],
  output: AiGenerationOutput,
  context: SanitizedContext,
): PostProcessingResult {
  const processed = chain.reduce(
    (current, processor) => processor.process({ output: current, context }),
    output,
  );
  const sections = processed.sections.map((section) => ({
    ...section,
    placeholdersCount: countToConfirm(section.content as Parameters<typeof countToConfirm>[0]),
  }));
  return {
    output: { ...processed, sections },
    placeholdersCount: sections.reduce((sum, section) => sum + section.placeholdersCount, 0),
    groundingReplacements: sections.reduce(
      (sum, section) => sum + section.groundingReplacements,
      0,
    ),
  };
}

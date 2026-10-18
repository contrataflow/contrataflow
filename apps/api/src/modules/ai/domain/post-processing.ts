import { aiProposedRiskSchema, richTextProblem } from '@contrataflow/validation';
import type { AiGenerationOutput } from '@contrataflow/validation';

import type { SanitizedContext } from './context-sanitizer.js';
import { countToConfirm, plainTextLength, riskPlaceholdersOf } from './output-converter.js';
import type { SectionSpec } from './output-converter.js';

/*
 * Ganchos de pós-processamento (RN-AI-07 · fluxo principal, passo 7): rodam em ordem sobre a
 * proposta já convertida, antes de gravar. O `AiModule` registra o `GroundingGuard` (US-122: troca
 * por `[a confirmar]` todo número/valor/prazo que não esteja nas entradas) e cada gancho informa as
 * trocas em `section.groundingReplacements`. Determinísticos e sem efeito fora da proposta: nada de
 * banco, rede ou log de conteúdo. A saída da cadeia é conferida de novo (`postProcessingIssues`):
 * só nós do editor (DEC-056) e `maxChars` da seção — a troca por `toConfirm` muda o tamanho.
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

/**
 * Problemas da proposta pós-processada (só caminhos e códigos — nunca o texto): nó fora do schema
 * do editor (ex.: `toConfirm` inválido) ou seção acima de `maxChars`. Vazio = pode gravar.
 */
export function postProcessingIssues(
  output: AiGenerationOutput,
  specs: readonly SectionSpec[],
): string[] {
  const maxChars = new Map(specs.map((spec) => [spec.sectionKey, spec.maxChars]));
  const issues: string[] = [];
  for (const [index, section] of output.sections.entries()) {
    if (richTextProblem(section.content) !== null) {
      issues.push(`sections.${String(index)}.content: invalid_node`);
    }
    const limit = maxChars.get(section.sectionKey);
    const doc = section.content as Parameters<typeof plainTextLength>[0];
    if (limit !== undefined && plainTextLength(doc) > limit) {
      issues.push(`sections.${String(index)}.content: too_long`);
    }
  }
  // Riscos (US-119): a troca por "[a confirmar: …]" muda o tamanho dos textos — limites de novo.
  for (const [index, risk] of (output.risks ?? []).entries()) {
    if (!aiProposedRiskSchema.safeParse(risk).success) {
      issues.push(`risks.${String(index)}: invalid_risk`);
    }
  }
  return issues;
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
  // Riscos (US-119): texto simples — cada troca dos ganchos acrescenta um marcador literal.
  const riskPlaceholders = riskPlaceholdersOf(processed.risks);
  const riskReplacements = Math.max(0, riskPlaceholders - riskPlaceholdersOf(output.risks));
  return {
    output: { ...processed, sections },
    placeholdersCount:
      sections.reduce((sum, section) => sum + section.placeholdersCount, 0) + riskPlaceholders,
    groundingReplacements:
      sections.reduce((sum, section) => sum + section.groundingReplacements, 0) + riskReplacements,
  };
}

import type { AiSectionAction } from '@contrataflow/types';

import type { SectionState } from '../document/document.js';
import type { SectionRender } from '../document/template.js';

/*
 * Ajuste de seção com IA (US-121 · RN-AI-47..52): as regras de elegibilidade da seção, comuns ao
 * front (o `AiSectionMenu` habilita ou explica) e à API (AI-01 decide — V-02/V-03).
 */

/** RN-AI-48 · V-02: texto mínimo para reescrever ou resumir (completar aceita seção vazia). */
export const AI_SECTION_MIN_CHARS = 50;

/** RN-AI-52: estimativa de tokens de cada ajuste (reserva e consumo exibido no painel). */
export const AI_SECTION_RESERVED_TOKENS = 6_000;

export const AI_SECTION_MESSAGES = {
  empty: "A seção precisa de ao menos 50 caracteres. Use 'Completar' ou escreva um pouco mais.",
  notSupported: 'Esta seção não pode ser ajustada com IA.',
  stale: 'A seção mudou desde o pedido. Gere o ajuste novamente.',
} as const;

export type AiSectionAdjustProblem = 'AI_SECTION_NOT_SUPPORTED' | 'AI_SECTION_EMPTY';

/** A seção tem texto editável: `TEXT`, ou estruturada com narrativa complementar. */
export function sectionHasNarrative(section: {
  readonly render: SectionRender;
  readonly allowNarrative: boolean;
}): boolean {
  return section.render === 'TEXT' || section.allowNarrative;
}

/** Caracteres do texto da seção (sem espaços nas pontas; letras compostas contam uma vez). */
export function sectionTextLength(text: string): number {
  return Array.from(text.trim()).length;
}

/**
 * V-02/V-03: seção fora do template, sem narrativa ou `NOT_APPLICABLE` → `AI_SECTION_NOT_SUPPORTED`;
 * `REWRITE`/`SUMMARIZE` com menos de 50 caracteres → `AI_SECTION_EMPTY`. `null` = pode ajustar.
 */
export function aiSectionAdjustProblem(input: {
  readonly action: AiSectionAction;
  /** Definição da seção no template fixado; `null` = fora do template. */
  readonly section: { readonly render: SectionRender; readonly allowNarrative: boolean } | null;
  readonly state: SectionState;
  readonly text: string;
}): AiSectionAdjustProblem | null {
  if (input.section === null || !sectionHasNarrative(input.section)) {
    return 'AI_SECTION_NOT_SUPPORTED';
  }
  if (input.state === 'NOT_APPLICABLE') return 'AI_SECTION_NOT_SUPPORTED';
  if (input.action !== 'COMPLETE' && sectionTextLength(input.text) < AI_SECTION_MIN_CHARS) {
    return 'AI_SECTION_EMPTY';
  }
  return null;
}

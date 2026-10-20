import { TERM_MESSAGES } from './term.js';
import type { TermCompletenessDto } from './term.js';
import {
  SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX,
  SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN,
} from '../document/document-section.js';
import type { DraftContent, DraftSection, SectionState } from '../document/document.js';
import { richTextPlainText } from '../document/rich-text.js';
import type { SectionRequirement } from '../document/template.js';

/*
 * Edição das seções do TR (US-036 · SCR-012 · RN-TR-11..13): regras puras da tela e do servidor —
 * "não se aplica" só em seção que não é `REQUIRED` (RN-TR-12 · V-07), a justificativa de 20 a 2.000
 * caracteres (V-08) e a completude exibida (RN-TR-13), espelho das regras genéricas do DOC-08 para a
 * tela recalcular depois do autosave sem divergir da validação.
 */

export interface TermSectionRule {
  readonly key: string;
  readonly order: number;
  readonly requirement: SectionRequirement;
  readonly minChars?: number | null;
}

/** RN-TR-12: "Não se aplica" só em `REQUIRED_OR_JUSTIFY` ou `OPTIONAL`. */
export function termSectionAllowsNotApplicable(requirement: SectionRequirement): boolean {
  return requirement !== 'REQUIRED';
}

/** V-08: justificativa de 20 a 2.000 caracteres (sem espaços nas pontas); `null` = válida. */
export function termJustificationProblem(text: string | null | undefined): string | null {
  const length = text?.trim().length ?? 0;
  if (length < SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN) return TERM_MESSAGES.justificationTooShort;
  if (length > SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX) {
    return `Informe no máximo ${SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX.toLocaleString('pt-BR')} caracteres.`;
  }
  return null;
}

function textOf(section: DraftSection | undefined): string {
  if (!section?.content) return '';
  return richTextPlainText(section.content).trim();
}

/** A seção exigida está satisfeita (as regras genéricas de seção do DOC-08). */
export function termSectionSatisfied(
  rule: TermSectionRule,
  section: DraftSection | undefined,
): boolean {
  const state: SectionState = section?.state ?? 'EMPTY';
  if (state === 'NOT_APPLICABLE') {
    return (
      rule.requirement !== 'REQUIRED' &&
      (section?.justification?.trim().length ?? 0) >= SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN
    );
  }
  const text = textOf(section);
  if (text === '') return rule.requirement === 'OPTIONAL';
  return rule.minChars === null || rule.minChars === undefined || text.length >= rule.minChars;
}

/** Percentual de `satisfied ÷ required` (0–100, para baixo; sem exigidas = 100). */
export function completenessPercent(satisfied: number, required: number): number {
  if (required === 0) return 100;
  return Math.floor((satisfied * 100) / required);
}

/**
 * RN-TR-13: exigidas satisfeitas ÷ exigidas (`REQUIRED` preenchida; `REQUIRED_OR_JUSTIFY`
 * preenchida ou "não se aplica" justificada). `OPTIONAL` não entra na conta.
 */
export function termCompleteness(
  rules: readonly TermSectionRule[],
  draft: DraftContent,
): TermCompletenessDto {
  const ordered = [...rules].sort((a, b) => a.order - b.order);
  const sections = ordered
    .filter((rule) => rule.requirement !== 'OPTIONAL')
    .map((rule) => ({
      key: rule.key,
      complete: termSectionSatisfied(rule, draft.sections[rule.key]),
    }));
  const satisfied = sections.filter((section) => section.complete).length;
  return {
    required: sections.length,
    satisfied,
    percent: completenessPercent(satisfied, sections.length),
    sections,
  };
}

import {
  richTextFromPlainText,
  TERM_LIMITS,
  TERM_MESSAGES,
  termCompleteness,
} from '@contrataflow/validation';
import type {
  DocumentAction,
  DocumentStatus,
  DraftContent,
  SectionRequirement,
  SectionState,
  TermCompletenessDto,
  TermTemplateSectionDto,
} from '@contrataflow/validation';

import type { EtpSectionDraft } from '../etp/etp-editor-model';

/*
 * Regras de tela do editor do TR (US-036 · SCR-012), puras e testadas: quando a tela abre em modo
 * leitura (FA-06), a navegação lateral (estado, obrigatoriedade e completude de cada seção) e o
 * rascunho "gravado" que alimenta o recálculo local da completude (RN-TR-13). O valor de cada seção,
 * o corpo do DOC-05 e o alvo do autosave são os do ETP (`etp-editor-model` — nenhum mecanismo paralelo).
 */

/** Status em que o TR aceita edição (RN-TR-10 · POL-02). */
const EDITABLE_STATUSES: ReadonlySet<DocumentStatus> = new Set(['DRAFT', 'RETURNED']);

/** O documento está num status em que o TR pode ser editado (senão, FA-06). */
export function isTermStatusEditable(status: DocumentStatus): boolean {
  return EDITABLE_STATUSES.has(status);
}

/** A tela edita só com `UPDATE` nas ações e o TR em `DRAFT`/`RETURNED`; senão, somente leitura. */
export function canEditTerm(
  status: DocumentStatus,
  allowedActions: readonly DocumentAction[],
): boolean {
  return isTermStatusEditable(status) && allowedActions.includes('UPDATE');
}

/** O motivo do modo leitura: faixa "Documento concluído…" (FA-06) ou sem permissão (FA-08). */
export type TermReadOnlyReason = 'concluded' | 'forbidden';

export function termReadOnlyReason(
  status: DocumentStatus,
  allowedActions: readonly DocumentAction[],
): TermReadOnlyReason | null {
  if (canEditTerm(status, allowedActions)) return null;
  return isTermStatusEditable(status) ? 'forbidden' : 'concluded';
}

/** A seção na navegação lateral. */
export interface TermNavItem {
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  readonly state: SectionState;
  /** `undefined` nas opcionais (fora da completude). */
  readonly complete: boolean | undefined;
}

/** As seções do template, na ordem, com o estado gravado e a completude de cada exigida. */
export function termNavItems(
  sections: readonly Pick<TermTemplateSectionDto, 'key' | 'title' | 'order' | 'requirement'>[],
  states: Readonly<Record<string, SectionState>>,
  completeness: TermCompletenessDto,
): TermNavItem[] {
  const complete = new Map(completeness.sections.map((item) => [item.key, item.complete]));
  return [...sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => ({
      key: section.key,
      title: section.title,
      requirement: section.requirement,
      state: states[section.key] ?? 'EMPTY',
      complete: complete.get(section.key),
    }));
}

/** O que a completude local precisa de cada seção do template. */
export function termSectionRules(sections: readonly TermTemplateSectionDto[]) {
  return sections.map((section) => ({
    key: section.key,
    order: section.order,
    requirement: section.requirement,
    minChars: section.minChars,
  }));
}

const SAVED_AT = '1970-01-01T00:00:00.000Z';
const NO_USER = '00000000-0000-7000-8000-000000000000';

/** O rascunho gravado (texto + "não se aplica") como `DraftContent`, para `termCompleteness`. */
export function draftContentOf(drafts: Readonly<Record<string, EtpSectionDraft>>): DraftContent {
  return {
    sections: Object.fromEntries(
      Object.entries(drafts).map(([key, draft]) => [
        key,
        {
          state: draft.notApplicable
            ? ('NOT_APPLICABLE' as const)
            : draft.text.trim() === ''
              ? ('EMPTY' as const)
              : ('FILLED' as const),
          content:
            draft.notApplicable || draft.text.trim() === ''
              ? null
              : richTextFromPlainText(draft.text),
          justification: draft.notApplicable ? draft.justification.trim() : null,
          revision: 0,
          updatedAt: SAVED_AT,
          updatedById: NO_USER,
        },
      ]),
    ),
  };
}

/** RN-TR-13 recalculada na tela depois de cada gravação do autosave. */
export function localCompleteness(
  sections: readonly TermTemplateSectionDto[],
  saved: Readonly<Record<string, EtpSectionDraft>>,
): TermCompletenessDto {
  return termCompleteness(termSectionRules(sections), draftContentOf(saved));
}

// --- Dados do TR ---------------------------------------------------------------------------------

/** V-01 / RN-TR-14: o objeto tem de 10 a 2.000 caracteres (mensagem única da US-036). */
export function objectProblem(text: string): string | null {
  const length = text.trim().length;
  return length < TERM_LIMITS.objectMin || length > TERM_LIMITS.objectMax
    ? TERM_MESSAGES.objectLength
    : null;
}

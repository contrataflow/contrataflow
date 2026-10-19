import {
  DOCUMENT_MESSAGES,
  RICH_TEXT_MAX_BYTES,
  SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN,
} from '@contrataflow/validation';
import type {
  DocumentAction,
  DocumentStatus,
  DocumentTemplateSectionDto,
  SectionRequirement,
  SectionState,
} from '@contrataflow/validation';

/*
 * Regras de tela do editor do documento livre (US-063 · SCR-105), puras e testadas: quando a tela
 * abre em modo leitura, a navegação lateral (estado e exigência de cada seção, na ordem do
 * template), quem admite "Não se aplica" (RN-DOC-28), a justificativa mínima (V-07) e o aviso de
 * limite antes de enviar (FA-03 · V-06). O valor de cada seção, o corpo do DOC-05 e o alvo do
 * autosave são os do ETP (`etp-editor-model` — o mesmo mecanismo da US-015, nenhum paralelo).
 */

/** Status em que o documento aceita edição (POL-02 · V-09). */
const EDITABLE_STATUSES: ReadonlySet<DocumentStatus> = new Set(['DRAFT', 'RETURNED']);

/** A tela edita só com `UPDATE` nas ações e o documento em `DRAFT`/`RETURNED`. */
export function canEditFreeText(
  status: DocumentStatus,
  allowedActions: readonly DocumentAction[],
): boolean {
  return EDITABLE_STATUSES.has(status) && allowedActions.includes('UPDATE');
}

/** O motivo do modo leitura: documento fora de edição ou sem permissão (POL-02). */
export type FreeTextReadOnlyReason = 'notEditable' | 'forbidden';

export function freeTextReadOnlyReason(
  status: DocumentStatus,
  allowedActions: readonly DocumentAction[],
): FreeTextReadOnlyReason | null {
  if (canEditFreeText(status, allowedActions)) return null;
  return EDITABLE_STATUSES.has(status) ? 'forbidden' : 'notEditable';
}

/** A seção na navegação lateral. */
export interface FreeTextNavItem {
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  readonly state: SectionState;
}

/** As seções do template na ordem (`SectionDefinition.order`), com o estado gravado de cada uma. */
export function freeTextNavItems(
  sections: readonly Pick<DocumentTemplateSectionDto, 'key' | 'title' | 'order' | 'requirement'>[],
  states: Readonly<Record<string, SectionState>>,
): FreeTextNavItem[] {
  return [...sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => ({
      key: section.key,
      title: section.title,
      requirement: section.requirement,
      state: states[section.key] ?? 'EMPTY',
    }));
}

/** Campos da US-063: "Não se aplica" só em `REQUIRED_OR_JUSTIFY`/`OPTIONAL` (RN-DOC-28). */
export function allowsNotApplicable(requirement: SectionRequirement): boolean {
  return requirement !== 'REQUIRED';
}

/** V-07: justificativa com ao menos 20 caracteres úteis; `null` = válida. */
export function freeTextJustificationProblem(justification: string): string | null {
  return justification.trim().length < SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN
    ? DOCUMENT_MESSAGES.justificationRequired
    : null;
}

/** Folga sob 1 MB para o JSON do TipTap em volta do texto (FA-03: "se aproxima do limite"). */
const BYTES_MARGIN = 0.9;

/**
 * FA-03 · V-06: o texto passa de `maxChars` ou se aproxima de 1 MB serializado — o front avisa e
 * não envia (a API recusaria com 422 `TOO_LONG`/413). `null` = dentro do limite.
 */
export function sectionLimitProblem(text: string, maxChars: number): string | null {
  if (text.length > maxChars) return DOCUMENT_MESSAGES.sectionTooLong;
  const bytes = new TextEncoder().encode(text).length;
  return bytes > RICH_TEXT_MAX_BYTES * BYTES_MARGIN ? DOCUMENT_MESSAGES.sectionTooLong : null;
}

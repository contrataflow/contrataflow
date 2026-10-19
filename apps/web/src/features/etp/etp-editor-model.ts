import {
  richTextFromPlainText,
  richTextPlainText,
  SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX,
} from '@contrataflow/validation';
import type {
  DocumentAction,
  DocumentSectionSave,
  DocumentStatus,
  DraftSection,
  SectionState,
} from '@contrataflow/validation';

/*
 * Regras de tela do editor do ETP (US-020 · SCR-008), puras e testadas: o valor de cada seção como
 * o autosave o guarda (texto + "não se aplica" + justificativa), o corpo do DOC-05 a partir dele
 * (RN-ETP-10/11 — "não se aplica" grava só a justificativa; voltar a preencher a descarta) e quando
 * a tela abre em modo leitura (FA-05 · sem `UPDATE`).
 */

export const SECTION_PREFIX = 'SECTION:';

export const sectionTarget = (key: string) => `${SECTION_PREFIX}${key}`;

export function sectionKeyOf(target: string): string | null {
  return target.startsWith(SECTION_PREFIX) ? target.slice(SECTION_PREFIX.length) : null;
}

/** A seção como o editor a edita (e a contingência local a guarda). */
export interface EtpSectionDraft {
  readonly text: string;
  readonly notApplicable: boolean;
  readonly justification: string;
}

export const EMPTY_SECTION_DRAFT: EtpSectionDraft = Object.freeze({
  text: '',
  notApplicable: false,
  justification: '',
});

export function sectionDraftOf(
  section: Pick<DraftSection, 'state' | 'content' | 'justification'> | undefined,
): EtpSectionDraft {
  if (section === undefined) return EMPTY_SECTION_DRAFT;
  return {
    text: section.content ? richTextPlainText(section.content) : '',
    notApplicable: section.state === 'NOT_APPLICABLE',
    justification: section.justification ?? '',
  };
}

/** Estado da seção pelo que está no editor (o menu de IA decide as ações — US-121). */
export function draftState(draft: EtpSectionDraft): SectionState {
  if (draft.notApplicable) return 'NOT_APPLICABLE';
  return draft.text.trim() === '' ? 'EMPTY' : 'FILLED';
}

/** O corpo do DOC-05 (`overwrittenRevision` só em "Manter a minha versão"). */
export function sectionSaveBody(
  draft: EtpSectionDraft,
  overwrittenRevision?: number,
): DocumentSectionSave {
  const keep = overwrittenRevision === undefined ? {} : { overwrittenRevision };
  if (draft.notApplicable) {
    return {
      content: null,
      notApplicable: true,
      justification: draft.justification.trim().slice(0, SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX),
      ...keep,
    };
  }
  return {
    content: draft.text.trim() === '' ? null : richTextFromPlainText(draft.text),
    notApplicable: false,
    justification: null,
    ...keep,
  };
}

/** Status em que o ETP aceita edição (POL-02 · FA-05). */
const EDITABLE_STATUSES: ReadonlySet<DocumentStatus> = new Set(['DRAFT', 'RETURNED']);

/** A tela edita só com `UPDATE` nas ações e o ETP em `DRAFT`/`RETURNED`; senão, somente leitura. */
export function canEditEtp(
  status: DocumentStatus,
  allowedActions: readonly DocumentAction[],
): boolean {
  return EDITABLE_STATUSES.has(status) && allowedActions.includes('UPDATE');
}

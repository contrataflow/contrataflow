import {
  SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX,
  SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN,
} from '../document/document-section.js';
import type { DraftContent, SectionState } from '../document/document.js';
import type { SectionRender, SectionRequirement } from '../document/template.js';
import type { Violation } from '../http/problem.js';

/*
 * Edição das seções do ETP (US-020 · SCR-008 · RN-ETP-10..17): regras puras da tela, usadas pelo
 * editor e pelos testes — o quadro estruturado somente leitura de cada seção (RN-ETP-12), a
 * navegação lateral com o estado de cada seção e as pendências não bloqueantes do DOC-08
 * (RN-ETP-13) e a justificativa de "não se aplica" (RN-ETP-11 · V-04). A gravação é o DOC-05
 * genérico (US-015), que confere as mesmas regras no servidor.
 */

/** Mensagens da US-020 (Validações V-01..V-07 e "Casos de erro"). */
export const ETP_SECTION_MESSAGES = Object.freeze({
  notInTemplate: 'Esta seção não existe neste modelo de ETP.',
  notEditable: 'Este ETP não pode ser editado no status atual.',
  conflict: 'Alguém salvou esta seção enquanto você editava.',
  justification: `Explique por que esta seção não se aplica (mín. ${String(SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN)} caracteres).`,
  justificationTooLong: `Informe no máximo ${SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX.toLocaleString('pt-BR')} caracteres.`,
  tooLarge: 'O texto desta seção excede o tamanho máximo permitido.',
  richTextInvalid: 'Este conteúdo contém formatação não suportada. Remova-a e tente novamente.',
  permissionDenied: 'Você não pode editar este ETP.',
  notFound: 'Documento não encontrado.',
  unavailable: 'Não foi possível salvar agora. Tentando novamente…',
});

// --- Seções estruturadas (RN-ETP-12) ------------------------------------------------------------

/** Conteúdo tipado exibido somente leitura na seção (a edição é da story dona). */
export type EtpStructuredKind = 'ITEMS' | 'ALTERNATIVES' | 'RISKS';

const KIND_BY_RENDER: Partial<Record<SectionRender, EtpStructuredKind>> = {
  ITEMS_TABLE: 'ITEMS',
  ALTERNATIVES_TABLE: 'ALTERNATIVES',
  RISK_LIST: 'RISKS',
};

/**
 * RN-ETP-12: `ALTERNATIVES_TABLE` → `ALTERNATIVES`, `ITEMS_TABLE` → `ESTIMATES`, `RISK_LIST` →
 * `RISKS`. O `render` decide; a seção `TEXT` com uma dessas chaves (a biblioteca padrão semeia as
 * 16 seções como `TEXT`) também mostra o quadro do módulo dono.
 */
const KIND_BY_KEY: Readonly<Record<string, EtpStructuredKind>> = {
  ESTIMATES: 'ITEMS',
  ALTERNATIVES: 'ALTERNATIVES',
  RISKS: 'RISKS',
};

export function etpStructuredKind(section: {
  readonly key: string;
  readonly render: SectionRender;
}): EtpStructuredKind | null {
  const byRender = KIND_BY_RENDER[section.render];
  if (byRender !== undefined) return byRender;
  return section.render === 'TEXT' ? (KIND_BY_KEY[section.key] ?? null) : null;
}

/** A seção tem texto editável: `TEXT`, ou estruturada com narrativa complementar (`allowNarrative`). */
export function etpSectionHasNarrative(section: {
  readonly render: SectionRender;
  readonly allowNarrative: boolean;
}): boolean {
  return section.render === 'TEXT' || section.allowNarrative;
}

// --- Navegação lateral (RN-ETP-13) --------------------------------------------------------------

export interface EtpNavSection {
  readonly key: string;
  readonly title: string;
  readonly order: number;
  readonly requirement: SectionRequirement;
}

export interface EtpSectionNavItem {
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  /** Estado do rascunho (`EMPTY` quando a seção não está no rascunho). */
  readonly state: SectionState;
  /** Mensagens das pendências do DOC-08 na seção (informativas — nunca impedem a edição). */
  readonly issues: readonly string[];
}

/**
 * RN-ETP-13: uma linha por seção do template, na ordem, com o estado do `DraftContent` e as
 * pendências do DOC-08 (ex.: `SECTION_TOO_SHORT`) da própria seção.
 */
export function etpSectionNav(
  sections: readonly EtpNavSection[],
  draft: DraftContent,
  violations: readonly Pick<Violation, 'sectionKey' | 'message'>[] = [],
): EtpSectionNavItem[] {
  return [...sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => ({
      key: section.key,
      title: section.title,
      requirement: section.requirement,
      state: draft.sections[section.key]?.state ?? 'EMPTY',
      issues: violations
        .filter((violation) => violation.sectionKey === section.key)
        .map((violation) => violation.message),
    }));
}

export interface EtpCompletionSummary {
  readonly total: number;
  readonly filled: number;
  readonly notApplicable: number;
  readonly empty: number;
  readonly pending: number;
}

/** Contagem do topo da navegação ("9 de 16 seções resolvidas"). */
export function etpCompletionSummary(items: readonly EtpSectionNavItem[]): EtpCompletionSummary {
  const count = (state: SectionState) => items.filter((item) => item.state === state).length;
  return {
    total: items.length,
    filled: count('FILLED'),
    notApplicable: count('NOT_APPLICABLE'),
    empty: count('EMPTY'),
    pending: items.filter((item) => item.issues.length > 0).length,
  };
}

// --- "Não se aplica" (RN-ETP-11 · V-04) ---------------------------------------------------------

export type NotApplicableJustificationProblem = 'REQUIRED' | 'TOO_SHORT' | 'TOO_LONG';

/** V-04: justificativa obrigatória com 20 a 2.000 caracteres (sem contar espaços nas pontas). */
export function notApplicableJustificationProblem(
  text: string | null | undefined,
): NotApplicableJustificationProblem | null {
  const length = text?.trim().length ?? 0;
  if (length === 0) return 'REQUIRED';
  if (length < SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN) return 'TOO_SHORT';
  if (length > SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX) return 'TOO_LONG';
  return null;
}

/** A mensagem de V-04 para o problema da justificativa. */
export function notApplicableJustificationMessage(
  problem: NotApplicableJustificationProblem,
): string {
  return problem === 'TOO_LONG'
    ? ETP_SECTION_MESSAGES.justificationTooLong
    : ETP_SECTION_MESSAGES.justification;
}

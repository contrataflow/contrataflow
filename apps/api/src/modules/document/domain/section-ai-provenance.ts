import type { DraftContent, DraftSection, SectionState } from '@contrataflow/validation';

import { DocumentTransitionError, isEditable } from './document.js';
import type { Document, TransitionStamp } from './document.js';

/*
 * Proveniência de IA por seção (US-122 · RN-AI-55/56 · entities.md §5.10): `DraftSection.ai` diz
 * de qual geração veio o conteúdo e se uma pessoa já o revisou. Funções puras — a revisão (DOC-27)
 * é a ÚNICA forma de preencher `reviewedAt`; editar o texto mantém a proveniência pendente
 * (FA-01), uma nova aplicação de IA zera a revisão (FA-02) e esvaziar a seção ou marcá-la "não se
 * aplica" limpa `ai` (FA-04). O `document` não importa `ai` (D9): só lê o `draftContent`.
 */

export type SectionAiProvenance = NonNullable<DraftSection['ai']>;

/** Seção com conteúdo de IA ainda não revisado (`SECTION_AI_REVIEW_PENDING`). */
export function isAiReviewPending(section: DraftSection | undefined): boolean {
  return section?.ai?.reviewedAt === null;
}

/**
 * Aplicação de conteúdo gerado por IA na seção (DOC-26 — US-117..US-121): proveniência nova e
 * pendente, mesmo que a seção já estivesse revisada (FA-02).
 */
export function withAiApplied(
  section: DraftSection,
  input: TransitionStamp & { readonly generationId: string },
): DraftSection {
  return {
    ...section,
    ai: {
      generationId: input.generationId,
      appliedAt: input.now.toISOString(),
      appliedById: input.actorId,
      reviewedAt: null,
      reviewedById: null,
    },
  };
}

/**
 * Proveniência depois de gravar a seção (DOC-05): editar o texto mantém a anterior (FA-01 — não
 * conta como revisão); seção vazia ou "não se aplica" não tem mais conteúdo gerado (FA-04).
 */
export function aiAfterSave(
  previous: DraftSection | undefined,
  nextState: SectionState,
): DraftSection['ai'] {
  if (nextState !== 'FILLED') return null;
  return previous?.ai ?? null;
}

/** Seções com revisão pendente cuja `revision` difere da esperada (V-04 → 412). */
export class AiReviewConflictError extends Error {
  constructor(readonly current: Readonly<Record<string, number>>) {
    super(`Revisão de IA com seções alteradas: ${Object.keys(current).join(', ')}.`);
    this.name = 'AiReviewConflictError';
  }
}

export interface AiReviewInput extends TransitionStamp {
  readonly sectionKeys: readonly string[];
  readonly expectedRevisions: Readonly<Record<string, number>>;
}

export interface AiReviewOutcome {
  readonly document: Document;
  /** Na ordem pedida; seções sem proveniência pendente ficam de fora (FA-07). */
  readonly reviewedSectionKeys: readonly string[];
  /** Gerações das seções revisadas, sem repetição. */
  readonly generationIds: readonly string[];
}

/**
 * `Document.reviewAiSections` (DOC-27 · RN-AI-56): rascunho editável (senão `NOT_EDITABLE`); cada
 * seção pendente precisa estar na revisão esperada (senão `AiReviewConflictError`, nada muda) e
 * recebe `reviewedAt/By` e `revision + 1`; havendo revisão, o documento ganha `draftRevision + 1`.
 * Seção sem proveniência pendente é ignorada sem conferir a revisão (idempotente).
 */
export function reviewAiSections(document: Document, input: AiReviewInput): AiReviewOutcome {
  if (!isEditable(document)) throw new DocumentTransitionError('NOT_EDITABLE', document.status);
  const sections = document.draftContent.sections;
  const pending = [...new Set(input.sectionKeys)].filter((key) => isAiReviewPending(sections[key]));
  const conflicts: Record<string, number> = {};
  for (const key of pending) {
    const revision = sections[key]?.revision ?? 0;
    if (input.expectedRevisions[key] !== revision) conflicts[key] = revision;
  }
  if (Object.keys(conflicts).length > 0) throw new AiReviewConflictError(conflicts);
  if (pending.length === 0) return { document, reviewedSectionKeys: [], generationIds: [] };

  const reviewedAt = input.now.toISOString();
  const next: DraftContent['sections'] = { ...sections };
  const generationIds = new Set<string>();
  for (const key of pending) {
    const section = sections[key];
    if (section?.ai === undefined || section.ai === null) continue;
    generationIds.add(section.ai.generationId);
    next[key] = {
      ...section,
      revision: section.revision + 1,
      ai: { ...section.ai, reviewedAt, reviewedById: input.actorId },
    };
  }
  return {
    document: {
      ...document,
      draftContent: { sections: next },
      draftRevision: document.draftRevision + 1,
      updatedAt: input.now,
      updatedById: input.actorId,
    },
    reviewedSectionKeys: pending,
    generationIds: [...generationIds],
  };
}

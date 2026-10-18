import type { DraftContent, DraftSection, RichTextDoc } from '@contrataflow/validation';

import { DocumentTransitionError, isEditable } from './document.js';
import type { Document, TransitionStamp } from './document.js';
import { withAiApplied } from './section-ai-provenance.js';
import { sectionDraftProblem } from './section-draft.js';

/*
 * `Document.applyAiSections` (DOC-26 · US-117 · RN-AI-27..29): a aplicação seletiva, por uma
 * pessoa, das seções de uma proposta de IA. Puro: só toca `draftContent` (cabeçalho tipado, itens,
 * datas e valores nunca mudam — RN-AI-27). Seção `FILLED`/`NOT_APPLICABLE` só é substituída com
 * `confirmReplaceFilled` (V-10); a aplicada fica `FILLED`, perde a justificativa de "não se aplica",
 * ganha `revision + 1` e a proveniência `ai` pendente de revisão (RN-AI-55). O documento ganha
 * `draftRevision + 1`. A versão "Antes de aplicar" e a marcação da geração são do caso de uso.
 */

/** Seção da proposta como o `document` a lê da porta `AiSuggestionSource` (sem importar `ai`). */
export interface AiProposalSection {
  readonly sectionKey: string;
  readonly content: { readonly type: 'doc' } & Record<string, unknown>;
}

export type AiApplyRejection =
  /** Chave fora da proposta (V-10 · `NOT_ALLOWED`). */
  | 'SECTION_NOT_IN_PROPOSAL'
  /** Seção preenchida escolhida sem `confirmReplaceFilled` (V-10 · `CONDITIONAL_REQUIRED`). */
  | 'CONFIRM_REPLACE_REQUIRED'
  /** Conteúdo da proposta fora do schema do editor ou do limite da seção (falha fechada). */
  | 'CONTENT_INVALID';

export class AiApplyRejectedError extends Error {
  constructor(
    readonly reason: AiApplyRejection,
    readonly sectionKeys: readonly string[],
  ) {
    super(`Aplicação de IA recusada (${reason}): ${sectionKeys.join(', ')}.`);
    this.name = 'AiApplyRejectedError';
  }
}

export interface AiApplyInput extends TransitionStamp {
  readonly generationId: string;
  readonly proposal: readonly AiProposalSection[];
  readonly sectionKeys: readonly string[];
  readonly confirmReplaceFilled: boolean;
  /** Limite de caracteres de cada seção na versão de template fixada (ausente = sem limite). */
  readonly maxCharsOf: (sectionKey: string) => number | undefined;
}

export interface AiApplyOutcome {
  readonly document: Document;
  /** Na ordem pedida, sem repetição. */
  readonly appliedSectionKeys: readonly string[];
  /** Seções `FILLED`/`NOT_APPLICABLE` substituídas (versão antes — RN-AI-28). */
  readonly replacedSectionKeys: readonly string[];
}

/** Seção com texto do usuário: a substituição exige confirmação (RN-AI-28). */
export function isAiReplacement(section: DraftSection | undefined): boolean {
  return section?.state === 'FILLED' || section?.state === 'NOT_APPLICABLE';
}

/** Marcação padrão do painel (fluxo principal 7): vêm marcadas só as seções vazias. */
export function isDefaultAiSelection(section: DraftSection | undefined): boolean {
  return !isAiReplacement(section);
}

export function applyAiSections(document: Document, input: AiApplyInput): AiApplyOutcome {
  if (!isEditable(document)) throw new DocumentTransitionError('NOT_EDITABLE', document.status);
  const keys = [...new Set(input.sectionKeys)];
  const proposal = new Map(input.proposal.map((section) => [section.sectionKey, section]));
  const unknown = keys.filter((key) => !proposal.has(key));
  if (unknown.length > 0) throw new AiApplyRejectedError('SECTION_NOT_IN_PROPOSAL', unknown);

  const sections = document.draftContent.sections;
  const replaced = keys.filter((key) => isAiReplacement(sections[key]));
  if (replaced.length > 0 && !input.confirmReplaceFilled) {
    throw new AiApplyRejectedError('CONFIRM_REPLACE_REQUIRED', replaced);
  }

  const invalid = keys.filter((key) => {
    const content = proposal.get(key)?.content as RichTextDoc | undefined;
    if (content === undefined) return true;
    const maxChars = input.maxCharsOf(key) ?? Number.MAX_SAFE_INTEGER;
    return (
      sectionDraftProblem({ content, notApplicable: false, justification: null }, { maxChars }) !==
      null
    );
  });
  if (invalid.length > 0) throw new AiApplyRejectedError('CONTENT_INVALID', invalid);

  const next: DraftContent['sections'] = { ...sections };
  for (const key of keys) {
    const previous = sections[key];
    const applied: DraftSection = {
      state: 'FILLED',
      content: proposal.get(key)?.content as DraftSection['content'],
      justification: null,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: input.now.toISOString(),
      updatedById: input.actorId,
    };
    next[key] = withAiApplied(applied, input);
  }
  return {
    document: {
      ...document,
      draftContent: { sections: next },
      draftRevision: document.draftRevision + 1,
      updatedAt: input.now,
      updatedById: input.actorId,
    },
    appliedSectionKeys: keys,
    replacedSectionKeys: replaced,
  };
}

import type { DraftContent, DraftSection, RichTextDoc } from '@contrataflow/validation';

import type { DocumentItem } from './document-items.js';
import { DocumentTransitionError, isEditable } from './document.js';
import type { Document, TransitionStamp } from './document.js';
import { sectionDraftProblem } from './section-draft.js';
import type { SectionDraftProblem } from './section-draft.js';

/*
 * Conteúdo importado de outro documento do processo (US-037 · TRM-06 · DEC-017/019): as seções já
 * compostas pelo módulo dono (REPLACE/APPEND do `importMappings`) e as linhas de item por
 * `processItemId`. Puro: grava `draftContent` (seção `FILLED`, `revision + 1`, sem justificativa,
 * com a proveniência de IA decidida pelo chamador — entities.md §5.10) e devolve a coleção de itens
 * resultante (upsert: as linhas fora da importação ficam como estão). A versão `IMPORT`, a
 * auditoria e o evento são da aplicação.
 */

export interface ImportedSection {
  readonly key: string;
  readonly content: RichTextDoc;
  /** Proveniência de IA resultante (`null` = sem conteúdo gerado pendente). */
  readonly ai: DraftSection['ai'];
}

/** Conteúdo importado fora do schema do editor ou do limite da seção na versão do template. */
export class ImportedSectionRejectedError extends Error {
  constructor(
    readonly sectionKey: string,
    readonly problem: SectionDraftProblem,
  ) {
    super(`Seção importada recusada (${problem.kind}): ${sectionKey}.`);
    this.name = 'ImportedSectionRejectedError';
  }
}

export interface ApplyImportedSectionsInput extends TransitionStamp {
  readonly sections: readonly ImportedSection[];
  /** Limite de caracteres de cada seção na versão de template fixada (ausente = sem limite). */
  readonly maxCharsOf: (sectionKey: string) => number | undefined;
}

export function applyImportedSections(
  document: Document,
  input: ApplyImportedSectionsInput,
): Document {
  if (!isEditable(document)) throw new DocumentTransitionError('NOT_EDITABLE', document.status);
  if (input.sections.length === 0) return document;
  const current = document.draftContent.sections;
  const next: DraftContent['sections'] = { ...current };
  for (const section of input.sections) {
    const problem = sectionDraftProblem(
      { content: section.content, notApplicable: false, justification: null },
      { maxChars: input.maxCharsOf(section.key) ?? Number.MAX_SAFE_INTEGER },
    );
    if (problem !== null) throw new ImportedSectionRejectedError(section.key, problem);
    const applied: DraftSection = {
      state: 'FILLED',
      content: section.content as DraftSection['content'],
      justification: null,
      revision: (current[section.key]?.revision ?? 0) + 1,
      updatedAt: input.now.toISOString(),
      updatedById: input.actorId,
    };
    next[section.key] =
      section.ai === null || section.ai === undefined ? applied : { ...applied, ai: section.ai };
  }
  return {
    ...document,
    draftContent: { sections: next },
    draftRevision: document.draftRevision + 1,
    updatedAt: input.now,
    updatedById: input.actorId,
  };
}

/** Linha de item vinda da importação: ausente = mantém o valor da linha existente. */
export interface ImportedItemLine {
  readonly processItemId: string;
  /** Decimal(18,4) como string (já válido na origem). */
  readonly quantity: string;
  /** `false` = linha existente mantém a quantidade (`copyQuantities = false`). */
  readonly replaceQuantity: boolean;
  /** `undefined` = mantém as observações; string/`null` = substitui. */
  readonly notes?: string | null;
}

export interface ImportedItemsPlan {
  /** A coleção completa resultante (para `DocumentItemRepository.replace`). */
  readonly items: DocumentItem[];
  /** Linhas incluídas ou alteradas, por `processItemId`. */
  readonly written: readonly string[];
}

/**
 * RN-TR-21 · DEC-019: cria ou atualiza a linha do documento por `processItemId` (unicidade
 * `(tenant, documento, item do processo)`); linhas fora da importação ficam como estão. A linha
 * nova vai para o fim da coleção.
 */
export function planImportedItems(input: {
  readonly tenantId: string;
  readonly documentId: string;
  readonly current: readonly DocumentItem[];
  readonly lines: readonly ImportedItemLine[];
  readonly actorId: string;
  readonly now: Date;
  readonly newId: () => string;
}): ImportedItemsPlan {
  const byItem = new Map(input.current.map((item) => [item.processItemId, item]));
  const items: DocumentItem[] = [...input.current];
  const written: string[] = [];
  let nextOrder = input.current.reduce((max, item) => Math.max(max, item.sortOrder + 1), 0);
  for (const line of input.lines) {
    if (written.includes(line.processItemId)) continue;
    const existing = byItem.get(line.processItemId);
    if (existing === undefined) {
      items.push({
        id: input.newId(),
        tenantId: input.tenantId,
        documentId: input.documentId,
        processItemId: line.processItemId,
        quantity: line.quantity,
        notes: line.notes ?? null,
        sortOrder: nextOrder,
        calculationMemo: null,
        createdAt: input.now,
        updatedAt: input.now,
        createdById: input.actorId,
        updatedById: input.actorId,
      });
      nextOrder += 1;
      written.push(line.processItemId);
      continue;
    }
    const quantity = line.replaceQuantity ? line.quantity : existing.quantity;
    const notes = line.notes === undefined ? existing.notes : line.notes;
    written.push(line.processItemId);
    if (quantity === existing.quantity && notes === existing.notes) continue;
    items[items.indexOf(existing)] = {
      ...existing,
      quantity,
      notes,
      updatedAt: input.now,
      updatedById: input.actorId,
    };
  }
  return { items, written };
}

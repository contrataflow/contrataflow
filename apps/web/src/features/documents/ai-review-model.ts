import type { DocumentDto, DraftSection, ToConfirmCategory } from '@contrataflow/validation';

/*
 * Leitura do rascunho para as marcas de IA (US-122 · RN-AI-55/57): quais seções têm conteúdo gerado
 * por IA (pendente ou revisado) e quais marcações "[a confirmar: …]" restam em cada uma. Funções
 * puras sobre `draftContent` — a regra de bloqueio é da API (DOC-08); aqui é só apresentação.
 */

export interface ToConfirmMark {
  readonly label: string;
  readonly category: ToConfirmCategory | null;
}

export interface AiSectionState {
  readonly key: string;
  readonly revision: number;
  /** Proveniência de IA (`null` = seção escrita à mão, só com marcações manuais). */
  readonly ai: NonNullable<DraftSection['ai']> | null;
  readonly pending: boolean;
  readonly marks: readonly ToConfirmMark[];
}

interface Node {
  readonly type?: unknown;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly Node[];
}

function collectMarks(node: Node | null | undefined, into: ToConfirmMark[]): void {
  if (!node) return;
  if (node.type === 'toConfirm') {
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label.trim() : '';
    const category = typeof node.attrs?.category === 'string' ? node.attrs.category : null;
    into.push({
      label: label === '' ? 'informação' : label,
      category: category as ToConfirmCategory | null,
    });
    return;
  }
  for (const child of node.content ?? []) collectMarks(child, into);
}

/** Marcações `toConfirm` de um conteúdo TipTap, na ordem do texto. */
export function toConfirmMarksOf(content: DraftSection['content'] | undefined): ToConfirmMark[] {
  const marks: ToConfirmMark[] = [];
  collectMarks(content, marks);
  return marks;
}

/**
 * Seções que o painel mostra: com proveniência de IA ou com marcações, preenchidas (seção vazia ou
 * "não se aplica" não tem conteúdo gerado — FA-04). Ordem alfabética da chave (estável).
 */
export function aiSectionsOf(document: Pick<DocumentDto, 'draftContent'>): AiSectionState[] {
  return Object.entries(document.draftContent.sections)
    .filter(([, section]) => section.state === 'FILLED')
    .map(([key, section]) => {
      const ai = section.ai ?? null;
      return {
        key,
        revision: section.revision,
        ai,
        pending: ai !== null && ai.reviewedAt === null,
        marks: toConfirmMarksOf(section.content),
      };
    })
    .filter((section) => section.ai !== null || section.marks.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** "JUSTIFICATION" → "Justification"; "EXPECTED_RESULTS" → "Expected results". */
export function sectionLabelOf(key: string): string {
  const spaced = key.replaceAll('_', ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Âncora da seção no painel (link das violações `SECTION_*_PENDING` do DOC-08). */
export function aiSectionAnchor(key: string): string {
  return `secao-ia-${key.toLowerCase().replaceAll('_', '-')}`;
}

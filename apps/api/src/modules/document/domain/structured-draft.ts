import { resolveTemplateVariables } from '@contrataflow/editor';
import { richTextPlainText } from '@contrataflow/validation';
import type {
  DraftContent,
  DraftSection,
  RichTextDocValue,
  SectionDefinition,
} from '@contrataflow/validation';

import { draftContentCopy } from './document.js';

/*
 * Rascunho inicial de um documento estruturado (US-014 · fluxo principal 4.5 · RN-DFD-07): cada
 * seção da versão do template nasce com `revision = 1`; a que tem `defaultContent` recebe o texto
 * com as variáveis `{{...}}` resolvidas no servidor e o estado derivado do conteúdo (`FILLED` com
 * texto útil, senão `EMPTY` — RN-DFD-31). Puro: os valores das variáveis vêm de quem chama.
 */

type RichNode = Readonly<Record<string, unknown>> & {
  readonly text?: string;
  readonly content?: readonly RichNode[];
};

function resolveNode(node: RichNode, variables: Readonly<Record<string, string>>): RichNode {
  const next: Record<string, unknown> = { ...node };
  if (typeof node.text === 'string') next.text = resolveTemplateVariables(node.text, variables);
  if (node.content !== undefined) {
    next.content = node.content.map((child: RichNode) => resolveNode(child, variables));
  }
  return next;
}

/**
 * Variáveis do `defaultContent` resolvidas na criação (entities.md §5.2): as do processo e do
 * órgão. As do documento e da emissão (`{{document.*}}`, `{{today}}`…) ficam para o PDF (RN-DOC-65).
 */
export function processTemplateVariables(process: {
  readonly code: string | null;
  readonly title: string;
  readonly object: string;
  readonly organizationName: string | null;
}): Record<string, string> {
  return {
    'process.code': process.code ?? '',
    'process.title': process.title,
    'process.object': process.object,
    'organization.name': process.organizationName ?? '',
  };
}

export function initialDraftContent(
  sections: readonly SectionDefinition[],
  input: {
    readonly actorId: string;
    readonly now: Date;
    readonly variables: Readonly<Record<string, string>>;
  },
): DraftContent {
  const draft: Record<string, DraftSection> = {};
  for (const section of [...sections].sort((a, b) => a.order - b.order)) {
    const content =
      section.defaultContent === undefined
        ? null
        : (resolveNode(
            section.defaultContent as RichNode,
            input.variables,
          ) as DraftSection['content']);
    const filled = content !== null && richTextPlainText(content).trim() !== '';
    draft[section.key] = {
      state: filled ? 'FILLED' : 'EMPTY',
      content: filled ? content : null,
      justification: null,
      revision: 1,
      updatedAt: input.now.toISOString(),
      updatedById: input.actorId,
    };
  }
  return { sections: draft };
}

/**
 * Duplicação de documento tipado (US-018 · RN-DFD-78): o rascunho inicial do template, com o
 * conteúdo das seções do documento de origem copiado como está (sem recalcular `defaultContent`) —
 * por chave de seção, de modo que um template evoluído desde a origem segue valendo. Seção do
 * template ausente da origem fica com o inicial; seção da origem que o template não tem é descartada.
 */
export function draftContentFromSource(
  initial: DraftContent,
  source: DraftContent,
  stamp: { readonly actorId: string; readonly now: Date },
): DraftContent {
  const copied = draftContentCopy(source, stamp).sections;
  const sections: Record<string, DraftSection> = {};
  for (const [key, section] of Object.entries(initial.sections)) {
    sections[key] = copied[key] ?? section;
  }
  return { sections };
}

/**
 * Seções do rascunho inicial preenchidas pelo módulo dono na criação (US-019 · RN-ETP-05 — a
 * importação do DFD): cada chave presente no rascunho recebe o conteúdo e nasce `FILLED` (ou
 * `EMPTY`, se o conteúdo não tiver texto útil — RN-DFD-31); chave que o template não tem é ignorada.
 */
export function withSectionContents(
  initial: DraftContent,
  contents: Readonly<Record<string, RichTextDocValue>>,
  stamp: { readonly actorId: string; readonly now: Date },
): DraftContent {
  const sections: Record<string, DraftSection> = { ...initial.sections };
  for (const [key, content] of Object.entries(contents)) {
    const current = sections[key];
    if (current === undefined) continue;
    const filled = richTextPlainText(content).trim() !== '';
    sections[key] = {
      ...current,
      state: filled ? 'FILLED' : 'EMPTY',
      content: filled ? content : null,
      updatedAt: stamp.now.toISOString(),
      updatedById: stamp.actorId,
    };
  }
  return { sections };
}

import { resolveTemplateVariables } from '@contrataflow/editor';
import { richTextPlainText } from '@contrataflow/validation';
import type { DraftContent, DraftSection, SectionDefinition } from '@contrataflow/validation';

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

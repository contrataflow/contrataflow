import { resolveTemplateVariables } from '@contrataflow/editor';
import { richTextPlainText } from '@contrataflow/validation';
import type { DraftContent, DraftSection, SectionDefinition } from '@contrataflow/validation';

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

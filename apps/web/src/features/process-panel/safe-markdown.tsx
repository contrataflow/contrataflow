import type { ReactNode } from 'react';

/*
 * Markdown das instruções da etapa (`WorkflowStage.instructions` — US-004 · "Impacto técnico"):
 * subconjunto seguro renderizado como elementos React — parágrafos, listas (`-`/`*`/`1.`),
 * **negrito**, *itálico* e `código`. Nada vira HTML: tags, links e imagens aparecem como texto
 * (sem `dangerouslySetInnerHTML`, sem `javascript:` — sanitização por construção).
 */

export type MarkdownBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

/** Blocos do texto: linhas em branco separam parágrafos; itens consecutivos formam uma lista. */
export function markdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  // `as`: a lista muda dentro de `flushList` (o TS não acompanha a atribuição no fechamento).
  let list = null as { ordered: boolean; items: string[] } | null;
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = () => {
    if (list !== null) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  for (const raw of source.replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.trim();
    const bullet = BULLET.exec(raw);
    const ordered = ORDERED.exec(raw);
    const item = bullet ?? ordered;
    if (line === '') {
      flushParagraph();
      flushList();
    } else if (item) {
      flushParagraph();
      const isOrdered = ordered !== null && bullet === null;
      if (list?.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push(item[1]?.trim() ?? '');
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

/** Ênfases em linha como elementos; o resto é texto puro (o React escapa). */
export function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const key = `${String(index)}:${part}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (
      ((part.startsWith('*') && part.endsWith('*')) ||
        (part.startsWith('_') && part.endsWith('_'))) &&
      part.length > 2
    ) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

export function SafeMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {markdownBlocks(text).map((block, index) => {
        const key = `${String(index)}:${block.kind}`;
        if (block.kind === 'paragraph') return <p key={key}>{renderInline(block.text)}</p>;
        const items = block.items.map((item, itemIndex) => (
          <li key={`${String(itemIndex)}:${item}`}>{renderInline(item)}</li>
        ));
        return block.ordered ? (
          <ol key={key} className="list-decimal pl-5">
            {items}
          </ol>
        ) : (
          <ul key={key} className="list-disc pl-5">
            {items}
          </ul>
        );
      })}
    </div>
  );
}

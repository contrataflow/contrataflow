import { isSafeCommentLink } from '@contrataflow/validation';
import type { CommentBody } from '@contrataflow/validation';

/*
 * Texto do compositor ⇄ documento TipTap restrito (US-071 · RN-CMT-03). Enquanto o editor rico
 * (US-063) não chega ao web, o `CommentComposer` usa uma marcação leve, digitável e acessível por
 * teclado — **negrito**, *itálico*, [texto](https://…), URLs soltas, "- " e "1. " para listas — e
 * esta conversão produz o MESMO JSON que o TipTap com as extensões restritas produziria. A API
 * confere tudo de novo (`RICH_TEXT_INVALID`): aqui só se evita o envio inútil.
 */

interface Mark {
  readonly type: 'bold' | 'italic' | 'link';
  readonly attrs?: { readonly href: string };
}

interface TextNode {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: readonly Mark[];
}

type Inline = TextNode | { readonly type: 'hardBreak' };

interface Paragraph {
  readonly type: 'paragraph';
  readonly content?: readonly Inline[];
}

interface ListItem {
  readonly type: 'listItem';
  readonly content: readonly Paragraph[];
}

interface List {
  readonly type: 'bulletList' | 'orderedList';
  readonly content: readonly ListItem[];
}

type Block = Paragraph | List;

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const BARE_URL = /(?:https?:\/\/|mailto:)[^\s<>()]+/y;

function text(value: string, marks: readonly Mark[]): TextNode {
  return marks.length === 0 ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

/** Texto em linha com `**`/`*`, links `[t](url)` e URLs soltas. Link inseguro fica como texto. */
export function inlineNodes(line: string): Inline[] {
  const nodes: TextNode[] = [];
  let bold = false;
  let italic = false;
  let buffer = '';
  const marks = (): Mark[] => [
    ...(bold ? [{ type: 'bold' as const }] : []),
    ...(italic ? [{ type: 'italic' as const }] : []),
  ];
  const flush = () => {
    if (buffer !== '') nodes.push(text(buffer, marks()));
    buffer = '';
  };
  let index = 0;
  while (index < line.length) {
    if (line.startsWith('**', index)) {
      flush();
      bold = !bold;
      index += 2;
      continue;
    }
    const char = line.charAt(index);
    if (char === '*') {
      flush();
      italic = !italic;
      index += 1;
      continue;
    }
    LINK.lastIndex = index;
    const link = LINK.exec(line);
    if (link?.[1] !== undefined && link[2] !== undefined && isSafeCommentLink(link[2])) {
      flush();
      nodes.push(text(link[1], [...marks(), { type: 'link', attrs: { href: link[2] } }]));
      index = LINK.lastIndex;
      continue;
    }
    BARE_URL.lastIndex = index;
    const url = BARE_URL.exec(line);
    if (url?.[0] !== undefined && isSafeCommentLink(url[0])) {
      flush();
      nodes.push(text(url[0], [...marks(), { type: 'link', attrs: { href: url[0] } }]));
      index = BARE_URL.lastIndex;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return nodes;
}

const BULLET = /^\s*[-•]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

function paragraphOf(lines: readonly string[]): Paragraph {
  const content: Inline[] = [];
  lines.forEach((line, position) => {
    if (position > 0) content.push({ type: 'hardBreak' });
    content.push(...inlineNodes(line));
  });
  return content.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content };
}

/** Texto do compositor → `body` (parágrafos separados por linha em branco; listas por prefixo). */
export function textToCommentBody(value: string): CommentBody {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const open: { list: { readonly type: List['type']; readonly items: string[] } | null } = {
    list: null,
  };
  const closeParagraph = () => {
    if (paragraph.length > 0) blocks.push(paragraphOf(paragraph));
    paragraph = [];
  };
  const closeList = () => {
    const list = open.list;
    if (list !== null) {
      blocks.push({
        type: list.type,
        content: list.items.map((item) => ({ type: 'listItem', content: [paragraphOf([item])] })),
      });
    }
    open.list = null;
  };
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line);
    const item = bullet ?? ORDERED.exec(line);
    if (item?.[1] !== undefined) {
      const type = bullet ? 'bulletList' : 'orderedList';
      closeParagraph();
      if (open.list?.type !== type) closeList();
      open.list ??= { type, items: [] };
      open.list.items.push(item[1]);
      continue;
    }
    closeList();
    if (line.trim() === '') closeParagraph();
    else paragraph.push(line);
  }
  closeParagraph();
  closeList();
  return { type: 'doc', content: blocks };
}

// --- JSON → texto do compositor (edição — FA-02) -------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const childrenOf = (node: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(node.content) ? node.content.filter(isRecord) : [];

function inlineToText(node: Record<string, unknown>): string {
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') {
    const label = isRecord(node.attrs) ? node.attrs.label : undefined;
    return `@${typeof label === 'string' ? label : ''}`;
  }
  if (node.type !== 'text' || typeof node.text !== 'string') return '';
  const marks = Array.isArray(node.marks) ? node.marks.filter(isRecord) : [];
  let value = node.text;
  const link = marks.find((mark) => mark.type === 'link');
  const href = link && isRecord(link.attrs) ? link.attrs.href : undefined;
  if (typeof href === 'string') value = value === href ? href : `[${value}](${href})`;
  if (marks.some((mark) => mark.type === 'italic')) value = `*${value}*`;
  if (marks.some((mark) => mark.type === 'bold')) value = `**${value}**`;
  return value;
}

const paragraphToText = (node: Record<string, unknown>) =>
  childrenOf(node).map(inlineToText).join('');

/** `body` → texto do compositor (inverso de `textToCommentBody`). */
export function commentBodyToText(body: CommentBody | null): string {
  if (body === null) return '';
  const blocks = childrenOf(body as Record<string, unknown>).map((block) => {
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      return childrenOf(block)
        .map((item, index) => {
          const prefix = block.type === 'bulletList' ? '- ' : `${String(index + 1)}. `;
          return `${prefix}${childrenOf(item).map(paragraphToText).join(' ')}`;
        })
        .join('\n');
    }
    return paragraphToText(block);
  });
  return blocks.join('\n\n');
}

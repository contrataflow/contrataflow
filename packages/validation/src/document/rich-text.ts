import { z } from 'zod';

/*
 * Conteúdo rico (DEC-056): documento TipTap/ProseMirror em JSON. O servidor aceita só os nós e
 * marks do schema permitido, rejeita qualquer outro, limita o tamanho (1 MB por campo) e a
 * profundidade, e só aceita links http(s)/mailto — o HTML é gerado depois, no servidor, a partir
 * deste JSON já conferido. A verificação percorre a árvore (em vez de um schema recursivo) para o
 * contrato OpenAPI continuar simples.
 */

export const RICH_TEXT_NODE_TYPES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'hardBreak',
  'horizontalRule',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const;
export type RichTextNodeType = (typeof RICH_TEXT_NODE_TYPES)[number];

export const RICH_TEXT_MARK_TYPES = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
] as const;

/** Limite de tamanho do JSON serializado de um campo rico (DEC-056 · api.md §2.1). */
export const RICH_TEXT_MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 40;
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

const nodeTypes: ReadonlySet<string> = new Set(RICH_TEXT_NODE_TYPES);
const markTypes: ReadonlySet<string> = new Set(RICH_TEXT_MARK_TYPES);

export interface RichTextNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
  readonly content?: readonly RichTextNode[];
  readonly text?: string;
  readonly marks?: readonly {
    readonly type: string;
    readonly attrs?: Readonly<Record<string, unknown>>;
  }[];
}

export interface RichTextDoc {
  readonly type: 'doc';
  readonly content?: readonly RichTextNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Primeiro problema encontrado na árvore (mensagem pt-BR), ou `null` se o nó é aceito. */
function nodeProblem(node: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return 'O conteúdo tem aninhamento demais.';
  if (!isRecord(node) || typeof node.type !== 'string') return 'Conteúdo rico malformado.';
  const allowedKeys = new Set(['type', 'attrs', 'content', 'text', 'marks']);
  if (Object.keys(node).some((key) => !allowedKeys.has(key))) return 'Conteúdo rico malformado.';
  if (!nodeTypes.has(node.type) || (depth > 0 && node.type === 'doc')) {
    return `O bloco "${node.type}" não é permitido.`;
  }
  if (node.attrs !== undefined) {
    if (!isRecord(node.attrs)) return 'Conteúdo rico malformado.';
    const primitive = Object.values(node.attrs).every(
      (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
    );
    if (!primitive) return 'Conteúdo rico malformado.';
  }
  if (node.type === 'text') {
    if (typeof node.text !== 'string' || node.content !== undefined) {
      return 'Conteúdo rico malformado.';
    }
  } else if (node.text !== undefined || node.marks !== undefined) {
    return 'Conteúdo rico malformado.';
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return 'Conteúdo rico malformado.';
    for (const mark of node.marks as unknown[]) {
      if (!isRecord(mark) || typeof mark.type !== 'string') return 'Conteúdo rico malformado.';
      if (!markTypes.has(mark.type)) return `A formatação "${mark.type}" não é permitida.`;
      if (mark.type === 'link') {
        const href = isRecord(mark.attrs) ? mark.attrs.href : undefined;
        if (typeof href !== 'string' || !SAFE_LINK.test(href)) {
          return 'Links devem começar com http://, https:// ou mailto:.';
        }
      }
    }
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return 'Conteúdo rico malformado.';
    for (const child of node.content as unknown[]) {
      const problem = nodeProblem(child, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

/** Problema do documento rico (`null` = aceito): nós/marks permitidos, links seguros e ≤ 1 MB. */
export function richTextProblem(doc: unknown): string | null {
  if (!isRecord(doc) || doc.type !== 'doc') return 'Conteúdo rico malformado.';
  const problem = nodeProblem(doc, 0);
  if (problem) return problem;
  if (new TextEncoder().encode(JSON.stringify(doc)).length > RICH_TEXT_MAX_BYTES) {
    return 'O conteúdo excede o limite de 1 MB.';
  }
  return null;
}

/** Documento TipTap (`TipTapDoc`) conferido contra o schema permitido (DEC-056). */
export const richTextDocSchema = z
  .looseObject({ type: z.literal('doc'), content: z.array(z.unknown()).optional() })
  .superRefine((doc, ctx) => {
    const problem = richTextProblem(doc);
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem, params: { code: 'INVALID_FORMAT' } });
    }
  })
  .meta({ id: 'TipTapDoc' });
export type RichTextDocValue = z.infer<typeof richTextDocSchema>;

/** Texto puro do documento, bloco a bloco (variáveis, contagem de caracteres, busca). */
export function richTextPlainText(
  doc: RichTextDoc | RichTextDocValue | RichTextNode | undefined | null,
): string {
  if (!doc) return '';
  const node = doc as RichTextNode;
  if (node.type === 'text') return node.text ?? '';
  const parts = (node.content ?? []).map((child) => richTextPlainText(child));
  return parts.join(node.type === 'doc' ? '\n' : '');
}

/** Documento com um parágrafo por linha do texto (vazio = documento sem conteúdo). */
export function richTextFromPlainText(text: string): RichTextDocValue {
  const lines = text.split(/\r?\n/);
  if (text.trim() === '') return { type: 'doc', content: [] };
  return {
    type: 'doc',
    content: lines.map((line) =>
      line === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] },
    ),
  };
}

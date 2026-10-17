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
  'toConfirm',
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

/*
 * Nó em linha `toConfirm` (US-122 · RN-AI-53 · entities.md §5.10): a pendência "[a confirmar: …]"
 * que a IA (ou o GroundingGuard) deixa no lugar do dado que não está nas entradas, ou que o redator
 * insere à mão. Sem filhos; atributos fechados (`label` 1..120, `category`, `origin`).
 */
export const TO_CONFIRM_CATEGORIES = [
  'QUANTITY',
  'VALUE',
  'DEADLINE',
  'DATE',
  'DATA',
  'DECISION',
  'OTHER',
] as const;
export type ToConfirmCategory = (typeof TO_CONFIRM_CATEGORIES)[number];

export const TO_CONFIRM_ORIGINS = ['AI', 'USER'] as const;
export type ToConfirmOrigin = (typeof TO_CONFIRM_ORIGINS)[number];

export const TO_CONFIRM_LABEL_MAX = 120;
export const TO_CONFIRM_MESSAGE = `Descreva o que falta confirmar (até ${String(TO_CONFIRM_LABEL_MAX)} caracteres).`;

/** Rótulo padrão de cada categoria (entities.md §5.10). */
export const TO_CONFIRM_DEFAULT_LABELS: Readonly<Record<ToConfirmCategory, string>> = {
  VALUE: 'valor',
  QUANTITY: 'quantidade',
  DEADLINE: 'prazo',
  DATE: 'data',
  DATA: 'dado do órgão',
  DECISION: 'decisão da equipe',
  OTHER: 'informação',
};

/** Texto exibido da marcação: "[a confirmar: {label}]" (editor, prévia e texto puro). */
export function toConfirmText(label: string): string {
  return `[a confirmar: ${label}]`;
}

const toConfirmCategories: ReadonlySet<string> = new Set(TO_CONFIRM_CATEGORIES);
const toConfirmOrigins: ReadonlySet<string> = new Set(TO_CONFIRM_ORIGINS);

/** Atributos do `toConfirm` fora do contrato (V-05) → mensagem; `null` = aceitos. */
function toConfirmProblem(node: Record<string, unknown>): string | null {
  if (node.content !== undefined || !isRecord(node.attrs)) return TO_CONFIRM_MESSAGE;
  const { label, category, origin, ...rest } = node.attrs;
  if (Object.keys(rest).length > 0) return TO_CONFIRM_MESSAGE;
  if (typeof label !== 'string') return TO_CONFIRM_MESSAGE;
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > TO_CONFIRM_LABEL_MAX) return TO_CONFIRM_MESSAGE;
  if (typeof category !== 'string' || !toConfirmCategories.has(category)) {
    return TO_CONFIRM_MESSAGE;
  }
  if (typeof origin !== 'string' || !toConfirmOrigins.has(origin)) return TO_CONFIRM_MESSAGE;
  return null;
}

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
  if (node.type === 'toConfirm') {
    const problem = toConfirmProblem(node);
    if (problem) return problem;
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
  if (node.type === 'toConfirm') return toConfirmText(String(node.attrs?.label ?? ''));
  const parts = (node.content ?? []).map((child) => richTextPlainText(child));
  return parts.join(node.type === 'doc' ? '\n' : '');
}

function visit(node: RichTextNode, found: (node: RichTextNode) => void): void {
  found(node);
  for (const child of node.content ?? []) visit(child, found);
}

/** Marcações `toConfirm` do documento (RN-AI-57 · `SECTION_PLACEHOLDER_PENDING`). */
export function countToConfirmNodes(
  doc: RichTextDoc | RichTextDocValue | RichTextNode | undefined | null,
): number {
  if (!doc) return 0;
  let count = 0;
  visit(doc as RichTextNode, (node) => {
    if (node.type === 'toConfirm') count += 1;
  });
  return count;
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

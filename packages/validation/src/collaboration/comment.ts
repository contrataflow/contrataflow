import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { cursorMetaSchema } from '../http/pagination.js';

/*
 * Comentários do processo e dos documentos (US-071 · DEC-040/056 · entities.md §4.9 `Comment` ·
 * api/12-comments-attachments.md CMT-01..04). O `body` é um documento TipTap RESTRITO
 * (`commentContentSchema` — RN-CMT-03..05): parágrafo, listas, quebra de linha, menção (US-072) e
 * as marcas negrito, itálico e link. Qualquer outro nó, marca ou atributo é REJEITADO — não há
 * "limpeza silenciosa" — e o HTML nunca vem do cliente (RN-CMT-06). A mesma verificação roda no
 * compositor (V-01/V-03) e na API (`CommentContent` do domínio), que responde 422
 * `RICH_TEXT_INVALID`/`VALIDATION_ERROR`.
 */

/** entities.md §2 — `CommentTargetType`. */
export const COMMENT_TARGET_TYPES = ['PROCESS', 'DOCUMENT'] as const;
export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number];

/** Limites da US-071 ("Campos" · RN-CMT-04/05/09/11/17). */
export const COMMENT_LIMITS = Object.freeze({
  /** Texto puro derivado (`bodyText`), depois do `trim`. */
  textMax: 10_000,
  /** JSON serializado do `body`. */
  bodyMaxBytes: 100 * 1024,
  linkMax: 2048,
  reasonMin: 10,
  reasonMax: 1000,
  sectionKeyMax: 60,
  /** Janela de edição pelo autor (RN-CMT-09 — relógio do servidor). */
  editWindowMs: 15 * 60 * 1000,
  pageDefault: 20,
  /** Respostas embutidas por thread em CMT-01 (as demais via `parentId` — FA-10). */
  repliesPerThread: 20,
  /** Aninhamento máximo (listas dentro de listas). */
  maxDepth: 12,
});

/** Mensagens da tabela "Validações" e dos casos de erro da US-071. */
export const COMMENT_MESSAGES = Object.freeze({
  textLength: 'Escreva um comentário de até 10.000 caracteres.',
  formatting: 'O comentário contém formatação não permitida.',
  linkProtocol: 'Use apenas links http, https ou mailto.',
  documentNotFound: 'Documento não encontrado neste processo.',
  documentCanceled: 'Não é possível comentar um documento cancelado.',
  sectionNotInTemplate: 'Seção inexistente neste documento.',
  parentNotFound: 'Não é possível responder a este comentário.',
  targetMismatch: 'A resposta deve ter o mesmo alvo do comentário original.',
  readOnly: 'Este processo está encerrado; os comentários estão disponíveis apenas para leitura.',
  editWindowExpired: 'O prazo de 15 minutos para editar terminou.',
  alreadyDeleted: 'Este comentário foi excluído.',
  reasonLength: 'Informe o motivo da remoção (mín. 10 caracteres).',
  versionConflict: 'O comentário foi alterado por outra pessoa. Recarregue.',
  permissionDenied: 'Você não pode comentar neste processo.',
  editDenied: 'Somente o autor pode editar este comentário.',
  deleteDenied: 'Você não pode excluir este comentário.',
  notFound: 'Comentário não encontrado.',
  documentIdRequired: 'Informe o documento comentado.',
  processTargetFields: 'Comentário no processo não aceita documento nem seção.',
  invalidCursor: 'Não foi possível continuar a listagem. Recarregue os comentários.',
  confidentialHint:
    'Não informe valores estimados em comentários: este processo tem orçamento sigiloso.',
  maskedBody: 'Comentário em documento com orçamento sigiloso — conteúdo restrito',
});

// --- Conteúdo restrito (RN-CMT-03..05) ----------------------------------------------------------

/** Nós permitidos e quem pode contê-los (RN-CMT-03). `mention` só com a US-072 ativa (RN-CMT-19). */
const CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  doc: new Set(['paragraph', 'bulletList', 'orderedList']),
  paragraph: new Set(['text', 'hardBreak', 'mention']),
  bulletList: new Set(['listItem']),
  orderedList: new Set(['listItem']),
  listItem: new Set(['paragraph', 'bulletList', 'orderedList']),
  text: new Set(),
  hardBreak: new Set(),
  mention: new Set(),
};

export const COMMENT_NODE_TYPES = Object.freeze(Object.keys(CHILDREN));
export const COMMENT_MARK_TYPES = Object.freeze(['bold', 'italic', 'link']);

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const ORDERED_LIST_TYPES = new Set(['1', 'a', 'A', 'i', 'I']);
const MENTION_KINDS = new Set(['USER', 'DEPARTMENT']);

/** Motivo da recusa: o código da API e, para o log, só o NOME do nó/marca (nunca o conteúdo). */
export type CommentContentIssue =
  | {
      readonly code: 'RICH_TEXT_INVALID';
      readonly reason: 'NODE' | 'MARK' | 'ATTRIBUTE' | 'LINK' | 'STRUCTURE' | 'SIZE' | 'DEPTH';
      readonly element: string | null;
      readonly message: string;
    }
  | {
      readonly code: 'VALIDATION_ERROR';
      readonly reason: 'EMPTY' | 'TOO_LONG';
      readonly element: null;
      readonly message: string;
    };

export type CommentContentResult =
  | {
      readonly ok: true;
      /** Texto puro derivado (menções como "@Nome") — RN-CMT-05. */
      readonly bodyText: string;
      readonly links: readonly string[];
      readonly mentions: readonly { readonly kind: string; readonly id: string }[];
    }
  | { readonly ok: false; readonly issue: CommentContentIssue };

export interface CommentContentOptions {
  /** RN-CMT-19: enquanto a US-072 não estiver ativa, `mention` é rejeitado. */
  readonly allowMentions?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ownKeys = (value: Record<string, unknown>) => Object.keys(value);

class Rejected extends Error {
  constructor(readonly issue: CommentContentIssue) {
    super(issue.message);
  }
}

function reject(
  reason: Extract<CommentContentIssue, { code: 'RICH_TEXT_INVALID' }>['reason'],
  element: string | null,
  message: string = COMMENT_MESSAGES.formatting,
): never {
  throw new Rejected({ code: 'RICH_TEXT_INVALID', reason, element, message });
}

/** Link seguro (RN-CMT-04): http/https/mailto, ≤ 2.048 caracteres, sem espaços nem controles. */
export function isSafeCommentLink(href: unknown): href is string {
  if (typeof href !== 'string' || href.length === 0 || href.length > COMMENT_LIMITS.linkMax) {
    return false;
  }
  // eslint-disable-next-line no-control-regex -- controles e espaços disfarçam o protocolo
  if (/[\u0000- \u007f-\u009f]/.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return SAFE_PROTOCOLS.has(url.protocol.toLowerCase());
}

/** Atributos do `link` emitidos pelo TipTap: `href` obrigatório; `target`/`rel`/`class` fixos. */
function checkLinkAttrs(attrs: unknown, links: string[]): void {
  if (!isRecord(attrs)) reject('LINK', 'link', COMMENT_MESSAGES.linkProtocol);
  for (const key of ownKeys(attrs)) {
    if (!['href', 'target', 'rel', 'class'].includes(key)) reject('ATTRIBUTE', 'link');
  }
  if (!isSafeCommentLink(attrs.href)) reject('LINK', 'link', COMMENT_MESSAGES.linkProtocol);
  // O render usa sempre `target="_blank"` e `rel="noopener noreferrer nofollow ugc"`: os valores
  // do cliente só são aceitos quando inofensivos (nulos ou os padrões do TipTap).
  if (attrs.target !== undefined && attrs.target !== null && attrs.target !== '_blank') {
    reject('ATTRIBUTE', 'link');
  }
  if (attrs.rel !== undefined && attrs.rel !== null && typeof attrs.rel !== 'string') {
    reject('ATTRIBUTE', 'link');
  }
  if (attrs.class !== undefined && attrs.class !== null) reject('ATTRIBUTE', 'link');
  links.push(attrs.href);
}

function checkMarks(marks: unknown, links: string[]): void {
  if (!Array.isArray(marks)) reject('STRUCTURE', 'text');
  const seen = new Set<string>();
  for (const mark of marks as unknown[]) {
    if (!isRecord(mark) || typeof mark.type !== 'string') reject('STRUCTURE', 'mark');
    if (!COMMENT_MARK_TYPES.includes(mark.type)) reject('MARK', mark.type);
    if (seen.has(mark.type)) reject('STRUCTURE', mark.type);
    seen.add(mark.type);
    for (const key of ownKeys(mark)) {
      if (key !== 'type' && key !== 'attrs') reject('STRUCTURE', mark.type);
    }
    if (mark.type === 'link') {
      checkLinkAttrs(mark.attrs, links);
    } else if (
      mark.attrs !== undefined &&
      !(isRecord(mark.attrs) && ownKeys(mark.attrs).length === 0)
    ) {
      reject('ATTRIBUTE', mark.type);
    }
  }
}

function checkAttrs(
  type: string,
  attrs: unknown,
  options: CommentContentOptions,
  mentions: { kind: string; id: string }[],
): string | null {
  if (type === 'mention') {
    if (options.allowMentions !== true) reject('NODE', 'mention');
    if (!isRecord(attrs)) reject('ATTRIBUTE', 'mention');
    for (const key of ownKeys(attrs)) {
      if (!['kind', 'id', 'label'].includes(key)) reject('ATTRIBUTE', 'mention');
    }
    const { kind, id, label } = attrs;
    if (typeof kind !== 'string' || !MENTION_KINDS.has(kind)) reject('ATTRIBUTE', 'mention');
    if (typeof id !== 'string' || !z.uuid().safeParse(id).success) reject('ATTRIBUTE', 'mention');
    if (typeof label !== 'string' || label.trim() === '' || label.length > 200) {
      reject('ATTRIBUTE', 'mention');
    }
    mentions.push({ kind, id });
    return label.trim();
  }
  if (attrs === undefined) return null;
  if (!isRecord(attrs)) reject('ATTRIBUTE', type);
  if (type === 'orderedList') {
    for (const key of ownKeys(attrs)) {
      if (key !== 'start' && key !== 'type') reject('ATTRIBUTE', type);
    }
    const { start, type: listType } = attrs;
    if (
      start !== undefined &&
      !(Number.isInteger(start) && (start as number) >= 0 && (start as number) <= 100_000)
    ) {
      reject('ATTRIBUTE', type);
    }
    if (
      listType !== undefined &&
      listType !== null &&
      (typeof listType !== 'string' || !ORDERED_LIST_TYPES.has(listType))
    ) {
      reject('ATTRIBUTE', type);
    }
    return null;
  }
  if (ownKeys(attrs).length > 0) reject('ATTRIBUTE', type);
  return null;
}

interface Walk {
  readonly options: CommentContentOptions;
  readonly links: string[];
  readonly mentions: { kind: string; id: string }[];
}

/** Texto puro do nó (blocos separados por quebra de linha — RN-CMT-05). */
function walk(node: unknown, parent: string | null, depth: number, state: Walk): string {
  if (depth > COMMENT_LIMITS.maxDepth) reject('DEPTH', null);
  if (!isRecord(node) || typeof node.type !== 'string') reject('STRUCTURE', null);
  const { type } = node;
  if (!Object.hasOwn(CHILDREN, type)) reject('NODE', type);
  if (parent === null ? type !== 'doc' : !(CHILDREN[parent]?.has(type) ?? false)) {
    reject(type === 'doc' ? 'NODE' : 'STRUCTURE', type);
  }
  for (const key of ownKeys(node)) {
    if (!['type', 'attrs', 'content', 'text', 'marks'].includes(key)) reject('STRUCTURE', type);
  }
  const mentionLabel = checkAttrs(type, node.attrs, state.options, state.mentions);

  if (type === 'text') {
    if (typeof node.text !== 'string' || node.text.length === 0 || node.content !== undefined) {
      reject('STRUCTURE', 'text');
    }
    if (node.marks !== undefined) checkMarks(node.marks, state.links);
    return node.text;
  }
  if (node.text !== undefined || node.marks !== undefined) reject('STRUCTURE', type);
  if (type === 'hardBreak') {
    if (node.content !== undefined) reject('STRUCTURE', type);
    return '\n';
  }
  if (type === 'mention') {
    if (node.content !== undefined) reject('STRUCTURE', type);
    return `@${mentionLabel ?? ''}`;
  }
  if (node.content === undefined) return '';
  if (!Array.isArray(node.content)) reject('STRUCTURE', type);
  const parts = (node.content as unknown[]).map((child) => walk(child, type, depth + 1, state));
  return type === 'paragraph' ? parts.join('') : parts.join('\n');
}

/** Caracteres percebidos do texto (o limite de 10.000 conta pontos de código). */
const lengthOf = (text: string) => Array.from(text).length;

/**
 * `commentContentSchema` — RN-CMT-03..05: confere o documento TipTap restrito, deriva `bodyText`
 * (1–10.000 caracteres depois do `trim`) e extrai links e menções. Puro: a API e o compositor
 * chamam a mesma função.
 */
export function validateCommentContent(
  body: unknown,
  options: CommentContentOptions = {},
): CommentContentResult {
  try {
    let serialized: unknown;
    try {
      // `JSON.stringify(undefined)` devolve `undefined` em tempo de execução.
      serialized = JSON.stringify(body);
    } catch {
      reject('STRUCTURE', null);
    }
    if (typeof serialized !== 'string') reject('STRUCTURE', null);
    if (new TextEncoder().encode(serialized).length > COMMENT_LIMITS.bodyMaxBytes) {
      reject('SIZE', null);
    }
    const state: Walk = { options, links: [], mentions: [] };
    const text = walk(body, null, 0, state).trim();
    if (text.replace(/\s+/gu, '') === '') {
      return {
        ok: false,
        issue: {
          code: 'VALIDATION_ERROR',
          reason: 'EMPTY',
          element: null,
          message: COMMENT_MESSAGES.textLength,
        },
      };
    }
    if (lengthOf(text) > COMMENT_LIMITS.textMax) {
      return {
        ok: false,
        issue: {
          code: 'VALIDATION_ERROR',
          reason: 'TOO_LONG',
          element: null,
          message: COMMENT_MESSAGES.textLength,
        },
      };
    }
    return { ok: true, bodyText: text, links: state.links, mentions: state.mentions };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, issue: error.issue };
    throw error;
  }
}

/** Documento de comentário a partir de texto puro (parágrafos por linha) — testes e seeds. */
export function commentBodyFromText(text: string): CommentBody {
  return {
    type: 'doc',
    content: text
      .split('\n')
      .map((line) =>
        line === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
  };
}

// --- Requisições --------------------------------------------------------------------------------

/**
 * `body` como objeto JSON (a forma TipTap é conferida por `validateCommentContent`, que responde
 * `RICH_TEXT_INVALID` — o Zod só garante que é um objeto).
 */
export const commentBodySchema = z
  .record(z.string(), z.unknown(), { error: COMMENT_MESSAGES.textLength })
  .meta({
    id: 'CommentBody',
    description:
      'Documento TipTap restrito (RN-CMT-03): nós doc, paragraph, text, bulletList, orderedList, listItem, hardBreak e mention (US-072); marcas bold, italic e link (http/https/mailto, ≤ 2.048). JSON ≤ 100 KB; texto 1–10.000 caracteres.',
  });
export type CommentBody = Readonly<Record<string, unknown>>;

const sectionKeySchema = z
  .string()
  .max(COMMENT_LIMITS.sectionKeyMax, { error: COMMENT_MESSAGES.sectionNotInTemplate })
  .regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/, { error: COMMENT_MESSAGES.sectionNotInTemplate });

/** CMT-02 — corpo de `POST /processes/{id}/comments` (RN-CMT-01/02). */
export const createCommentSchema = z
  .strictObject({
    body: commentBodySchema,
    targetType: z.enum(COMMENT_TARGET_TYPES),
    documentId: z.uuid({ error: COMMENT_MESSAGES.documentNotFound }).nullish(),
    sectionKey: sectionKeySchema.nullish(),
    parentId: z.uuid({ error: COMMENT_MESSAGES.parentNotFound }).nullish(),
  })
  .superRefine((value, context) => {
    // Resposta herda o documento do pai (RN-CMT-02): `documentId` pode ser omitido.
    if (value.targetType === 'DOCUMENT' && !value.documentId && !value.parentId) {
      context.addIssue({
        code: 'custom',
        path: ['documentId'],
        message: COMMENT_MESSAGES.documentIdRequired,
        params: { code: 'CONDITIONAL_REQUIRED' },
      });
    }
    if (value.targetType === 'PROCESS') {
      for (const field of ['documentId', 'sectionKey'] as const) {
        if (value[field]) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: COMMENT_MESSAGES.processTargetFields,
            params: { code: 'NOT_ALLOWED' },
          });
        }
      }
    }
  })
  .meta({ id: 'CreateCommentRequest' });
export type CreateComment = z.output<typeof createCommentSchema>;
export type CreateCommentInput = z.input<typeof createCommentSchema>;

/** CMT-03 — corpo de `PATCH /comments/{id}`. */
export const updateCommentSchema = z
  .strictObject({ body: commentBodySchema })
  .meta({ id: 'UpdateCommentRequest' });
export type UpdateComment = z.output<typeof updateCommentSchema>;

/** CMT-04 — corpo opcional de `DELETE /comments/{id}` (`reason` obrigatório na moderação). */
export const deleteCommentSchema = z
  .strictObject({
    reason: z
      .string()
      .trim()
      .min(COMMENT_LIMITS.reasonMin, { error: COMMENT_MESSAGES.reasonLength })
      .max(COMMENT_LIMITS.reasonMax, { error: COMMENT_MESSAGES.reasonLength })
      .optional(),
  })
  .meta({ id: 'DeleteCommentRequest' });
export type DeleteComment = z.output<typeof deleteCommentSchema>;

export const commentIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const limitSchema = z.coerce
  .number({ error: 'Informe um número inteiro em "limit".' })
  .int({ error: 'Informe um número inteiro em "limit".' })
  .min(1, { error: '"limit" deve ser maior ou igual a 1.' })
  .max(100, { error: '"limit" deve ser no máximo 100.' })
  .default(COMMENT_LIMITS.pageDefault);

/** CMT-01 — cursor opaco, limite (1–100, padrão 20) e filtros (FA-09/FA-10 · RN-CMT-17). */
export const commentListQuerySchema = z
  .strictObject({
    cursor: z
      .string()
      .min(1, { error: COMMENT_MESSAGES.invalidCursor })
      .max(512, { error: COMMENT_MESSAGES.invalidCursor })
      .regex(/^[A-Za-z0-9_-]+$/, { error: COMMENT_MESSAGES.invalidCursor })
      .optional(),
    limit: limitSchema,
    targetType: z.enum(COMMENT_TARGET_TYPES).optional(),
    documentId: z.uuid().optional(),
    sectionKey: sectionKeySchema.optional(),
    parentId: z.uuid().optional(),
  })
  .meta({ id: 'CommentListQuery' });
export type CommentListQuery = z.output<typeof commentListQuerySchema>;

// --- Respostas ----------------------------------------------------------------------------------

const commentBaseSchema = z.object({
  id: z.uuid(),
  processId: z.uuid(),
  targetType: z.enum(COMMENT_TARGET_TYPES),
  document: z.object({ id: z.uuid(), code: z.string().nullable(), title: z.string() }).nullable(),
  sectionKey: z.string().nullable(),
  parentId: z.uuid().nullable(),
  author: z.object({ id: z.uuid(), name: z.string(), departmentName: z.string().nullable() }),
  /** `null` se excluído (RN-CMT-12) ou mascarado por POL-09 (RN-CMT-13). */
  body: z.record(z.string(), z.unknown()).nullable(),
  bodyMasked: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  editedAt: z.iso.datetime({ offset: true }).nullable(),
  isDeleted: z.boolean(),
  deletedByModerator: z.boolean(),
  /** Só para o autor e para quem tem `COMMENT_MODERATE` (RN-CMT-12). */
  deletionReason: z.string().nullable(),
  canEdit: z.boolean(),
  editableUntil: z.iso.datetime({ offset: true }).nullable(),
  canDelete: z.boolean(),
  canModerate: z.boolean(),
  /** `If-Match` de CMT-03/CMT-04. */
  version: z.int().min(1),
});

/** `Comment` — resposta de CMT-01..03 (as respostas da thread vêm em `replies`). */
export const commentSchema = commentBaseSchema.meta({ id: 'Comment' });
export type CommentDto = z.infer<typeof commentSchema>;

/** Thread de CMT-01: comentário raiz com até 20 respostas (ordem crescente) e o total. */
export const commentThreadSchema = commentBaseSchema
  .extend({ replies: z.array(commentSchema), replyCount: z.int().min(0) })
  .meta({ id: 'CommentThread' });
export type CommentThreadDto = z.infer<typeof commentThreadSchema>;

/** `meta` de CMT-01: cursor e o que o compositor precisa (FA-05/FA-07 · "Sem permissão"). */
export const commentListMetaSchema = cursorMetaSchema
  .extend({
    canComment: z.boolean(),
    readOnly: z.boolean(),
    isBudgetConfidential: z.boolean(),
  })
  .meta({ id: 'CommentListMeta' });
export type CommentListMetaDto = z.infer<typeof commentListMetaSchema>;

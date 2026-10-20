import { COMMENT_LIMITS, validateCommentContent } from '@contrataflow/validation';
import type {
  CommentBody,
  CommentContentIssue,
  CommentTargetType,
  ProcessStatus,
} from '@contrataflow/validation';

/*
 * Domínio dos comentários (US-071 · RN-CMT-01..12 · entities.md §4.9). Puro: sem NestJS, Prisma
 * nem outro módulo. `CommentContent` confere o rich text restrito e deriva `bodyText`;
 * `CommentPolicy` decide autor × moderador, a janela de 15 minutos (relógio do servidor) e o
 * status do processo; as fábricas produzem o próximo estado do agregado (a persistência confere a
 * versão — DEC-055).
 */

export interface Comment {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly targetType: CommentTargetType;
  readonly documentId: string | null;
  readonly sectionKey: string | null;
  readonly parentId: string | null;
  readonly authorId: string;
  readonly body: CommentBody;
  readonly bodyText: string;
  readonly editedAt: Date | null;
  readonly deletionReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly updatedById: string | null;
  readonly deletedAt: Date | null;
  readonly deletedById: string | null;
  readonly version: number;
}

/** Alvo do comentário (RN-CMT-01): o processo ou um documento, com seção opcional. */
export interface CommentTarget {
  readonly targetType: CommentTargetType;
  readonly documentId: string | null;
  readonly sectionKey: string | null;
}

// --- CommentContent (RN-CMT-03..05) -------------------------------------------------------------

export type CommentContent =
  | { readonly ok: true; readonly body: CommentBody; readonly bodyText: string }
  | { readonly ok: false; readonly issue: CommentContentIssue };

/** RN-CMT-19: `mention` aceito desde a US-072 (atributos fora do schema → `RICH_TEXT_INVALID`). */
export const MENTIONS_ENABLED = true;

/** Confere o documento TipTap restrito e deriva o texto puro (sem limpeza silenciosa). */
export function commentContentOf(body: CommentBody): CommentContent {
  const result = validateCommentContent(body, { allowMentions: MENTIONS_ENABLED });
  return result.ok ? { ok: true, body, bodyText: result.bodyText } : result;
}

// --- CommentPolicy (RN-CMT-08..11) --------------------------------------------------------------

/** RN-CMT-08: status em que criar, responder, editar e excluir o próprio comentário é permitido. */
export const COMMENT_WRITABLE_PROCESS_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  'DRAFT',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
  'SUSPENDED',
] as const);

export function processAcceptsComments(status: ProcessStatus): boolean {
  return COMMENT_WRITABLE_PROCESS_STATUSES.has(status);
}

/** RN-CMT-09: fim da janela de edição do autor (`createdAt` + 15 min). */
export function editableUntil(comment: Pick<Comment, 'createdAt'>): Date {
  return new Date(comment.createdAt.getTime() + COMMENT_LIMITS.editWindowMs);
}

/** Dentro da janela: até `createdAt + 15 min`, inclusive (14:59 sim, 15:01 não). */
export function withinEditWindow(comment: Pick<Comment, 'createdAt'>, now: Date): boolean {
  return now.getTime() <= editableUntil(comment).getTime();
}

export const isDeleted = (comment: Pick<Comment, 'deletedAt'>) => comment.deletedAt !== null;

/** RN-CMT-11: removido por moderação = excluído com motivo. */
export const isModerated = (comment: Pick<Comment, 'deletedAt' | 'deletionReason'>) =>
  comment.deletedAt !== null && comment.deletionReason !== null;

/** Por que a operação do autor é recusada (`null` = permitida). */
export type AuthorRefusal =
  'NOT_AUTHOR' | 'DELETED' | 'INVALID_PROCESS_STATUS' | 'EDIT_WINDOW_EXPIRED';

/**
 * RN-CMT-09/10: editar exige ser o autor, comentário não excluído, processo aceitando comentários
 * e a janela de 15 min (`edit`); excluir o próprio não tem limite de tempo (`delete`).
 */
export function authorRefusal(
  comment: Comment,
  context: {
    readonly userId: string;
    readonly now: Date;
    readonly processStatus: ProcessStatus;
    readonly action: 'edit' | 'delete';
  },
): AuthorRefusal | null {
  if (comment.authorId !== context.userId) return 'NOT_AUTHOR';
  if (isDeleted(comment)) return 'DELETED';
  if (!processAcceptsComments(context.processStatus)) return 'INVALID_PROCESS_STATUS';
  if (context.action === 'edit' && !withinEditWindow(comment, context.now)) {
    return 'EDIT_WINDOW_EXPIRED';
  }
  return null;
}

/** Ações exibidas no `CommentItem` (RN-CMT-09..11 — sem lançar). */
export interface CommentAbilities {
  readonly canEdit: boolean;
  readonly editableUntil: Date | null;
  readonly canDelete: boolean;
  readonly canModerate: boolean;
}

export function abilitiesOf(
  comment: Comment,
  context: {
    readonly userId: string;
    readonly now: Date;
    readonly processStatus: ProcessStatus;
    readonly canModerate: boolean;
  },
): CommentAbilities {
  const mine = comment.authorId === context.userId;
  const base = { userId: context.userId, now: context.now, processStatus: context.processStatus };
  const canEdit = authorRefusal(comment, { ...base, action: 'edit' }) === null;
  return {
    canEdit,
    editableUntil: canEdit ? editableUntil(comment) : null,
    canDelete: authorRefusal(comment, { ...base, action: 'delete' }) === null,
    // RN-CMT-11: em qualquer status; o moderador que exclui o próprio age como autor.
    canModerate: context.canModerate && !mine && !isDeleted(comment),
  };
}

// --- Respostas (RN-CMT-02) ----------------------------------------------------------------------

/** Por que o pai não aceita resposta: inexistente/de outro processo/excluído/já é resposta. */
export function parentRefusal(
  parent: Comment | null,
  processId: string,
): 'PARENT_NOT_FOUND' | null {
  if (parent?.processId !== processId) return 'PARENT_NOT_FOUND';
  if (isDeleted(parent) || parent.parentId !== null) return 'PARENT_NOT_FOUND';
  return null;
}

/**
 * RN-CMT-02: a resposta herda o alvo do pai; valores informados e divergentes são recusados
 * (`null` = divergente). `documentId`/`sectionKey` omitidos herdam do pai.
 */
export function inheritedTarget(
  parent: CommentTarget,
  requested: {
    readonly targetType: CommentTargetType;
    readonly documentId?: string | null | undefined;
    readonly sectionKey?: string | null | undefined;
  },
): CommentTarget | null {
  if (requested.targetType !== parent.targetType) return null;
  if (requested.documentId && requested.documentId !== parent.documentId) return null;
  if (requested.sectionKey && requested.sectionKey !== parent.sectionKey) return null;
  return {
    targetType: parent.targetType,
    documentId: parent.documentId,
    sectionKey: parent.sectionKey,
  };
}

// --- Fábricas -----------------------------------------------------------------------------------

export function createComment(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly target: CommentTarget;
  readonly parentId: string | null;
  readonly authorId: string;
  readonly body: CommentBody;
  readonly bodyText: string;
  readonly now: Date;
}): Comment {
  return {
    id: input.id,
    tenantId: input.tenantId,
    processId: input.processId,
    targetType: input.target.targetType,
    documentId: input.target.documentId,
    sectionKey: input.target.sectionKey,
    parentId: input.parentId,
    authorId: input.authorId,
    body: input.body,
    bodyText: input.bodyText,
    editedAt: null,
    deletionReason: null,
    createdAt: input.now,
    updatedAt: input.now,
    updatedById: input.authorId,
    deletedAt: null,
    deletedById: null,
    version: 1,
  };
}

/** RN-CMT-09: novo conteúdo e `editedAt` (a versão sobe na gravação). */
export function editComment(
  comment: Comment,
  content: { readonly body: CommentBody; readonly bodyText: string },
  now: Date,
): Comment {
  return {
    ...comment,
    body: content.body,
    bodyText: content.bodyText,
    editedAt: now,
    updatedAt: now,
    updatedById: comment.authorId,
    version: comment.version + 1,
  };
}

/** RN-CMT-10: exclusão lógica pelo autor (respostas permanecem). */
export function deleteByAuthor(comment: Comment, now: Date): Comment {
  return {
    ...comment,
    deletedAt: now,
    deletedById: comment.authorId,
    updatedAt: now,
    updatedById: comment.authorId,
    version: comment.version + 1,
  };
}

/** RN-CMT-11: remoção por moderação, com o motivo (`deletionReason`). */
export function moderateComment(
  comment: Comment,
  moderation: { readonly moderatorId: string; readonly reason: string; readonly now: Date },
): Comment {
  return {
    ...comment,
    deletionReason: moderation.reason,
    deletedAt: moderation.now,
    deletedById: moderation.moderatorId,
    updatedAt: moderation.now,
    updatedById: moderation.moderatorId,
    version: comment.version + 1,
  };
}

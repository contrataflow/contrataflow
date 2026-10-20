import { validateCommentContent } from '@contrataflow/validation';
import type { CommentBody, MentionKind } from '@contrataflow/validation';

import type { Comment } from './comment.js';

/*
 * Domínio das menções (US-072 · RN-CMT-21..28 · entities.md §4.9 `Mention`). Puro: sem NestJS,
 * Prisma nem outro módulo. A menção vive no `body` do comentário (nó `mention`); daqui saem os
 * alvos distintos do documento (RN-CMT-23), os alvos novos de uma edição (RN-CMT-24) e o registro
 * `Mention` (exatamente um alvo). A visibilidade do alvo (RN-CMT-22) é conferida pela aplicação.
 */

/** Alvo de uma menção: usuário ou unidade (`MentionTarget` da story). */
export interface MentionTarget {
  readonly kind: MentionKind;
  readonly id: string;
}

export interface Mention {
  readonly id: string;
  readonly tenantId: string;
  readonly commentId: string;
  readonly processId: string;
  /** Exatamente um dos dois preenchido (RN-CMT-23). */
  readonly mentionedUserId: string | null;
  readonly mentionedDepartmentId: string | null;
  readonly notifiedAt: Date | null;
  readonly createdAt: Date;
}

const keyOf = (target: MentionTarget) => `${target.kind}:${target.id}`;

/**
 * `ExtractMentionsFromBody` (RN-CMT-03/23): alvos dos nós `mention` de um `body` JÁ validado,
 * distintos e na ordem da primeira aparição. Documento fora do schema não tem alvos.
 */
export function mentionTargetsOf(body: CommentBody | null): MentionTarget[] {
  if (body === null) return [];
  const result = validateCommentContent(body, { allowMentions: true });
  if (!result.ok) return [];
  const seen = new Map<string, MentionTarget>();
  for (const target of result.mentions) {
    if (!seen.has(keyOf(target))) seen.set(keyOf(target), { kind: target.kind, id: target.id });
  }
  return [...seen.values()];
}

/** RN-CMT-24: na edição, só os alvos do novo `body` que não estavam no anterior. */
export function newMentionTargets(
  before: CommentBody | null,
  after: CommentBody | null,
): MentionTarget[] {
  const previous = new Set(mentionTargetsOf(before).map(keyOf));
  return mentionTargetsOf(after).filter((target) => !previous.has(keyOf(target)));
}

/** Alvo do registro (inverso de `createMention`). */
export function targetOf(mention: Pick<Mention, 'mentionedUserId' | 'mentionedDepartmentId'>) {
  return mention.mentionedUserId !== null
    ? { kind: 'USER' as const, id: mention.mentionedUserId }
    : { kind: 'DEPARTMENT' as const, id: mention.mentionedDepartmentId ?? '' };
}

/** As menções cujo alvo ainda aparece no `body` (o que o comentário mostra como link). */
export function mentionsPresentIn(
  mentions: readonly Mention[],
  body: CommentBody | null,
): Mention[] {
  const present = new Set(mentionTargetsOf(body).map(keyOf));
  return mentions.filter((mention) => present.has(keyOf(targetOf(mention))));
}

/** `Mention.createFor(comment, target)` — fábrica com exatamente um alvo (RN-CMT-23). */
export function createMention(input: {
  readonly id: string;
  readonly comment: Pick<Comment, 'id' | 'tenantId' | 'processId'>;
  readonly target: MentionTarget;
  readonly now: Date;
}): Mention {
  return {
    id: input.id,
    tenantId: input.comment.tenantId,
    commentId: input.comment.id,
    processId: input.comment.processId,
    mentionedUserId: input.target.kind === 'USER' ? input.target.id : null,
    mentionedDepartmentId: input.target.kind === 'DEPARTMENT' ? input.target.id : null,
    notifiedAt: null,
    createdAt: input.now,
  };
}

/** Ids por tipo de alvo — `metadata` da auditoria (`mentionedUserIds`/`mentionedDepartmentIds`). */
export function mentionedIds(
  mentions: readonly Pick<Mention, 'mentionedUserId' | 'mentionedDepartmentId'>[],
) {
  return {
    mentionedUserIds: mentions.flatMap((m) =>
      m.mentionedUserId === null ? [] : [m.mentionedUserId],
    ),
    mentionedDepartmentIds: mentions.flatMap((m) =>
      m.mentionedDepartmentId === null ? [] : [m.mentionedDepartmentId],
    ),
  };
}

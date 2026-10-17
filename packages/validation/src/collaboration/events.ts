import { z } from 'zod';

import { COMMENT_TARGET_TYPES } from './comment.js';
import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Comment` (events.md §4.4 · US-071), gravados no commit de CMT-02 (criação e
 * resposta), CMT-03 (edição) e CMT-04 (exclusão pelo autor ou moderação). Consumidores: o
 * `TimelineProjector` (`COMMENT_ADDED`; `COMMENT_REMOVED` só na moderação) no mesmo `tx` e o
 * `NotificationDispatcher` (`COMMENT_REPLY` ao `parentAuthorId` — RN-CMT-16). Só ids e o alvo —
 * nunca o texto do comentário nem o motivo da moderação.
 */

const uuid = z.uuid();

export const CommentCreated = defineDomainEvent({
  eventType: 'CommentCreated',
  eventVersion: 1,
  aggregateType: 'Comment',
  payload: z.strictObject({
    commentId: uuid,
    targetType: z.enum(COMMENT_TARGET_TYPES),
    documentId: uuid.nullable(),
    sectionKey: z.string().max(60).nullable(),
    parentId: uuid.nullable(),
    /** Autor do comentário pai (destinatário de `COMMENT_REPLY`); `null` fora de resposta. */
    parentAuthorId: uuid.nullable(),
  }),
  routingKey: 'comment.created',
});

export const CommentUpdated = defineDomainEvent({
  eventType: 'CommentUpdated',
  eventVersion: 1,
  aggregateType: 'Comment',
  payload: z.strictObject({ commentId: uuid }),
  routingKey: 'comment.updated',
});

export const CommentDeleted = defineDomainEvent({
  eventType: 'CommentDeleted',
  eventVersion: 1,
  aggregateType: 'Comment',
  payload: z.strictObject({ commentId: uuid, byModerator: z.boolean() }),
  routingKey: 'comment.deleted',
});

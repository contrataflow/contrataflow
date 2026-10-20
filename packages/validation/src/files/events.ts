import { ATTACHMENT_REASON_CODES, ATTACHMENT_TARGET_TYPES } from '@contrataflow/types';
import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Attachment` (events.md §4.4 · US-068). `AttachmentUploaded` sai do
 * `file-scan` na promoção a `AVAILABLE` (timeline `ATTACHMENT_ADDED`); `AttachmentRejected` da
 * varredura (`INFECTED`/`REJECTED`) ou da confirmação com tamanho divergente (notificação
 * `ATTACHMENT_REJECTED` a quem enviou); `AttachmentDeleted` do commit de ATT-06 (timeline
 * `ATTACHMENT_REMOVED`). Nunca a assinatura do malware nem o motivo da exclusão.
 */

export const AttachmentUploaded = defineDomainEvent({
  eventType: 'AttachmentUploaded',
  eventVersion: 1,
  aggregateType: 'Attachment',
  payload: z.strictObject({
    attachmentId: z.uuid(),
    targetType: z.enum(ATTACHMENT_TARGET_TYPES),
    targetId: z.uuid().nullable(),
    fileName: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  routingKey: 'attachment.uploaded',
});

export const AttachmentRejected = defineDomainEvent({
  eventType: 'AttachmentRejected',
  eventVersion: 1,
  aggregateType: 'Attachment',
  payload: z.strictObject({
    attachmentId: z.uuid(),
    status: z.enum(['INFECTED', 'REJECTED']),
    reasonCode: z.enum(ATTACHMENT_REASON_CODES),
  }),
  routingKey: 'attachment.rejected',
});

export const AttachmentDeleted = defineDomainEvent({
  eventType: 'AttachmentDeleted',
  eventVersion: 1,
  aggregateType: 'Attachment',
  payload: z.strictObject({ attachmentId: z.uuid(), hasReason: z.boolean() }),
  routingKey: 'attachment.deleted',
});

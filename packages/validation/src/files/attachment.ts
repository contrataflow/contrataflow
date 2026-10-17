import {
  ATTACHMENT_REASON_CODES,
  ATTACHMENT_STATUSES,
  ATTACHMENT_TARGET_TYPES,
} from '@contrataflow/types';
import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';

/*
 * Anexos (US-068 · entities.md §4 `Attachment` · api/12-comments-attachments.md ATT-02..06).
 * Schemas compartilhados pela API (corpo/resposta) e pelo `AttachmentUploader` do web. Extensão,
 * MIME e tamanho NÃO são recusados aqui: a API responde 415 `FILE_TYPE_NOT_ALLOWED`/413
 * `FILE_TOO_LARGE` com a allowlist e o limite do tenant (RN-DOC-72). O corpo é estrito — nenhuma
 * chave de storage vem do cliente (RN-DOC-77).
 */

export const ATTACHMENT_FILE_NAME_MAX = 255;
export const ATTACHMENT_DESCRIPTION_MAX = 500;
export const ATTACHMENT_DELETION_REASON_MAX = 1_000;

const EMPTY_FILE_MESSAGE = 'Selecione um arquivo válido.';

/** ATT-02 — intenção de upload. */
export const createAttachmentIntentSchema = z.strictObject({
  targetType: z.enum(ATTACHMENT_TARGET_TYPES, { error: 'Selecione um valor válido.' }),
  targetId: z.uuid({ error: 'Informe um identificador válido.' }),
  fileName: trimmedString({ max: ATTACHMENT_FILE_NAME_MAX }),
  declaredMimeType: z
    .string()
    .trim()
    .toLowerCase()
    .max(120, { error: 'Informe no máximo 120 caracteres.' }),
  sizeBytes: z
    .number({ error: EMPTY_FILE_MESSAGE })
    .int({ error: EMPTY_FILE_MESSAGE })
    .positive({ error: EMPTY_FILE_MESSAGE })
    .max(Number.MAX_SAFE_INTEGER, { error: EMPTY_FILE_MESSAGE }),
  categoryId: uuidV7Schema.optional(),
  description: trimmedString({ max: ATTACHMENT_DESCRIPTION_MAX }).optional(),
});
export type CreateAttachmentIntent = z.infer<typeof createAttachmentIntentSchema>;

/** ATT-06 — exclusão lógica com motivo obrigatório (RN-DOC-79 · V-07). */
export const deleteAttachmentSchema = z.strictObject({
  deletionReason: z
    .string({ error: 'Informe o motivo da exclusão.' })
    .trim()
    .min(1, { error: 'Informe o motivo da exclusão.' })
    .max(ATTACHMENT_DELETION_REASON_MAX, {
      error: `Informe no máximo ${ATTACHMENT_DELETION_REASON_MAX} caracteres.`,
    }),
});
export type DeleteAttachment = z.infer<typeof deleteAttachmentSchema>;

export const attachmentIdParamsSchema = z.strictObject({ id: z.uuid() });

/** Anexo exposto (ATT-01/ATT-04): nunca chaves de storage nem o resultado bruto do antivírus. */
export const attachmentSchema = z.object({
  id: z.uuid(),
  processId: z.uuid().nullable(),
  targetType: z.enum(ATTACHMENT_TARGET_TYPES),
  targetId: z.uuid().nullable(),
  fileName: z.string(),
  extension: z.string(),
  declaredMimeType: z.string(),
  sizeBytes: z.number().int(),
  categoryId: z.uuid().nullable(),
  description: z.string().nullable(),
  status: z.enum(ATTACHMENT_STATUSES),
  /** Motivo resumido de `INFECTED`/`REJECTED` (sem a assinatura do malware). */
  reasonCode: z.enum(ATTACHMENT_REASON_CODES).nullable(),
  sha256: z.string().nullable(),
  createdAt: z.iso.datetime(),
  uploadedAt: z.iso.datetime().nullable(),
  scannedAt: z.iso.datetime().nullable(),
  uploadedById: z.uuid(),
  version: z.int(),
});
export type AttachmentDto = z.infer<typeof attachmentSchema>;

/** Instruções do `PUT` direto na quarentena (DEC-136): credencial ao portador, nunca logar. */
export const attachmentUploadSchema = z.object({
  url: z.url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type AttachmentUploadDto = z.infer<typeof attachmentUploadSchema>;

/** ATT-02 — `201 { data, upload }`. */
export const attachmentIntentResponseSchema = z.object({
  data: attachmentSchema,
  upload: attachmentUploadSchema,
});
export type AttachmentIntentResponse = z.infer<typeof attachmentIntentResponseSchema>;

/** ATT-03 — `202 { data: { status, reasonCode? } }`. */
export const attachmentConfirmationSchema = z.object({
  status: z.enum(ATTACHMENT_STATUSES),
  reasonCode: z.enum(ATTACHMENT_REASON_CODES).optional(),
});
export type AttachmentConfirmationDto = z.infer<typeof attachmentConfirmationSchema>;

/** ATT-05 — `200 { data: { url, expiresAt } }`: URL assinada de leitura (≤ 300 s), nunca logar. */
export const attachmentDownloadSchema = z
  .object({ url: z.url(), expiresAt: z.iso.datetime() })
  .meta({ id: 'AttachmentDownload' });
export type AttachmentDownloadDto = z.infer<typeof attachmentDownloadSchema>;

/** Validade da URL de ATT-05 (storage.md §6 · US-069). */
export const ATTACHMENT_DOWNLOAD_URL_SECONDS = 300;

/**
 * Extensões com prévia inline no navegador (RN-DOC-36 · RN-DOC-86): PDF e imagem. Os demais formatos
 * oferecem só o download (a conversão DOCX → PDF é P2 — RN-DOC-37).
 */
export const INLINE_PREVIEW_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg'] as const;

export function hasInlinePreview(extension: string): boolean {
  return (INLINE_PREVIEW_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

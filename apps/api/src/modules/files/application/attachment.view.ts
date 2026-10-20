import type { AttachmentDto } from '@contrataflow/validation';

import { reasonCodeOf } from '../domain/attachment.js';
import type { Attachment } from '../domain/attachment.js';

/** Anexo exposto (ATT-01/ATT-04): sem chaves de storage nem o resultado bruto do antivírus. */
export function toAttachmentDto(attachment: Attachment): AttachmentDto {
  return {
    id: attachment.id,
    processId: attachment.processId,
    targetType: attachment.targetType,
    targetId: attachment.targetId,
    fileName: attachment.fileName,
    extension: attachment.extension,
    declaredMimeType: attachment.declaredMimeType,
    sizeBytes: attachment.sizeBytes,
    categoryId: attachment.categoryId,
    description: attachment.description,
    status: attachment.status,
    reasonCode: reasonCodeOf(attachment),
    sha256: attachment.sha256,
    createdAt: attachment.createdAt.toISOString(),
    uploadedAt: attachment.uploadedAt?.toISOString() ?? null,
    scannedAt: attachment.scannedAt?.toISOString() ?? null,
    uploadedById: attachment.uploadedById,
    version: attachment.version,
  };
}

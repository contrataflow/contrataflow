import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type { AttachmentFile, AttachmentFileReader } from '#shared/files/attachment-files.js';

import { ATTACHMENT_REPOSITORY } from './files-ports.js';
import type { AttachmentRepository } from './files-ports.js';

/**
 * Leitor do arquivo de um anexo para os donos dos alvos (porta `AttachmentFileRegistry` — US-064):
 * o `document` confere o anexo `AVAILABLE` antes de criar a versão do documento externo. Excluído
 * ou de outro tenant (RLS) = inexistente; nunca expõe chave de storage.
 */
@Injectable()
export class FilesAttachmentFileReader implements AttachmentFileReader {
  constructor(@Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository) {}

  async find(tx: TenantTx, attachmentId: string): Promise<AttachmentFile | null> {
    const attachment = await this.attachments.findById(tx, attachmentId);
    if (attachment === null || attachment.status === 'DELETED') return null;
    return {
      id: attachment.id,
      targetType: attachment.targetType,
      targetId: attachment.targetId,
      status: attachment.status,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      extension: attachment.extension,
      detectedMimeType: attachment.detectedMimeType,
    };
  }
}

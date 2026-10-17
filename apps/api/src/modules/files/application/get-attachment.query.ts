import { Inject, Injectable } from '@nestjs/common';

import { AttachmentAccess } from './attachment-access.js';
import { ATTACHMENT_REPOSITORY, FILES_TRANSACTIONS } from './files-ports.js';
import type { AttachmentRepository, FilesTransactions } from './files-ports.js';
import type { Attachment } from '../domain/attachment.js';

/**
 * ATT-04 — Obter anexo (US-068 · DEC-024): inexistente, de outro tenant, excluído ou de processo
 * invisível → 404. Sem URL de download (ATT-05 — US-069); o cliente faz *polling* do status.
 */
@Injectable()
export class GetAttachmentQuery {
  constructor(
    @Inject(FILES_TRANSACTIONS) private readonly transactions: FilesTransactions,
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    private readonly access: AttachmentAccess,
  ) {}

  execute(id: string): Promise<Attachment> {
    return this.transactions.read(async (tx) => {
      const { attachment } = await this.access.visible(tx, await this.attachments.findById(tx, id));
      return attachment;
    });
  }
}

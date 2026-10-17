import { ATTACHMENT_DOWNLOAD_URL_SECONDS } from '@contrataflow/validation';
import type { AttachmentDownloadDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { ApiError } from '#shared/errors/api-error.js';
import { StorageService } from '#shared/storage/storage.service.js';
import { TenantIsolationViolationError } from '#shared/tenancy/isolation.js';

import { AttachmentAccess } from './attachment-access.js';
import { ATTACHMENT_REPOSITORY, FILES_TRANSACTIONS } from './files-ports.js';
import type { AttachmentRepository, FilesTransactions } from './files-ports.js';

/*
 * ATT-05 — Baixar anexo (storage.md §6 · RN-DOC-83/86), base da prévia inline do documento externo
 * (US-064 · RN-DOC-36): anexo visível (DEC-024 — 404) → `AVAILABLE` conferido AGORA (409
 * `ATTACHMENT_NOT_AVAILABLE`: em varredura, infectado ou rejeitado — nunca um arquivo sem a P3) →
 * `attachment.download` gravado ANTES de assinar (falha ao auditar = 503, nunca URL sem trilha) →
 * URL `GET` assinada do bucket `documents` (≤ 300 s, `Content-Disposition: attachment`; a prévia
 * busca os bytes por `fetch`). A herança de POL-09 por documento `RESTRICTED` e o ATT-01 ficam com a
 * US-069.
 */

@Injectable()
export class GetAttachmentDownloadQuery {
  constructor(
    @Inject(FILES_TRANSACTIONS) private readonly transactions: FilesTransactions,
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AttachmentAccess,
    private readonly storage: StorageService,
  ) {}

  async execute(id: string): Promise<AttachmentDownloadDto> {
    const attachment = await this.transactions.run(async (tx) => {
      const { attachment } = await this.access.visible(tx, await this.attachments.findById(tx, id));
      if (attachment.status !== 'AVAILABLE') {
        throw new ApiError('ATTACHMENT_NOT_AVAILABLE', {
          detail: 'Arquivo em verificação. Tente novamente em instantes.',
          extensions: { status: attachment.status },
        });
      }
      await this.audit.record(tx, {
        action: 'attachment.download',
        entityType: 'Attachment',
        entityId: attachment.id,
        processId: attachment.processId,
        metadata: {
          fileName: attachment.fileName,
          sizeBytes: attachment.sizeBytes,
          targetType: attachment.targetType,
          targetId: attachment.targetId,
        },
      });
      return attachment;
    });
    try {
      const signed = await this.storage.presignGet({
        ref: { bucket: 'documents', key: attachment.storageKey },
        downloadFileName: attachment.fileName,
        contentType: attachment.detectedMimeType ?? attachment.declaredMimeType,
        expiresInSeconds: ATTACHMENT_DOWNLOAD_URL_SECONDS,
      });
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof ApiError || error instanceof TenantIsolationViolationError) throw error;
      throw new ApiError('DEPENDENCY_UNAVAILABLE', {
        detail: 'Não foi possível obter o arquivo agora. Tente novamente em instantes.',
        headers: { 'Retry-After': '5' },
        cause: error,
      });
    }
  }
}

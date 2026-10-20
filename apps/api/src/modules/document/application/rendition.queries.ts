import { RENDITION_LIMITS, RENDITION_MESSAGES } from '@contrataflow/validation';
import type { RenditionDownloadDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { ApiError } from '#shared/errors/api-error.js';
import { StorageService } from '#shared/storage/storage.service.js';

import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import {
  RenditionAccess,
  renditionNotReady,
  renditionStorageUnavailable,
} from './rendition-access.js';
import { downloadFileName, downloadRefusal } from '../domain/document-rendition.js';
import type { DocumentRendition } from '../domain/document-rendition.js';

/*
 * DOC-22/DOC-23 (US-067 · RN-DOC-68/69 · storage.md §6): status para o *polling* e o download por
 * URL pré-assinada (≤ 300 s, `Content-Disposition: attachment`). Rendition de outro tenant ou de
 * documento não visível → 404 (DEC-024). O download exige `READY` (e prévia na validade) — senão
 * 409 `RENDITION_NOT_READY` —, confere POL-09 de novo (PDF completo de conteúdo sigiloso só para
 * quem pode ver o orçamento) e grava `document.download` ANTES de assinar: falha ao auditar = 503,
 * nunca URL sem trilha.
 */

@Injectable()
export class GetRenditionQuery {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    private readonly access: RenditionAccess,
  ) {}

  execute(renditionId: string): Promise<DocumentRendition> {
    return this.transactions.read(
      async (tx) => (await this.access.visible(tx, renditionId)).rendition,
    );
  }
}

@Injectable()
export class GetRenditionDownloadQuery {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: RenditionAccess,
    private readonly storage: StorageService,
  ) {}

  async execute(renditionId: string): Promise<RenditionDownloadDto> {
    const { rendition, fileName } = await this.transactions.run(async (tx) => {
      const { rendition, context } = await this.access.visible(tx, renditionId);
      const refusal = downloadRefusal(rendition, this.clock());
      if (refusal !== null) throw renditionNotReady(refusal === 'EXPIRED');
      const version = await this.access.versionOf(tx, rendition);
      if (!rendition.masked && (await this.access.maskRequired(context, version))) {
        throw new ApiError('PERMISSION_DENIED', {
          detail: RENDITION_MESSAGES.confidential,
          auditReasonCode: 'POL-09',
        });
      }
      await this.audit.record(tx, {
        action: 'document.download',
        entityType: 'DocumentRendition',
        entityId: rendition.id,
        processId: rendition.processId,
        metadata: {
          renditionId: rendition.id,
          documentId: rendition.documentId,
          kind: rendition.kind,
          masked: rendition.masked,
        },
      });
      return {
        rendition,
        fileName: downloadFileName(rendition, {
          code: context.document.code,
          versionNumber: version?.versionNumber ?? null,
        }),
      };
    });
    try {
      const signed = await this.storage.presignGet({
        ref: { bucket: 'renditions', key: rendition.storageKey ?? '' },
        downloadFileName: fileName,
        contentType: 'application/pdf',
        expiresInSeconds: RENDITION_LIMITS.downloadUrlSeconds,
      });
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw renditionStorageUnavailable(error);
    }
  }
}

import { RENDITION_LIMITS } from '@contrataflow/validation';
import type { RenditionDownloadDto, TemplatePreviewDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApiError } from '#shared/errors/api-error.js';
import { StorageService } from '#shared/storage/storage.service.js';

import { DOCUMENT_CLOCK } from './ports.js';
import type { DocumentClock } from './ports.js';
import { TemplatePreviewStore } from './template-preview.store.js';
import {
  templatePreviewNotFound,
  templatePreviewNotReady,
  templatePreviewUnavailable,
} from './template.errors.js';
import { isPreviewExpired } from '../domain/template-preview.js';
import type { TemplatePreview } from '../domain/template-preview.js';

/*
 * TPL-12/TPL-13 (US-109 · RN-TPL-26): status da prévia efêmera para o *polling* e o download por URL
 * pré-assinada (≤ 300 s), como DOC-22/23. A prévia vive no Redis do tenant do contexto: de outro
 * tenant, de outra versão ou vencida (24 h) = 404. Download antes de `READY` → 409
 * `RENDITION_NOT_READY`. Sem auditoria (visualização de configuração). Redis/storage fora → 503.
 */

export function toTemplatePreviewDto(preview: TemplatePreview): TemplatePreviewDto {
  return {
    renditionId: preview.renditionId,
    templateVersionId: preview.templateVersionId,
    status: preview.status,
    pageCount: preview.pageCount,
    sizeBytes: preview.sizeBytes,
    sha256: preview.sha256,
    errorCode: preview.errorCode,
    errorMessage: preview.errorMessage,
    requestedAt: preview.requestedAt.toISOString(),
    readyAt: preview.readyAt?.toISOString() ?? null,
    expiresAt: preview.expiresAt.toISOString(),
  };
}

@Injectable()
export class TemplatePreviewQueries {
  constructor(
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly store: TemplatePreviewStore,
    private readonly storage: StorageService,
  ) {}

  async get(versionId: string, renditionId: string): Promise<TemplatePreview> {
    let preview: TemplatePreview | null;
    try {
      preview = await this.store.find(renditionId);
    } catch (error) {
      throw templatePreviewUnavailable(error);
    }
    if (preview?.templateVersionId !== versionId || isPreviewExpired(preview, this.clock())) {
      throw templatePreviewNotFound();
    }
    return preview;
  }

  async download(versionId: string, renditionId: string): Promise<RenditionDownloadDto> {
    const preview = await this.get(versionId, renditionId);
    if (preview.status !== 'READY' || preview.storageKey === null) throw templatePreviewNotReady();
    try {
      const signed = await this.storage.presignGet({
        ref: { bucket: 'renditions', key: preview.storageKey },
        downloadFileName: `previa-template-${preview.renditionId}.pdf`,
        contentType: 'application/pdf',
        expiresInSeconds: RENDITION_LIMITS.downloadUrlSeconds,
      });
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw templatePreviewUnavailable(error);
    }
  }
}

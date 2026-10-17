import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import type {
  AttachmentConfidentiality,
  AttachmentTarget,
  AttachmentTargetReader,
  AttachmentTargetRef,
} from '#shared/files/attachment-targets.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { isEditable } from '../domain/document.js';

/*
 * Alvos de anexo do `document` (US-068 · RN-DOC-71 · V-04): `DOCUMENT` e `DOCUMENT_VERSION` (o
 * documento da versão — ADR-006). Visível = documento não excluído de processo visível (DEC-024,
 * senão 404). Anexar exige a POL-02 de EDIÇÃO do documento (permissão do tipo, custódia ou
 * participação, processo editável, tipo na etapa) e o documento em `DRAFT`/`RETURNED` — fora disso
 * 409 `DOCUMENT_NOT_EDITABLE`. Documento `RESTRICTED`: o acesso ao arquivo herda a POL-09 (US-069).
 */

@Injectable()
export class DocumentAttachmentTargets implements AttachmentTargetReader {
  readonly targetTypes = ['DOCUMENT', 'DOCUMENT_VERSION'] as const;

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async load(tx: TenantTx, ref: AttachmentTargetRef): Promise<AttachmentTarget | null> {
    const documentId = await this.documentIdOf(tx, ref);
    if (documentId === null) return null;
    try {
      const context = await this.lifecycle.load(tx, documentId);
      return {
        ...ref,
        processId: context.document.processId,
        process: context.process.access,
      };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async assertAttachable(tx: TenantTx, target: AttachmentTarget): Promise<void> {
    const documentId = await this.documentIdOf(tx, target);
    if (documentId === null) throw new ApiError('NOT_FOUND');
    const context = await this.lifecycle.load(tx, documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    if (!isEditable(context.document)) {
      throw new ApiError('DOCUMENT_NOT_EDITABLE', {
        detail: 'Não é possível anexar arquivos neste momento.',
        extensions: { status: context.document.status },
      });
    }
  }

  /** US-069 · RN-DOC-86: documento `RESTRICTED` exige POL-09 para detalhe e download do anexo. */
  async confidentiality(
    tx: TenantTx,
    ref: AttachmentTargetRef,
  ): Promise<AttachmentConfidentiality | null> {
    const documentId = await this.documentIdOf(tx, ref);
    if (documentId === null) return null;
    try {
      const context = await this.lifecycle.load(tx, documentId);
      if (context.document.confidentiality !== 'RESTRICTED') {
        return { restricted: false, allowed: true };
      }
      return { restricted: true, allowed: await this.lifecycle.canViewConfidentialBudget(context) };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  private async documentIdOf(tx: TenantTx, ref: AttachmentTargetRef): Promise<string | null> {
    if (ref.targetType === 'DOCUMENT') return ref.targetId;
    const version = await this.documents.findVersion(tx, ref.targetId);
    return version?.documentId ?? null;
  }
}

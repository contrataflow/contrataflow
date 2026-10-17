import { RENDITION_MESSAGES } from '@contrataflow/validation';
import type { DocumentRenditionDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext } from './document-lifecycle.service.js';
import { DOCUMENT_RENDITION_REPOSITORY } from './rendition.ports.js';
import type { DocumentRenditionRepository } from './rendition.ports.js';
import type { DocumentRendition } from '../domain/document-rendition.js';
import type { DocumentVersionRecord } from '../domain/document-snapshot.js';

/*
 * Visibilidade e POL-09 das renditions (US-067 · DEC-024 · RN-DOC-69): a rendition segue o
 * documento — inexistente, de outro tenant ou de documento/processo não visível = 404 igual. O
 * mascaramento é decidido no PEDIDO (quem pede sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` recebe o
 * PDF com os valores sigilosos ocultos) e conferido de novo no download.
 */

export function renditionNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: RENDITION_MESSAGES.notFound });
}

export function renditionNotReady(expired: boolean): ApiError {
  return new ApiError('RENDITION_NOT_READY', {
    detail: expired ? RENDITION_MESSAGES.previewExpired : RENDITION_MESSAGES.notReady,
  });
}

export function renditionStorageUnavailable(cause: unknown): ApiError {
  return new ApiError('DEPENDENCY_UNAVAILABLE', {
    detail: RENDITION_MESSAGES.unavailable,
    cause,
  });
}

/** Documento externo (`UPLOADED`): o arquivo enviado já é o documento — sem PDF gerado. */
export function uploadedNotRenderable(): ApiError {
  return validationError([
    {
      field: 'kind',
      code: 'NOT_ALLOWED',
      message: 'Documentos externos já são o próprio arquivo: baixe o anexo da versão.',
    },
  ]);
}

export interface VisibleRendition {
  readonly rendition: DocumentRendition;
  readonly context: DocumentContext;
}

export function toRenditionDto(rendition: DocumentRendition): DocumentRenditionDto {
  return {
    id: rendition.id,
    documentId: rendition.documentId,
    documentVersionId: rendition.documentVersionId,
    draftRevision: rendition.draftRevision,
    approvalId: rendition.approvalId,
    kind: rendition.kind,
    status: rendition.status,
    masked: rendition.masked,
    sha256: rendition.sha256,
    sizeBytes: rendition.sizeBytes,
    pageCount: rendition.pageCount,
    errorCode: rendition.errorCode,
    attempts: rendition.attempts,
    requestedById: rendition.requestedById,
    requestedAt: rendition.requestedAt.toISOString(),
    startedAt: rendition.startedAt?.toISOString() ?? null,
    readyAt: rendition.readyAt?.toISOString() ?? null,
    expiresAt: rendition.expiresAt?.toISOString() ?? null,
    createdAt: rendition.createdAt.toISOString(),
    updatedAt: rendition.updatedAt.toISOString(),
  };
}

@Injectable()
export class RenditionAccess {
  constructor(
    @Inject(DOCUMENT_RENDITION_REPOSITORY) private readonly renditions: DocumentRenditionRepository,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  /** Rendition do tenant cujo documento o usuário vê (DEC-024); senão 404. */
  async visible(tx: TenantTx, renditionId: string): Promise<VisibleRendition> {
    const rendition = await this.renditions.findById(tx, renditionId);
    if (rendition === null) throw renditionNotFound();
    try {
      return { rendition, context: await this.lifecycle.load(tx, rendition.documentId) };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') throw renditionNotFound();
      throw error;
    }
  }

  /** Versão da rendition (`null` na prévia). */
  versionOf(tx: TenantTx, rendition: DocumentRendition): Promise<DocumentVersionRecord | null> {
    return rendition.documentVersionId === null
      ? Promise.resolve(null)
      : this.lifecycle.findVersion(tx, rendition.documentVersionId);
  }

  /**
   * POL-09: o conteúdo é sigiloso (processo sigiloso agora OU na versão) e o usuário não pode ver
   * o orçamento → o PDF precisa sair mascarado.
   */
  async maskRequired(
    context: DocumentContext,
    version: DocumentVersionRecord | null,
  ): Promise<boolean> {
    const confidential =
      context.process.isBudgetConfidential ||
      version?.content?.process.isBudgetConfidential === true;
    return confidential && !(await this.lifecycle.canViewConfidentialBudget(context));
  }
}

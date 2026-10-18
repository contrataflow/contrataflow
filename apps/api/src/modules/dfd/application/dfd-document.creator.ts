import { DFD_MESSAGES, dfdDocumentTitle } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  CreateStructuredDocumentInput,
  CreatedStructuredDocument,
} from '../../document/application/document.facade.js';

export interface CreateDfdDocumentInput {
  readonly processId: string;
  readonly templateId: string | null;
  readonly idempotencyKey: string | null;
  /** Duplicação (US-018): documento de origem e o conteúdo das suas seções. */
  readonly source?: CreateStructuredDocumentInput['source'];
}

/**
 * O documento tipado do DFD, comum à criação (DFD-02) e à duplicação (DFD-05): o padrão
 * `createStructuredIn` do `document` com as mensagens do DFD e a tradução dos 409/422 do
 * módulo dono (`DOCUMENT_ALREADY_EXISTS` com o DFD existente e `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`).
 */
@Injectable()
export class DfdDocumentCreator {
  constructor(private readonly documents: DocumentFacade) {}

  async create(tx: TenantTx, input: CreateDfdDocumentInput): Promise<CreatedStructuredDocument> {
    try {
      return await this.documents.createStructuredIn(tx, {
        processId: input.processId,
        systemModule: 'DFD',
        templateId: input.templateId,
        titleOf: (process) => dfdDocumentTitle(process.title),
        messages: {
          templateInvalid: DFD_MESSAGES.templateInvalid,
          notCustodian: DFD_MESSAGES.notCustodian,
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.source === undefined ? {} : { source: input.source }),
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'DOCUMENT_ALREADY_EXISTS') throw await this.alreadyExists(tx, error);
      if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
        throw new ApiError('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', {
          detail: DFD_MESSAGES.typeNotAllowedInStage,
        });
      }
      throw error;
    }
  }

  /**
   * O DFD que já ocupa a vaga (verificação prévia — com o código para o "Abrir DFD"); na corrida
   * decidida pelo índice único o `tx` já falhou no banco e o 409 vai sem o código.
   */
  private async alreadyExists(tx: TenantTx, error: ApiError): Promise<ApiError> {
    const meta = (error.extensions.meta ?? {}) as { existingDocumentId?: string };
    const existingId = meta.existingDocumentId ?? null;
    const existing =
      existingId === null
        ? undefined
        : (await this.documents.documentStatesIn(tx, [existingId])).get(existingId);
    return new ApiError('DOCUMENT_ALREADY_EXISTS', {
      detail: DFD_MESSAGES.alreadyExists(existing?.code ?? null),
      extensions:
        existing === undefined
          ? {}
          : {
              meta: {
                existingDocumentId: existing.id,
                existingDfdId: existing.id,
                code: existing.code,
              },
            },
    });
  }
}

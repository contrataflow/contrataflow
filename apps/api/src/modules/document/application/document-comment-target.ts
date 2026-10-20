import type { Confidentiality, DocumentStatus } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';

/*
 * Documento como alvo de comentário (US-071 · RN-CMT-01/13): o `collaboration` (nível 4) pergunta
 * ao dono do documento, por LEITURA, se o documento existe no processo, o status (cancelado → 409),
 * o sigilo (POL-09 no mascaramento) e as chaves de seção da versão de template (documento externo
 * não tem seções). A visibilidade do processo é conferida por quem chama.
 */

export interface CommentDocumentTarget {
  readonly id: string;
  readonly processId: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly confidentiality: Confidentiality;
  /** Chaves de seção do template do documento; `null` = documento externo (`UPLOADED`). */
  readonly sectionKeys: readonly string[] | null;
}

export interface CommentDocumentLabel {
  readonly code: string | null;
  readonly title: string;
  readonly confidentiality: Confidentiality;
}

@Injectable()
export class DocumentCommentTargets {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
  ) {}

  /** `null` = inexistente, excluído, de outro tenant (RLS) ou de outro processo (V-04). */
  async resolve(
    tx: TenantTx,
    processId: string,
    documentId: string,
  ): Promise<CommentDocumentTarget | null> {
    const document = await this.documents.findById(tx, documentId);
    if (document?.processId !== processId) return null;
    const template =
      document.templateVersionId === null
        ? null
        : await this.templates.findVersionById(tx, document.templateVersionId);
    return {
      id: document.id,
      processId: document.processId,
      code: document.code,
      title: document.title,
      status: document.status,
      confidentiality: document.confidentiality,
      sectionKeys: template === null ? null : template.sections.map((section) => section.key),
    };
  }

  /** Código, título e sigilo ATUAL (inclusive excluídos — o comentário já existe). */
  async labels(tx: TenantTx, ids: readonly string[]): Promise<Map<string, CommentDocumentLabel>> {
    const labels = await this.documents.labels(tx, ids);
    return new Map(
      [...labels].map(([id, label]) => [
        id,
        { code: label.code, title: label.title, confidentiality: label.confidentiality },
      ]),
    );
  }
}

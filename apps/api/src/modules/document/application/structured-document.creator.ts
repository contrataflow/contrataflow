import type { DocumentAction, SystemDocumentModule } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type { DocumentProcessContext } from '#shared/document/document-process-context.js';
import { validationError } from '#shared/errors/api-error.js';

import { DocumentCreationService } from './document-creation.service.js';
import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { DOCUMENT_CLOCK, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentClock, DocumentTypeRepository } from './ports.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import type { DocumentTemplateVersion } from '../domain/document-template.js';
import type { DocumentType } from '../domain/document-type.js';
import type { Document } from '../domain/document.js';
import { initialDraftContent } from '../domain/structured-draft.js';

/*
 * Padrão de documento tipado (US-014 · "Impacto técnico" · DEC-016/017/028): o módulo dono (DFD;
 * depois ETP, TR, pesquisa de preços, mapa de riscos) chama `DocumentFacade.createStructuredIn` no
 * `tx` do seu caso de uso e, em seguida, grava o cabeçalho tipado no MESMO `tx`. Aqui, na ordem do
 * fluxo principal 4.1–4.7: processo visível (404) → template ativo do tipo com versão publicada
 * (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `templateId`) → permissão de criação do tipo
 * cobrindo o processo (403 + `access.denied`) → custódia (POL-01 — 403 `NOT_PROCESS_CUSTODIAN`;
 * participação não cria) → processo editável (409) → tipo na etapa (422) → a fábrica única
 * (`DocumentCreationService`: singular 409, número na mesma transação, `document.create`,
 * `DocumentCreated` e a timeline síncrona).
 */

export interface CreateStructuredDocumentInput {
  readonly processId: string;
  readonly systemModule: SystemDocumentModule;
  /** Template escolhido (FA-01); ausente = o padrão do tipo (RN-DFD-03). */
  readonly templateId?: string | null;
  /** Título do documento a partir do processo (RN-DFD-06). */
  readonly titleOf: (process: DocumentProcessContext) => string;
  /** Mensagens do módulo dono (V-01 e 403 da custódia). */
  readonly messages: { readonly templateInvalid: string; readonly notCustodian: string };
  readonly idempotencyKey: string | null;
}

export interface CreatedStructuredDocument {
  readonly document: Document;
  readonly type: DocumentType;
  readonly template: DocumentTemplateVersion;
  readonly process: DocumentProcessContext;
  readonly allowedActions: DocumentAction[];
}

@Injectable()
export class StructuredDocumentCreator {
  constructor(
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly creation: DocumentCreationService,
  ) {}

  async create(
    tx: TenantTx,
    input: CreateStructuredDocumentInput,
  ): Promise<CreatedStructuredDocument> {
    const type = (await this.types.list(tx)).find(
      (candidate) => candidate.systemModule === input.systemModule,
    );
    if (type === undefined)
      throw new Error(`Tipo de sistema ${input.systemModule} ausente no tenant.`);
    const { process } = await this.lifecycle.creationContext(tx, input.processId, type.id);
    if (!type.isActive) {
      throw validationError([
        {
          field: 'templateId',
          code: 'REFERENCE_INACTIVE',
          message: input.messages.templateInvalid,
        },
      ]);
    }
    const template = await this.publishedTemplate(tx, type, input);
    const custody = await this.lifecycle.custodyOf(process);
    // POL-02 da criação com a custódia de POL-01: a participação edita, mas não cria (RN-DFD-02).
    await this.lifecycle.authorizeCreateAsCustodian(
      { type, process },
      custody,
      input.messages.notCustodian,
    );

    const userId = custody.userId;
    const document = await this.creation.create(tx, {
      processId: process.id,
      documentTypeId: type.id,
      title: input.titleOf(process),
      templateVersionId: template.id,
      draftContent: initialDraftContent(template.sections, {
        actorId: userId,
        now: this.clock(),
        variables: {
          'process.code': process.code ?? '',
          'process.title': process.title,
          'process.object': process.object,
          'organization.name': process.organizationName ?? '',
        },
      }),
      responsibleId: userId,
      idempotencyKey: input.idempotencyKey,
    });
    const created = { document, type, template, process };
    const actor = await this.lifecycle.actorOf(created);
    return { ...created, allowedActions: this.lifecycle.allowedActions(created, actor) };
  }

  /** RN-DFD-03 · V-01: template ativo do tipo com versão publicada (o padrão do tipo sem escolha). */
  private async publishedTemplate(
    tx: TenantTx,
    type: DocumentType,
    input: CreateStructuredDocumentInput,
  ): Promise<DocumentTemplateVersion> {
    const templateId = input.templateId ?? type.defaultTemplateId;
    const invalid = (code: 'REFERENCE_NOT_FOUND' | 'REFERENCE_INACTIVE') =>
      validationError([{ field: 'templateId', code, message: input.messages.templateInvalid }]);
    if (templateId === null) throw invalid('REFERENCE_NOT_FOUND');
    const template = await this.templates.findById(tx, templateId);
    if (template?.documentTypeId !== type.id) throw invalid('REFERENCE_NOT_FOUND');
    if (!template.isActive || template.currentPublishedVersionId === null) {
      throw invalid('REFERENCE_INACTIVE');
    }
    const version = await this.templates.findVersionById(tx, template.currentPublishedVersionId);
    if (version?.status !== 'PUBLISHED') throw invalid('REFERENCE_INACTIVE');
    return version;
  }
}

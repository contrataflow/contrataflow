import type {
  Confidentiality,
  DocumentAction,
  DraftContent,
  RichTextDocValue,
  SystemDocumentModule,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { AuditChange } from '#shared/audit/audit-trail.js';
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
import {
  draftContentFromSource,
  initialDraftContent,
  withSectionContents,
} from '../domain/structured-draft.js';

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
  /**
   * Sigilo do documento a partir do processo (US-024 · RN-PRICE-08: `RESTRICTED` com orçamento
   * sigiloso); ausente ou `undefined` = o sigilo padrão do tipo.
   */
  readonly confidentialityOf?: (process: DocumentProcessContext) => Confidentiality | undefined;
  /**
   * Regra do módulo dono conferida DEPOIS da autorização e ANTES de qualquer gravação (US-024 ·
   * RN-PRICE-02: processo sem itens → 422 só para quem pode criar; nada numerado).
   */
  readonly beforeCreate?: (process: DocumentProcessContext) => void | Promise<void>;
  /** Metadados do módulo dono acrescentados ao `document.create` (ex.: snapshot da pesquisa). */
  readonly auditMetadata?: Readonly<Record<string, unknown>>;
  /** `changes` do `document.create` (US-019: `importedFromDfdVersionId`). */
  readonly auditChanges?: readonly AuditChange[];
  /**
   * POL-02 da criação com participação (US-019 · RN-ETP-07): custódia OU participação
   * `COLLABORATOR`/`CONSULTANT` cria (403 `PERMISSION_DENIED` sem nenhuma das duas). Ausente = só
   * a custódia (POL-01 — DFD, pesquisa de preços).
   */
  readonly allowCollaborators?: boolean;
  /**
   * Conteúdo de seções do template preenchido na criação (US-019 · RN-ETP-05: importação do DFD),
   * por chave; a seção nasce `FILLED`. Chave que o template não tem é ignorada.
   */
  readonly sectionContents?: Readonly<Record<string, RichTextDocValue>>;
  /**
   * Duplicação (US-018): documento de origem — vira `sourceDocumentId` (DEC-017) e o conteúdo das
   * suas seções é copiado para o rascunho do template (`draftContentFromSource`).
   */
  readonly source?: { readonly documentId: string; readonly draftContent: DraftContent };
}

/** Modelo publicado do tipo para o diálogo de criação (US-036 · FA-01). */
export interface PublishedTemplateOption {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly versionId: string;
  readonly versionNumber: number;
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
    if (input.allowCollaborators === true) {
      // RN-ETP-07: custódia ou participação COLLABORATOR/CONSULTANT.
      await this.lifecycle.authorizeCreate({ type, process }, custody);
    } else {
      // POL-02 da criação com a custódia de POL-01: a participação edita, mas não cria (RN-DFD-02).
      await this.lifecycle.authorizeCreateAsCustodian(
        { type, process },
        custody,
        input.messages.notCustodian,
      );
    }

    await input.beforeCreate?.(process);
    const userId = custody.userId;
    const confidentiality = input.confidentialityOf?.(process);
    const now = this.clock();
    const initial = initialDraftContent(template.sections, {
      actorId: userId,
      now,
      variables: {
        'process.code': process.code ?? '',
        'process.title': process.title,
        'process.object': process.object,
        'organization.name': process.organizationName ?? '',
      },
    });
    const seeded =
      input.sectionContents === undefined
        ? initial
        : withSectionContents(initial, input.sectionContents, { actorId: userId, now });
    const document = await this.creation.create(tx, {
      processId: process.id,
      documentTypeId: type.id,
      title: input.titleOf(process),
      templateVersionId: template.id,
      draftContent:
        input.source === undefined
          ? seeded
          : draftContentFromSource(seeded, input.source.draftContent, { actorId: userId, now }),
      ...(input.source === undefined ? {} : { sourceDocumentId: input.source.documentId }),
      responsibleId: userId,
      ...(confidentiality === undefined ? {} : { confidentiality }),
      idempotencyKey: input.idempotencyKey,
      ...(input.auditMetadata === undefined ? {} : { auditMetadata: input.auditMetadata }),
      ...(input.auditChanges === undefined ? {} : { auditChanges: input.auditChanges }),
    });
    const created = { document, type, template, process };
    const actor = await this.lifecycle.actorOf(created);
    return { ...created, allowedActions: this.lifecycle.allowedActions(created, actor) };
  }

  /**
   * Templates ativos do tipo do módulo com versão publicada (US-036 · FA-01), o padrão do tipo
   * primeiro e os demais por nome; tipo inativo = nenhum (a criação recusaria).
   */
  async publishedTemplates(
    tx: TenantTx,
    systemModule: SystemDocumentModule,
  ): Promise<PublishedTemplateOption[]> {
    const type = (await this.types.list(tx)).find(
      (candidate) => candidate.systemModule === systemModule,
    );
    if (type?.isActive !== true) return [];
    const { items } = await this.templates.list(tx, {
      documentTypeId: type.id,
      isActive: true,
      skip: 0,
      take: 100,
    });
    const options: PublishedTemplateOption[] = [];
    for (const template of items) {
      if (template.currentPublishedVersionId === null) continue;
      const version = await this.templates.findVersionById(tx, template.currentPublishedVersionId);
      if (version?.status !== 'PUBLISHED') continue;
      options.push({
        id: template.id,
        name: template.name,
        isDefault: template.id === type.defaultTemplateId,
        versionId: version.id,
        versionNumber: version.versionNumber,
      });
    }
    return options.sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, 'pt-BR'),
    );
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

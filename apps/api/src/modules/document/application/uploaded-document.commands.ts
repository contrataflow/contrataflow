import { DOCUMENT_MESSAGES, DOCUMENT_VERSION_MESSAGES } from '@contrataflow/validation';
import type {
  DocumentAction,
  DocumentTemplateMetaDto,
  DocumentVersionDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { AttachmentFileRegistry } from '#shared/files/attachment-files.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DocumentCreationService } from './document-creation.service.js';
import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext } from './document-lifecycle.service.js';
import { toDocumentVersionDto } from './document-version.view.js';
import { recordDocumentVersion } from './document.commands.js';
import { toDocumentTemplateMeta } from './document.view.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { publishedDefaultTemplate } from './published-default-template.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { DocumentType } from '../domain/document-type.js';
import { DocumentTransitionError, recordManualVersion } from '../domain/document.js';
import type { Document } from '../domain/document.js';
import { initialDraftContent, processTemplateVariables } from '../domain/structured-draft.js';
import { uploadedVersionFile } from '../domain/uploaded-version.js';

/*
 * Documento externo (US-064 · DEC-017 · DEC-136): DOC-02 cria a "casca" `UPLOADED` em `DRAFT`, sem
 * versão; DOC-19 transforma um anexo `AVAILABLE` (intenção ATT-02 → PUT → ATT-03 → `file-scan`)
 * numa nova `DocumentVersion` `UPLOAD`. Os dois numa ÚNICA transação do tenant, com auditoria e
 * outbox (timeline síncrona) antes do commit. O texto livre (`changeSummary`) nunca vai para log,
 * auditoria nem evento; o nome do arquivo também não.
 */

let uploadCounter: Counter | undefined;

/** `cf_document_upload_versions_total{result}`: versões por upload e recusas por arquivo indisponível. */
function recordUploadResult(result: 'created' | 'not_available'): void {
  uploadCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_document_upload_versions_total', {
      description:
        'Versões de documento externo por upload (DOC-19) e recusas por anexo indisponível.',
    });
  uploadCounter.add(1, { result });
}

// --- DOC-02 — Criar documento no processo ------------------------------------------------------

let createdCounter: Counter | undefined;

/** `cf_documents_created_total{kind}`: documentos criados pelo DOC-02 (DoD da US-063/US-064). */
function recordCreated(kind: DocumentType['kind']): void {
  createdCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_documents_created_total', {
      description: 'Documentos livres e externos criados pelo DOC-02, por kind.',
    });
  createdCounter.add(1, { kind });
}

export interface CreateProcessDocumentInput {
  readonly processId: string;
  readonly documentTypeId: string;
  readonly title: string;
  readonly responsibleId: string | null;
  readonly idempotencyKey: string | null;
}

export interface CreatedProcessDocument {
  readonly document: Document;
  readonly type: DocumentType;
  readonly allowedActions: DocumentAction[];
  /** `meta.template` (US-063): a versão do template fixada no documento livre; `null` no externo. */
  readonly template: DocumentTemplateMetaDto | null;
}

const TYPE_MESSAGE = DOCUMENT_MESSAGES.typeInvalid;

/** Os `kind` que o DOC-02 cria; `STRUCTURED` nasce pelos endpoints do módulo tipado. */
const CREATABLE_KINDS: ReadonlySet<DocumentType['kind']> = new Set(['UPLOADED', 'FREE_TEXT']);

/**
 * `CreateProcessDocumentCommand` — DOC-02 (RN-DOC-31/32 · POL-02), na ordem: processo visível
 * (404) → tipo ativo do tenant de `kind` aceito (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) →
 * `DOCUMENT_CREATE` cobrindo o processo + custódia ou participação (403) → processo editável (409)
 * → tipo na etapa (422) → responsável com vínculo ativo (422) → a fábrica única
 * (`DocumentCreationService`: singular 409, número, `document.create`, `DocumentCreated`).
 * `UPLOADED` (US-064) nasce sem versão nem template (`currentVersionId = null`); `FREE_TEXT`
 * (US-063 · RN-DOC-21..26) nasce da versão publicada do template padrão do tipo — sem ela, 422
 * `REFERENCE_INACTIVE` em `documentTypeId` (RN-DOC-22), conferido DEPOIS da autorização — com uma
 * seção do rascunho por `SectionDefinition` (`revision = 1`; `FILLED` com `defaultContent` de
 * variáveis resolvidas, senão `EMPTY` — RN-DOC-23).
 */
@Injectable()
export class CreateProcessDocumentCommand extends TransactionalCommandHandler<
  CreateProcessDocumentInput,
  undefined,
  CreatedProcessDocument
> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly creation: DocumentCreationService,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly identity: IdentityFacade,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
  ) {
    super('document.create', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(
    tx: TenantTx,
    input: CreateProcessDocumentInput,
  ): Promise<CreatedProcessDocument> {
    const { process, type } = await this.lifecycle.creationContext(
      tx,
      input.processId,
      input.documentTypeId,
    );
    if (type === null || !CREATABLE_KINDS.has(type.kind)) {
      throw validationError([
        { field: 'documentTypeId', code: 'REFERENCE_NOT_FOUND', message: TYPE_MESSAGE },
      ]);
    }
    if (!type.isActive) {
      throw validationError([
        { field: 'documentTypeId', code: 'REFERENCE_INACTIVE', message: TYPE_MESSAGE },
      ]);
    }
    const custody = await this.lifecycle.custodyOf(process);
    await this.lifecycle.authorizeCreate({ type, process }, custody);
    const template =
      type.kind === 'FREE_TEXT' ? await publishedDefaultTemplate(tx, this.templates, type) : null;
    if (type.kind === 'FREE_TEXT' && template === null) {
      throw validationError([
        {
          field: 'documentTypeId',
          code: 'REFERENCE_INACTIVE',
          message: DOCUMENT_MESSAGES.templateNotPublished,
        },
      ]);
    }
    if (input.responsibleId !== null) await this.assertResponsible(tx, input.responsibleId);

    const document = await this.creation.create(tx, {
      processId: process.id,
      documentTypeId: type.id,
      title: input.title,
      templateVersionId: template?.id ?? null,
      ...(template === null
        ? {}
        : {
            draftContent: initialDraftContent(template.sections, {
              actorId: custody.userId,
              now: this.clock(),
              variables: processTemplateVariables(process),
            }),
          }),
      ...(input.responsibleId === null ? {} : { responsibleId: input.responsibleId }),
      idempotencyKey: input.idempotencyKey,
    });
    const context: DocumentContext = { document, type, template, process };
    const actor = await this.lifecycle.actorOf(context);
    return {
      document,
      type,
      allowedActions: this.lifecycle.allowedActions(context, actor),
      template: toDocumentTemplateMeta(template),
    };
  }

  protected override committed(result: CreatedProcessDocument, durationMs: number): void {
    recordCreated(result.type.kind);
    this.logger.log(
      {
        event: 'document.created',
        documentId: result.document.id,
        documentTypeCode: result.type.code,
        code: result.document.code,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'document.created',
    );
  }

  /** Responsável com vínculo ativo (e não vencido) no tenant — senão 422 (como o DOC-04). */
  private async assertResponsible(tx: TenantTx, userId: string): Promise<void> {
    const membership = await this.identity.membershipOfUser(tx, userId);
    const active =
      membership !== null &&
      membership.status === 'ACTIVE' &&
      (membership.expiresAt === null || membership.expiresAt.getTime() > this.clock().getTime());
    if (!active) {
      throw validationError([
        {
          field: 'responsibleId',
          code: membership === null ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_INACTIVE',
          message: 'Escolha um responsável com acesso ativo ao órgão.',
        },
      ]);
    }
  }
}

// --- DOC-19 — Enviar nova versão do arquivo ----------------------------------------------------

export interface UploadDocumentVersionInput {
  readonly documentId: string;
  /** `If-Match` (versão do documento). */
  readonly expectedVersion: number;
  readonly attachmentId: string;
  readonly changeSummary: string | null;
}

/**
 * `UploadDocumentVersionCommand` — DOC-19 (RN-DOC-33/34/38/39 · DEC-084), numa transação curta:
 * travar a linha do documento (`FOR UPDATE` — dois envios simultâneos serializam e viram versões
 * consecutivas, sem colisão) → carregar (404) → POL-02 de edição: `DOCUMENT_UPDATE` cobrindo o
 * processo + custódia/participação (403), processo editável (409), tipo na etapa (422) → tipo
 * `UPLOADED` (422 `NOT_ALLOWED`) → `If-Match` (412) → documento em `DRAFT`/`RETURNED` (409
 * `DOCUMENT_NOT_EDITABLE`) → anexo do PRÓPRIO documento (422 `REFERENCE_NOT_FOUND` — inclusive de
 * outro tenant) e `AVAILABLE` (409 `ATTACHMENT_NOT_AVAILABLE` — P3) → documento apontando a versão
 * nova (status inalterado) → `DocumentVersion` `UPLOAD` (`content` nulo, hash = SHA-256 do arquivo)
 * → `document.version_create` → `DocumentVersionCreated` → commit.
 */
@Injectable()
export class UploadDocumentVersionCommand extends TransactionalCommandHandler<
  UploadDocumentVersionInput,
  undefined,
  DocumentVersionDto
> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    private readonly lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly files: AttachmentFileRegistry,
    private readonly identity: IdentityFacade,
  ) {
    super('document.upload_version', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(
    tx: TenantTx,
    input: UploadDocumentVersionInput,
  ): Promise<DocumentVersionDto> {
    await this.lifecycle.lockForVersioning(tx, input.documentId);
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    const { document, type } = context;
    if (type.kind !== 'UPLOADED') {
      throw validationError([
        { field: 'kind', code: 'NOT_ALLOWED', message: DOCUMENT_VERSION_MESSAGES.notUploaded },
      ]);
    }
    this.lifecycle.assertVersion(context, input.expectedVersion);

    const actorId = actor.userId;
    if (actorId === '') throw new ApiError('UNAUTHENTICATED');
    const now = this.clock();
    const versionNumber = await this.lifecycle.nextVersionNumber(tx, document.id);
    const versionId = newId();
    let next: Document;
    try {
      // A mesma transição do "Salvar versão": só em edição, aponta a versão nova, status igual.
      next = recordManualVersion(document, { actorId, now, versionId, versionNumber });
    } catch (error) {
      if (error instanceof DocumentTransitionError) {
        throw new ApiError('DOCUMENT_NOT_EDITABLE', {
          detail: DOCUMENT_VERSION_MESSAGES.uploadNotEditable,
          extensions: { status: document.status },
        });
      }
      throw error;
    }
    const decision = uploadedVersionFile(
      await this.files.find(tx, input.attachmentId),
      document.id,
    );
    if (!decision.ok) {
      if (decision.refusal === 'NOT_FOUND') {
        throw validationError([
          {
            field: 'attachmentId',
            code: 'REFERENCE_NOT_FOUND',
            message: DOCUMENT_VERSION_MESSAGES.attachmentNotFound,
          },
        ]);
      }
      this.logger.warn(
        {
          event: 'document.upload_version_not_available',
          documentId: document.id,
          attachmentId: input.attachmentId,
          correlationId: requireRequestContext().correlationId,
        },
        'document.upload_version_not_available',
      );
      recordUploadResult('not_available');
      throw new ApiError('ATTACHMENT_NOT_AVAILABLE', {
        detail: DOCUMENT_VERSION_MESSAGES.attachmentNotAvailable,
      });
    }

    // Com a linha travada a `version` lida é a atual: a gravação condicionada não perde corrida.
    const saved = await this.lifecycle.save(tx, next, document.version);
    const version = await this.lifecycle.createVersion(tx, context, {
      document: saved,
      versionId,
      versionNumber,
      reason: 'UPLOAD',
      actorId,
      now,
      changeSummary: input.changeSummary,
      file: decision.file,
    });
    await recordDocumentVersion(this.audit, this.outbox, tx, context, version);
    const names = await this.identity.userDisplayNames(tx, [actorId]);
    return toDocumentVersionDto(version, type.kind, null, names);
  }

  protected override committed(result: DocumentVersionDto, durationMs: number): void {
    recordUploadResult('created');
    this.logger.log(
      {
        event: 'document.version_uploaded',
        documentId: result.documentId,
        documentVersionId: result.id,
        versionNumber: result.versionNumber,
        reason: result.reason,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'document.version_uploaded',
    );
  }
}

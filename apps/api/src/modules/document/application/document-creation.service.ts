import { DocumentCreated, EMPTY_DRAFT_CONTENT } from '@contrataflow/validation';
import type { Confidentiality, DraftContent } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { documentAlreadyExists } from './document.errors.js';
import { DOCUMENT_REPOSITORY, DocumentAlreadyExistsError } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { DOCUMENT_CLOCK, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentClock, DocumentTypeRepository } from './ports.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { newDocument } from '../domain/document.js';
import type { Document } from '../domain/document.js';

/** Dados da criação (DOC-02 — US-063/064 — e criações tipadas — DFD/ETP/TR…). */
export interface CreateDocumentInput {
  readonly processId: string;
  readonly documentTypeId: string;
  readonly title: string;
  /** Versão publicada do template (`null` para `UPLOADED`). */
  readonly templateVersionId: string | null;
  /** Rascunho inicial (seções do template já resolvidas pelo chamador). */
  readonly draftContent?: DraftContent;
  /** Padrão: o criador. */
  readonly responsibleId?: string | null;
  readonly sourceDocumentId?: string | null;
  /** Padrão: o sigilo padrão do tipo. */
  readonly confidentiality?: Confidentiality;
  readonly idempotencyKey?: string | null;
  /** Metadados do módulo tipado acrescentados ao `document.create` (US-024: snapshot e itens). */
  readonly auditMetadata?: Readonly<Record<string, unknown>>;
}

/**
 * Criação do documento (US-065 · RN-DOC-50 · DEC-019/028): o ÚNICO ponto que aplica a singularidade
 * por tipo e a numeração — reaproveitado pelo DOC-02 (US-063/US-064) e pelos módulos tipados, no
 * `tx` do caso de uso deles. Tipo singular com documento ativo → 409 `DOCUMENT_ALREADY_EXISTS`
 * (verificação prévia para a mensagem; o índice único parcial decide a corrida). O número é
 * atribuído por último (a linha da sequência fica travada só pelas gravações). Grava
 * `document.create` e `DocumentCreated` (timeline `DOCUMENT_CREATED`). A autorização (permissão de
 * criação do tipo + POL-02) e a etapa são de quem chama.
 */
@Injectable()
export class DocumentCreationService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly numbering: NumberingFacade,
  ) {}

  async create(tx: TenantTx, input: CreateDocumentInput): Promise<Document> {
    const context = requireRequestContext();
    const userId = context.actor.userId;
    if (userId === null || context.tenantId === null) throw new ApiError('UNAUTHENTICATED');
    const type = await this.types.findById(tx, input.documentTypeId);
    if (type?.isActive !== true) {
      throw validationError([
        {
          field: 'documentTypeId',
          code: type === null ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_INACTIVE',
          message: 'Escolha um tipo de documento ativo.',
        },
      ]);
    }
    const process = await this.processes.load(tx, input.processId);
    if (process === null) throw new ApiError('NOT_FOUND', { detail: 'Processo não encontrado.' });
    if (!type.allowMultiplePerProcess) {
      const existing = await this.documents.findActiveOfType(tx, process.id, type.id);
      if (existing !== null) throw documentAlreadyExists(existing.id);
    }
    const numbering = type.numberingEnabled
      ? await this.numbering.assignDocumentNumber(tx, {
          documentTypeCode: type.code,
          typeMask: type.numberingMask,
          organizationId: process.organizationId,
        })
      : null;
    const document = newDocument({
      id: newId(),
      tenantId: context.tenantId,
      processId: process.id,
      type,
      ...(input.confidentiality === undefined ? {} : { confidentiality: input.confidentiality }),
      templateVersionId: input.templateVersionId,
      title: input.title,
      draftContent: input.draftContent ?? EMPTY_DRAFT_CONTENT,
      numbering,
      responsibleId: input.responsibleId ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      createdById: userId,
      now: this.clock(),
    });
    try {
      await this.documents.insert(tx, document);
    } catch (error) {
      if (error instanceof DocumentAlreadyExistsError) throw documentAlreadyExists(null);
      throw error;
    }
    await this.audit.record(tx, {
      action: 'document.create',
      entityType: 'Document',
      entityId: document.id,
      processId: document.processId,
      metadata: {
        documentTypeCode: type.code,
        templateVersionId: document.templateVersionId,
        code: document.code,
        ...input.auditMetadata,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
    await this.outbox.record(
      tx,
      DocumentCreated.of({
        aggregateId: document.id,
        processId: document.processId,
        payload: {
          documentId: document.id,
          documentTypeCode: type.code,
          kind: type.kind,
          code: document.code,
          title: document.title,
          templateVersionId: document.templateVersionId,
          sourceDocumentId: document.sourceDocumentId,
        },
      }),
    );
    return document;
  }
}

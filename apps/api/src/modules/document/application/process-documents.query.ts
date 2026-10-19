import type { PermissionCode } from '@contrataflow/types';
import { PROCESS_DOCUMENTS_MESSAGES } from '@contrataflow/validation';
import type {
  ProcessDocumentDto,
  ProcessDocumentsMeta,
  ProcessDocumentsQuery,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';

import { isProcessVisible } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { isTransientDatabaseError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import type { DocumentProcessContext } from '#shared/document/document-process-context.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { ResolvedDocumentActor } from './document-lifecycle.service.js';
import { DocumentTypeFacade } from './document-type.facade.js';
import { panelProcessNotFound } from './document.errors.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { toDocumentDto } from './document.view.js';
import { DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentTransactions } from './ports.js';
import { publishedDefaultTemplate } from './published-default-template.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { maskConfidentialRecord } from '../domain/confidential-snapshot.js';
import { createPermissionOf } from '../domain/document-permissions.js';
import type { DocumentType } from '../domain/document-type.js';
import { DOCUMENT_EDITABLE_PROCESS_STATUSES } from '../domain/document.js';
import type { Document } from '../domain/document.js';
import {
  filterPanelDocuments,
  panelTypes,
  sortPanelDocuments,
} from '../domain/process-documents-panel.js';

let panelDuration: Histogram | undefined;

/** `cf_document_panel_duration_ms{result}` — carregamento do painel (DoD da US-062: p95 < 500 ms). */
function recordPanelDuration(durationMs: number, result: 'ok' | 'error'): void {
  panelDuration ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('cf_document_panel_duration_ms', {
      description: 'Duração do carregamento do painel de documentos do processo (DOC-01).',
      unit: 'ms',
    });
  panelDuration.record(durationMs, { result });
}

export interface ProcessDocumentsResult {
  readonly items: ProcessDocumentDto[];
  readonly meta: ProcessDocumentsMeta;
}

/**
 * `GetProcessDocumentsHandler` — DOC-01 (US-062 · RN-DOC-13..20): documentos do processo visível
 * (inclusive cancelados) agrupáveis por tipo, cada um com `meta.allowedActions` (a mesma função
 * pura do DOC-03 — RN-DOC-18) e o resumo tipado sob POL-09 (RN-DOC-17), mais os tipos que a etapa
 * atual admite (menu "Criar documento" e singulares "Não iniciado"). Uma consulta de documentos;
 * os tipos vêm do cache de DTY-01 (Redis fora → banco, `warn document_type.cache_unavailable`).
 * Somente leitura: sem auditoria (exceto a negação de `PROCESS_VIEW`) nem eventos.
 */
@Injectable()
export class GetProcessDocumentsHandler {
  private readonly logger = new Logger('DocumentPanel');

  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly types: DocumentTypeFacade,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
  ) {}

  async execute(processId: string, query: ProcessDocumentsQuery): Promise<ProcessDocumentsResult> {
    const started = performance.now();
    try {
      const result = await this.load(processId, query);
      const durationMs = Math.round(performance.now() - started);
      recordPanelDuration(durationMs, 'ok');
      this.logger.log(
        {
          event: 'document_panel.loaded',
          processId,
          documentCount: result.items.length,
          durationMs,
        },
        'document_panel.loaded',
      );
      return result;
    } catch (error) {
      recordPanelDuration(Math.round(performance.now() - started), 'error');
      if (!(error instanceof ApiError) || error.status >= 500) {
        this.logger.error(
          {
            event: 'document_panel.load_failed',
            errorCode:
              error instanceof ApiError
                ? error.code
                : isTransientDatabaseError(error)
                  ? 'DEPENDENCY_UNAVAILABLE'
                  : 'INTERNAL_ERROR',
            correlationId: requireRequestContext().correlationId,
          },
          'document_panel.load_failed',
        );
      }
      throw error;
    }
  }

  private async load(
    processId: string,
    query: ProcessDocumentsQuery,
  ): Promise<ProcessDocumentsResult> {
    // Tipos antes da transação: o cache de DTY-01 lê o banco na própria transação quando falha.
    const allTypes = await this.types.listAll();
    const typesById = new Map(allTypes.map((type) => [type.id, type]));
    assertKnownTypes(query.type, typesById);
    const visibility = await this.access.processVisibilityScope();

    return this.transactions.read(async (tx) => {
      const process = await this.processes.load(tx, processId);
      if (process === null || !isProcessVisible(visibility, process.access)) {
        throw panelProcessNotFound();
      }
      const documents = await this.documents.listByProcess(tx, processId);
      const typeOf = (document: Document): DocumentType => {
        const type = typesById.get(document.documentTypeId);
        if (type === undefined) throw new Error(`Documento ${document.id} sem tipo no tenant.`);
        return type;
      };

      const actors = new Map<string, Promise<ResolvedDocumentActor>>();
      const actorFor = (type: DocumentType) => {
        const key = type.systemModule ?? '';
        let actor = actors.get(key);
        if (actor === undefined) {
          actor = this.lifecycle.actorOf({ type, process });
          actors.set(key, actor);
        }
        return actor;
      };
      const mask = await this.maskerFor(process, documents);

      const visible = sortPanelDocuments(
        filterPanelDocuments(documents, {
          typeIds: query.type,
          statuses: query.status,
          responsibleId: query.responsibleId,
          q: query.q,
        }),
        typeOf,
      );
      const names = await this.identity.userDisplayNames(tx, [
        ...new Set(visible.flatMap((document) => document.responsibleId ?? [])),
      ]);
      const items: ProcessDocumentDto[] = [];
      for (const document of visible) {
        const type = typeOf(document);
        const actor = await actorFor(type);
        const summary = await this.lifecycle.panelSummary(tx, document, type);
        const { draftContent: _content, ...dto } = toDocumentDto(document, type);
        items.push({
          ...dto,
          responsibleName:
            document.responsibleId === null ? null : (names.get(document.responsibleId) ?? null),
          summary: summary === null ? null : mask(document, summary),
          meta: {
            allowedActions: this.lifecycle.allowedActions(
              { document, type, template: null, process },
              actor,
            ),
          },
        });
      }
      return { items, meta: await this.metaOf(tx, process, allTypes, documents) };
    });
  }

  /**
   * POL-09 (RN-DOC-17): o resumo de documento `RESTRICTED` — ou de processo com orçamento
   * sigiloso — sai com os campos monetários mascarados para quem não tem
   * `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo (nem a custódia). Avaliado uma vez.
   */
  private async maskerFor(
    process: DocumentProcessContext,
    documents: readonly Document[],
  ): Promise<
    (document: Document, summary: Readonly<Record<string, unknown>>) => Record<string, unknown>
  > {
    const sensitive = (document: Document) =>
      document.confidentiality === 'RESTRICTED' || process.isBudgetConfidential;
    const canView =
      !documents.some(sensitive) || (await this.lifecycle.canViewConfidentialBudget({ process }));
    return (document, summary) =>
      !canView && sensitive(document) ? maskConfidentialRecord(summary) : { ...summary };
  }

  /**
   * RN-DOC-13/14/16: etapa atual, menu "Criar documento" e singulares "Não iniciado". O livre só
   * entra no menu com template padrão publicado (US-063 · FA-05 · RN-DOC-22 — a mesma regra do DOC-02).
   */
  private async metaOf(
    tx: TenantTx,
    process: DocumentProcessContext,
    allTypes: readonly DocumentType[],
    documents: readonly Document[],
  ): Promise<ProcessDocumentsMeta> {
    const stage = process.currentStage;
    const custody = await this.lifecycle.custodyOf(process);
    const pol02 = custody.isCustodian || custody.isCollaborator;
    const permissions = new Map<PermissionCode, boolean>();
    for (const type of allTypes) {
      const permission = createPermissionOf(type.systemModule);
      if (!permissions.has(permission)) {
        permissions.set(permission, await this.access.canOnProcess(permission, process.access));
      }
    }
    const withoutTemplate = new Set<string>();
    if (pol02) {
      for (const type of allTypes) {
        if (type.kind !== 'FREE_TEXT' || !type.isActive) continue;
        if ((await publishedDefaultTemplate(tx, this.templates, type)) === null) {
          withoutTemplate.add(type.id);
        }
      }
    }
    const { creatableTypeIds, pendingTypeIds } = panelTypes({
      types: allTypes,
      stage,
      processEditable: DOCUMENT_EDITABLE_PROCESS_STATUSES.has(process.status),
      documents,
      canCreate: (type) =>
        pol02 &&
        !withoutTemplate.has(type.id) &&
        permissions.get(createPermissionOf(type.systemModule)) === true,
    });
    return {
      currentStage:
        stage === null
          ? null
          : { key: stage.key, name: stage.name, documentTypeCodes: [...stage.documentTypeCodes] },
      creatableTypeIds,
      pendingTypeIds,
    };
  }
}

/** V-01: `type` fora do catálogo do tenant (inclusive inativos) → 422 `REFERENCE_NOT_FOUND`. */
function assertKnownTypes(
  typeIds: readonly string[] | undefined,
  typesById: ReadonlyMap<string, DocumentType>,
): void {
  if (typeIds === undefined || typeIds.every((id) => typesById.has(id))) return;
  throw validationError([
    {
      field: 'type',
      code: 'REFERENCE_NOT_FOUND',
      message: PROCESS_DOCUMENTS_MESSAGES.invalidFilter,
    },
  ]);
}

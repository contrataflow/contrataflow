import { createHash } from 'node:crypto';

import {
  calculationMemoBytes,
  calculationMemoIssue,
  DOCUMENT_ITEM_MESSAGES,
  richTextPlainText,
} from '@contrataflow/validation';
import type {
  DocumentItemDto,
  DocumentItemInput,
  RichTextDocValue,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';
import type { ProcessItemReference } from '#shared/process/process-item-catalog.js';
import type {
  ProcessItemUsage,
  ProcessItemUsageReader,
} from '#shared/process/process-item-usage.js';

import { DOCUMENT_ITEM_REPOSITORY } from './document-items.ports.js';
import type { DocumentItemRepository } from './document-items.ports.js';
import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext } from './document-lifecycle.service.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentClock, DocumentTransactions, DocumentTypeRepository } from './ports.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { planDocumentItems } from '../domain/document-items.js';
import type {
  AvailableProcessItem,
  DocumentItem,
  DocumentItemsPlan,
} from '../domain/document-items.js';
import { isEditable } from '../domain/document.js';
import type { Document } from '../domain/document.js';

/*
 * Itens de documento (US-014 · DOC-06/07 · DEC-019 · RN-DFD-14): a coleção dos documentos tipados
 * (DFD; ETP/TR com as stories donas) sobre os itens canônicos do processo — lidos pela porta
 * `ProcessItemCatalogRegistry` (o `process` está acima do `document`). DOC-07 substitui a coleção
 * inteira numa transação: documento travado (`FOR UPDATE`) → 404 → POL-02 de edição do tipo (403,
 * 409 `INVALID_PROCESS_STATUS`, 422 de etapa) → `If-Match` (412) → documento em `DRAFT`/`RETURNED`
 * (409 `DOCUMENT_NOT_EDITABLE`) → itens do processo travados `FOR SHARE` + regra da unidade (422)
 * → gravação → `version + 1` do documento (novo `ETag`) → `document.items_update`. Sem evento.
 * US-022 (ETP): a memória de cálculo por item (RN-ETP-27) é conferida antes de tudo (413
 * `PAYLOAD_TOO_LARGE` acima de 1 MB, 422 `RICH_TEXT_INVALID` fora do schema) e entra na auditoria
 * só como hash + tamanho; ids e `sortOrder` das linhas existentes se preservam.
 */

/** Itens do documento como o DOC-06/07 os devolve, com a versão do documento (`ETag`). */
export interface DocumentItemsResult {
  readonly items: DocumentItemDto[];
  readonly documentVersion: number;
}

/** Linha de item a copiar para um documento novo (`DocumentItemsPresenter.insertCopies`). */
export interface DocumentItemCopy {
  readonly processItemId: string;
  /** Decimal(18,4) como string. */
  readonly quantity: string;
  readonly notes: string | null;
}

/** Monta os DTOs: cada linha com o nº, a descrição e a unidade do item do processo. */
/** Linha de item no snapshot da versão (RN-DFD-40 — valores decimais como string). */
export interface DocumentItemSnapshotLine {
  readonly processItemId: string;
  readonly sequence: number;
  readonly lotNumber: number | null;
  readonly description: string;
  /** Rótulo da unidade no momento da versão. */
  readonly unit: string;
  readonly unitOfMeasureId: string;
  readonly quantity: string;
  readonly notes: string | null;
  readonly sortOrder: number;
}

@Injectable()
export class DocumentItemsPresenter {
  constructor(
    @Inject(DOCUMENT_ITEM_REPOSITORY) private readonly items: DocumentItemRepository,
    private readonly catalog: ProcessItemCatalogRegistry,
    private readonly catalogs: CatalogFacade,
  ) {}

  /** Linhas atuais do documento (para o validador do módulo tipado e o snapshot). */
  rowsOf(tx: TenantTx, documentId: string): Promise<DocumentItem[]> {
    return this.items.listByDocument(tx, documentId);
  }

  /** Itens do processo com linha já especificada no documento (US-037 · RN-TR-21). */
  specifiedOf(tx: TenantTx, documentId: string): Promise<ReadonlySet<string>> {
    return this.items.specifiedProcessItemIds(tx, documentId);
  }

  /**
   * Linhas de um documento recém-criado (duplicação — US-018 · RN-DFD-75): as quantidades e
   * observações já validadas na origem, apontando para os itens do processo de destino. Sem versão
   * nova nem auditoria própria (o documento nasce na mesma transação, em `version = 1`).
   */
  async insertCopies(
    tx: TenantTx,
    document: Pick<Document, 'id' | 'tenantId'>,
    lines: readonly DocumentItemCopy[],
  ): Promise<number> {
    const actorId = requireRequestContext().actor.userId;
    const now = new Date();
    const rows: DocumentItem[] = lines.map((line, index) => ({
      id: newId(),
      tenantId: document.tenantId,
      documentId: document.id,
      processItemId: line.processItemId,
      quantity: line.quantity,
      notes: line.notes,
      sortOrder: index,
      calculationMemo: null,
      createdAt: now,
      updatedAt: now,
      createdById: actorId,
      updatedById: actorId,
    }));
    await this.items.replace(tx, document.id, rows);
    return rows.length;
  }

  async present(tx: TenantTx, document: Document): Promise<DocumentItemDto[]> {
    const rows = await this.items.listByDocument(tx, document.id);
    if (rows.length === 0) return [];
    const processItems = new Map(
      (await this.catalog.listActive(tx, document.processId)).map((item) => [item.id, item]),
    );
    return this.toDtos(tx, rows, processItems);
  }

  /**
   * Linhas como o snapshot de versão as congela (US-016 · RN-DFD-40): o item do processo (número,
   * lote, descrição, unidade) com a quantidade deste documento, na ordem do documento.
   */
  async snapshotLinesOf(tx: TenantTx, document: Document): Promise<DocumentItemSnapshotLine[]> {
    const rows = await this.items.listByDocument(tx, document.id);
    if (rows.length === 0) return [];
    const processItems = new Map(
      (await this.catalog.listActive(tx, document.processId)).map((item) => [item.id, item]),
    );
    return (await this.toDtos(tx, rows, processItems)).map((dto) => ({
      processItemId: dto.processItemId,
      sequence: dto.sequence,
      lotNumber: processItems.get(dto.processItemId)?.lotNumber ?? null,
      description: dto.description,
      unit: dto.unit.label,
      unitOfMeasureId: dto.unit.id,
      quantity: dto.quantity,
      notes: dto.notes,
      sortOrder: dto.sortOrder,
    }));
  }

  async toDtos(
    tx: TenantTx,
    rows: readonly DocumentItem[],
    processItems: ReadonlyMap<string, ProcessItemReference>,
  ): Promise<DocumentItemDto[]> {
    const units = await this.catalogs.unitsOf(
      tx,
      [...processItems.values()].map((item) => item.unitOfMeasureId),
    );
    return rows.flatMap((row) => {
      const item = processItems.get(row.processItemId);
      if (item === undefined) return [];
      const unit = units.get(item.unitOfMeasureId);
      return [
        {
          processItemId: row.processItemId,
          sequence: item.sequence,
          description: item.description,
          unit: {
            id: item.unitOfMeasureId,
            label: unit?.label ?? '',
            allowsDecimal: unit?.allowsDecimal ?? true,
          },
          quantity: row.quantity,
          notes: row.notes,
          sortOrder: row.sortOrder,
          calculationMemo: row.calculationMemo,
        },
      ];
    });
  }
}

/** DOC-06 — `PROCESS_VIEW` na rota; documento não visível/de outro tenant → 404 (DEC-024). */
@Injectable()
export class DocumentItemsQuery {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly presenter: DocumentItemsPresenter,
  ) {}

  execute(documentId: string): Promise<DocumentItemsResult> {
    return this.transactions.read(async (tx) => {
      const { document } = await this.lifecycle.load(tx, documentId);
      return {
        items: await this.presenter.present(tx, document),
        documentVersion: document.version,
      };
    });
  }
}

export interface ReplaceDocumentItemsInput {
  readonly documentId: string;
  readonly items: readonly DocumentItemInput[];
  readonly expectedVersion: number;
}

interface ReplacedItems extends DocumentItemsResult {
  readonly documentId: string;
  readonly itemsCount: number;
}

/**
 * RN-ETP-27 · V-03: memória de cálculo acima de 1 MB → 413 `PAYLOAD_TOO_LARGE`; fora do schema →
 * 422 `RICH_TEXT_INVALID` (o primeiro problema da lista decide).
 */
function assertCalculationMemos(items: readonly DocumentItemInput[]): void {
  for (const item of items) {
    const issue = calculationMemoIssue(item.calculationMemo);
    if (issue === 'PAYLOAD_TOO_LARGE') {
      throw new ApiError('PAYLOAD_TOO_LARGE', {
        detail: DOCUMENT_ITEM_MESSAGES.calculationMemoTooLarge,
      });
    }
    if (issue === 'RICH_TEXT_INVALID') {
      throw new ApiError('RICH_TEXT_INVALID', {
        detail: DOCUMENT_ITEM_MESSAGES.calculationMemoInvalid,
      });
    }
  }
}

/** Impressão digital da memória na auditoria: hash do texto + tamanho serializado (nunca o texto). */
function memoFingerprint(
  memo: RichTextDocValue | null,
): { readonly sha256: string; readonly bytes: number } | null {
  if (memo === null) return null;
  return {
    sha256: createHash('sha256').update(richTextPlainText(memo), 'utf8').digest('hex'),
    bytes: calculationMemoBytes(memo),
  };
}

/** `ReplaceDocumentItemsCommand` — DOC-07 (RN-DFD-14 · V-09/V-10/V-11). */
@Injectable()
export class ReplaceDocumentItemsCommand extends TransactionalCommandHandler<
  ReplaceDocumentItemsInput,
  undefined,
  ReplacedItems
> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_ITEM_REPOSITORY) private readonly items: DocumentItemRepository,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly catalog: ProcessItemCatalogRegistry,
    private readonly catalogs: CatalogFacade,
    private readonly presenter: DocumentItemsPresenter,
  ) {
    super('document.items_update', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(tx: TenantTx, input: ReplaceDocumentItemsInput): Promise<ReplacedItems> {
    assertCalculationMemos(input.items);
    // A trava serializa duas gravações: a segunda relê a versão e recebe 412 (Concorrência).
    await this.documents.lockForUpdate(tx, input.documentId);
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    this.lifecycle.assertVersion(context, input.expectedVersion);
    if (!isEditable(context.document)) {
      throw new ApiError('DOCUMENT_NOT_EDITABLE', {
        detail: 'Este documento não pode mais ser editado.',
        extensions: { status: context.document.status },
      });
    }

    const { document } = context;
    const referenced = await this.catalog.lockForShare(
      tx,
      document.processId,
      input.items.map((item) => item.processItemId),
    );
    const processItems = new Map(referenced.map((item) => [item.id, item]));
    const available = await this.availability(tx, referenced);
    const current = await this.items.listByDocument(tx, document.id);
    const now = this.clock();
    const userId = actor.userId;
    const plan = planDocumentItems({
      tenantId: document.tenantId,
      documentId: document.id,
      current,
      next: input.items,
      available,
      actorId: userId,
      now,
      newId,
    });
    if (plan.errors.length > 0) throw validationError(plan.errors);

    await this.items.replace(tx, document.id, plan.items);
    const saved = await this.lifecycle.save(
      tx,
      { ...document, updatedAt: now, updatedById: userId },
      document.version,
    );
    await this.recordAudit(tx, context, plan, plan.items.length);
    return {
      documentId: document.id,
      itemsCount: plan.items.length,
      documentVersion: saved.version,
      items: await this.presenter.toDtos(tx, plan.items, processItems),
    };
  }

  protected override committed(result: ReplacedItems, durationMs: number): void {
    this.logger.log(
      {
        event: 'document.items_saved',
        documentId: result.documentId,
        itemsCount: result.itemsCount,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'document.items_saved',
    );
  }

  private async availability(
    tx: TenantTx,
    referenced: readonly ProcessItemReference[],
  ): Promise<Map<string, AvailableProcessItem>> {
    const units = await this.catalogs.unitsOf(
      tx,
      referenced.map((item) => item.unitOfMeasureId),
    );
    return new Map(
      referenced.map((item) => [
        item.id,
        {
          processItemId: item.id,
          allowsDecimal: units.get(item.unitOfMeasureId)?.allowsDecimal ?? true,
        },
      ]),
    );
  }

  private async recordAudit(
    tx: TenantTx,
    context: DocumentContext,
    plan: Pick<DocumentItemsPlan, 'changes' | 'memoChanges'>,
    itemsCount: number,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'document.items_update',
      entityType: 'Document',
      entityId: context.document.id,
      processId: context.document.processId,
      changes: [
        ...plan.changes.map((change) => ({
          path: `items.${change.processItemId}.quantity`,
          old: change.old,
          new: change.new,
        })),
        // Memória de cálculo como hash + tamanho (story US-022 · "Auditoria").
        ...plan.memoChanges.map((change) => ({
          path: `items.${change.processItemId}.calculationMemo`,
          old: memoFingerprint(change.old),
          new: memoFingerprint(change.new),
        })),
      ],
      metadata: {
        documentCode: context.document.code,
        documentTypeCode: context.type.code,
        itemsCount,
      },
    });
  }
}

/**
 * Lado `document` da porta `ProcessItemUsageRegistry` (US-006/US-014): os documentos não excluídos
 * que referenciam os itens — o 409 `ITEM_IN_USE` da exclusão do item (PRC-16) e as referências do
 * PRC-13. Cancelados também contam (o item faz parte do histórico do documento).
 */
@Injectable()
export class DocumentItemUsageReader implements ProcessItemUsageReader {
  constructor(
    @Inject(DOCUMENT_ITEM_REPOSITORY) private readonly items: DocumentItemRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
  ) {}

  async findItemReferences(tx: TenantTx, itemIds: readonly string[]): Promise<ProcessItemUsage[]> {
    const references = await this.items.referencesTo(tx, itemIds);
    if (references.length === 0) return [];
    const typeCodes = new Map((await this.types.list(tx)).map((type) => [type.id, type.code]));
    const usages: ProcessItemUsage[] = [];
    const cache = new Map<string, Document | null>();
    for (const reference of references) {
      if (!cache.has(reference.documentId)) {
        cache.set(reference.documentId, await this.documents.findById(tx, reference.documentId));
      }
      const document = cache.get(reference.documentId) ?? null;
      if (document === null) continue;
      usages.push({
        itemId: reference.processItemId,
        documentId: document.id,
        code: document.code ?? document.title,
        typeCode: typeCodes.get(document.documentTypeId) ?? '',
        status: document.status,
        editable: isEditable(document),
      });
    }
    return usages;
  }
}

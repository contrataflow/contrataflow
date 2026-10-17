import { ProcessItemsChanged } from '@contrataflow/validation';
import type { ProcessItemDto, ProcessItemReference } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import { ProcessItemUsageRegistry } from '#shared/process/process-item-usage.js';

import { PROCESS_ITEM_REPOSITORY, PROCESS_REPOSITORY } from './ports.js';
import type { ProcessAggregateRows, ProcessItemRepository, ProcessRepository } from './ports.js';
import { fingerprint } from './process-audit.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import {
  processItemNotFound,
  processItemsNotCustodian,
  processItemsNotEditable,
  processNotFoundError,
} from './process.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { ProcessItem } from '../domain/process-items.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import { isEditableStatus, isProcessCustodian } from '../domain/process-update.js';

/*
 * Peças comuns dos casos de uso de itens (US-006): a guarda (trava do processo, visibilidade,
 * `PROCESS_UPDATE` cobrindo o processo, status e custódia — RN-PROC-71 · POL-01), o apresentador
 * (unidade, referências de uso e o mascaramento do preço de referência — RN-PROC-84) e a gravação
 * dos efeitos na mesma transação (auditoria `process.items_update` e `ProcessItemsChanged`, que
 * projeta a timeline `ITEMS_CHANGED` no mesmo `tx` — RN-PROC-82).
 */

/** O processo como os comandos de itens o veem, depois da guarda. */
export interface ItemsProcessContext {
  readonly rows: ProcessAggregateRows;
  readonly runtime: ProcessRuntime;
  /** POL-09 para o processo (preço de referência desmascarado). */
  readonly canSeeBudget: boolean;
}

/** O processo do item travado + o item (re)lido sob a trava do processo. */
export interface ItemContext extends ItemsProcessContext {
  readonly item: ProcessItem;
}

/** O processo como a autorização o vê (escopo e participações — US-097). */
function accessTargetOf(runtime: ProcessRuntime) {
  return {
    processId: runtime.id,
    organizationId: runtime.organizationId ?? null,
    departmentIds: runtime.access.departmentIds,
    userIds: runtime.access.userIds,
    participations: runtime.access.participations ?? [],
  };
}

const isProcessNotFound = (error: unknown) =>
  error instanceof ApiError && error.code === 'PROCESS_NOT_FOUND';

@Injectable()
export class ProcessItemsGate {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    private readonly panel: ProcessPanelReader,
    private readonly access: AccessFacade,
  ) {}

  /** PRC-13: só visibilidade (DEC-024) — não visível = 404 `PROCESS_NOT_FOUND`. */
  async readable(tx: TenantTx, processId: string): Promise<ItemsProcessContext> {
    const { rows, runtime } = await this.panel.load(tx, processId);
    return { rows, runtime, canSeeBudget: await this.panel.canSeeBudget(rows, runtime) };
  }

  /**
   * PRC-14/17: `SELECT … FOR UPDATE` no processo (serializa inclusões — números sem repetição —
   * e alinha com a edição e a tramitação), visibilidade (404) e a autorização de escrita.
   */
  async writable(tx: TenantTx, processId: string): Promise<ItemsProcessContext> {
    if (!(await this.processes.lockForUpdate(tx, processId))) throw processNotFoundError();
    return this.authorize(tx, processId);
  }

  /**
   * PRC-15/16: o processo do item (outro tenant, inexistente ou excluído = 404 `NOT_FOUND`),
   * travado, a autorização e o item travado (`FOR UPDATE` — corrida com a inclusão em documento).
   */
  async writableItem(tx: TenantTx, itemId: string): Promise<ItemContext> {
    const processId = await this.items.processOf(tx, itemId);
    if (processId === null || !(await this.processes.lockForUpdate(tx, processId))) {
      throw processItemNotFound();
    }
    let context: ItemsProcessContext;
    try {
      context = await this.authorize(tx, processId);
    } catch (error) {
      if (isProcessNotFound(error)) throw processItemNotFound();
      throw error;
    }
    const item = await this.items.lockItem(tx, itemId);
    if (item === null) throw processItemNotFound();
    return { ...context, item };
  }

  /** RN-PROC-71: `PROCESS_UPDATE` cobrindo o processo → status editável (409) → custódia (403). */
  private async authorize(tx: TenantTx, processId: string): Promise<ItemsProcessContext> {
    const { rows, runtime, viewer } = await this.panel.load(tx, processId);
    await this.access.assertCanOnProcess('PROCESS_UPDATE', accessTargetOf(runtime));
    const process = rows.process;
    if (!isEditableStatus(process.status)) throw processItemsNotEditable(process.status);
    if (!isProcessCustodian(process, viewer.engine)) throw processItemsNotCustodian();
    return { rows, runtime, canSeeBudget: await this.panel.canSeeBudget(rows, runtime) };
  }
}

@Injectable()
export class ProcessItemPresenter {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly usage: ProcessItemUsageRegistry,
  ) {}

  /** Referências de uso por item (documentos e pesquisas — FA-01/03/04). */
  async references(
    tx: TenantTx,
    itemIds: readonly string[],
  ): Promise<Map<string, ProcessItemReference[]>> {
    const usages = await this.usage.findItemReferences(tx, itemIds);
    const byItem = new Map<string, ProcessItemReference[]>();
    for (const [itemId, list] of usages) {
      byItem.set(
        itemId,
        list.map(({ documentId, code, typeCode, status, editable }) => ({
          documentId,
          code,
          typeCode,
          status,
          editable,
        })),
      );
    }
    return byItem;
  }

  /** DTOs (PRC-13..17): unidade com rótulo, referências e o preço mascarado pela POL-09. */
  async present(
    tx: TenantTx,
    items: readonly ProcessItem[],
    context: Pick<ItemsProcessContext, 'rows' | 'canSeeBudget'>,
  ): Promise<ProcessItemDto[]> {
    const masked = context.rows.process.isBudgetConfidential && !context.canSeeBudget;
    const units = new Map<string, string>();
    for (const id of new Set(items.map((item) => item.unitOfMeasureId))) {
      // Unidade já referenciada segue exibida mesmo inativa (RN-TEN-61).
      units.set(id, (await this.catalog.find(tx, id))?.label ?? '');
    }
    const references = await this.references(
      tx,
      items.map((item) => item.id),
    );
    return items.map((item) => ({
      id: item.id,
      processId: item.processId,
      sequence: item.sequence,
      lotNumber: item.lotNumber,
      lotName: item.lotName,
      kind: item.kind,
      description: item.description,
      unitOfMeasure: { id: item.unitOfMeasureId, label: units.get(item.unitOfMeasureId) ?? '' },
      catalogSystem: item.catalogSystem,
      catalogCode: item.catalogCode,
      notes: item.notes,
      // Quantitativos nunca são sigilosos (art. 24 da Lei 14.133/2021 — RN-PROC-84).
      referenceQuantity: item.referenceQuantity,
      referenceQuantitySourceDocumentId: item.referenceQuantitySourceDocumentId,
      referenceUnitPrice: masked ? null : item.referenceUnitPrice,
      referenceUnitPriceMasked: masked,
      referenceUnitPriceSourceDocumentId: item.referenceUnitPriceSourceDocumentId,
      references: references.get(item.id) ?? [],
      version: item.version,
    }));
  }
}

/** Textos livres do item: na auditoria, só hash + tamanho (story · "Auditoria"). */
const LONG_ITEM_TEXT = new Set(['description', 'notes']);

export interface ItemAuditChange {
  readonly itemId: string;
  readonly field: string;
  readonly old: unknown;
  readonly new: unknown;
}

export type ItemsOperation = 'ADD' | 'UPDATE' | 'REMOVE' | 'REORDER';

export interface ItemsChangeRecord {
  readonly processId: string;
  readonly processCode: string | null;
  readonly operation: ItemsOperation;
  readonly changes: readonly ItemAuditChange[];
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly itemsCount: number;
  readonly processVersion: number;
}

const audited = (field: string, value: unknown) =>
  LONG_ITEM_TEXT.has(field) && typeof value === 'string' ? fingerprint(value) : value;

@Injectable()
export class ProcessItemsChangeRecorder {
  constructor(
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  /** RN-PROC-82: auditoria com o diff por item e o evento (timeline no mesmo `tx`). */
  async record(tx: TenantTx, change: ItemsChangeRecord): Promise<void> {
    await this.audit.record(tx, {
      action: 'process.items_update',
      entityType: 'Process',
      entityId: change.processId,
      processId: change.processId,
      changes: change.changes.map((entry) => ({
        path: `items[${entry.itemId}].${entry.field}`,
        old: audited(entry.field, entry.old),
        new: audited(entry.field, entry.new),
      })),
      metadata: {
        processCode: change.processCode,
        operation: change.operation,
        itemsCount: change.itemsCount,
        version: change.processVersion,
      },
    });
    await this.outbox.record(
      tx,
      ProcessItemsChanged.of({
        aggregateId: change.processId,
        processId: change.processId,
        payload: {
          added: [...change.added],
          updated: [...change.updated],
          removed: [...change.removed],
          itemsCount: change.itemsCount,
        },
      }),
    );
  }
}

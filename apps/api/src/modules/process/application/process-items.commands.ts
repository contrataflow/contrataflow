import type {
  CreateProcessItem,
  ProcessItemDto,
  UpdateProcessItem,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import {
  PROCESS_CLOCK,
  PROCESS_ITEM_REPOSITORY,
  PROCESS_REPOSITORY,
  PROCESS_TRANSACTIONS,
} from './ports.js';
import type {
  ProcessClock,
  ProcessItemRepository,
  ProcessRepository,
  ProcessTransactions,
} from './ports.js';
import {
  ProcessItemPresenter,
  ProcessItemsChangeRecorder,
  ProcessItemsGate,
} from './process-items.support.js';
import type { ItemAuditChange, ItemContext, ItemsOperation } from './process-items.support.js';
import {
  processItemInUse,
  processItemsVersionConflict,
  processValidationError,
} from './process.errors.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import {
  diffItem,
  itemLimitIssues,
  itemRuleIssues,
  newProcessItem,
  nextSequence,
  patchedItem,
  reorderIssues,
  resequence,
  resolveLot,
  touchItem,
} from '../domain/process-items.js';
import type { ProcessItem } from '../domain/process-items.js';

/*
 * Comandos de itens da contratação (US-006 · PRC-14..17): o padrão `TransactionalCommandHandler`
 * — numa transação do tenant, a guarda (`ProcessItemsGate`: trava do processo, visibilidade,
 * `PROCESS_UPDATE`, status e custódia) → `If-Match` → referências (unidade de medida ativa do
 * tenant) → domínio puro → gravação → `Process.version + 1` (RN-PROC-81) → auditoria
 * `process.items_update` e `ProcessItemsChanged` (timeline `ITEMS_CHANGED` no mesmo `tx`).
 */

/** Resultado comum: o que o log de negócio precisa depois do commit (nunca textos nem preços). */
interface ItemsChangeSummary {
  readonly processId: string;
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly itemsCount: number;
  readonly noop: boolean;
}

abstract class ProcessItemsCommand<
  I,
  O extends { readonly summary: ItemsChangeSummary },
> extends TransactionalCommandHandler<I, { readonly now: Date }, O> {
  protected constructor(
    name: string,
    transactions: ProcessTransactions,
    private readonly clock: ProcessClock,
  ) {
    super(name, transactions);
  }

  protected prepare(): Promise<{ readonly now: Date }> {
    return Promise.resolve({ now: this.clock() });
  }

  protected override committed(result: O, durationMs: number): void {
    const { summary } = result;
    if (summary.noop) return;
    const context = requireRequestContext();
    // Nunca logar descrições, observações nem preços de referência (story · "Logs").
    this.logger.log(
      {
        event: 'process.items_changed',
        processId: summary.processId,
        added: summary.added,
        updated: summary.updated,
        removed: summary.removed,
        itemsCount: summary.itemsCount,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'process.items_changed',
    );
  }
}

function userIdOf(): string {
  return requireRequestContext().actor.userId ?? '';
}

function auditChangesOf(item: ProcessItem, before: ProcessItem | null): ItemAuditChange[] {
  return diffItem(before, item).map((change) => ({ itemId: item.id, ...change }));
}

function summaryOf(
  processId: string,
  counts: { added?: number; updated?: number; removed?: number },
  itemsCount: number,
): ItemsChangeSummary {
  return {
    processId,
    added: counts.added ?? 0,
    updated: counts.updated ?? 0,
    removed: counts.removed ?? 0,
    itemsCount,
    noop: false,
  };
}

export interface AddProcessItemInput {
  readonly processId: string;
  readonly body: CreateProcessItem;
}

export interface ItemResult {
  readonly dto: ProcessItemDto;
  readonly summary: ItemsChangeSummary;
}

/** `AddProcessItemCommand` — PRC-14 (fluxo principal, passo 4). */
@Injectable()
export class AddProcessItemCommand extends ProcessItemsCommand<AddProcessItemInput, ItemResult> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    private readonly gate: ProcessItemsGate,
    private readonly catalog: CatalogFacade,
    private readonly presenter: ProcessItemPresenter,
    private readonly recorder: ProcessItemsChangeRecorder,
  ) {
    super('process.items_change', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { processId, body }: AddProcessItemInput,
    { now }: { readonly now: Date },
  ): Promise<ItemResult> {
    const context = await this.gate.writable(tx, processId);
    const userId = userIdOf();
    // V-03 (RN-PROC-76): unidade ativa do catálogo do tenant (de outro tenant = inexistente).
    await this.catalog.assertActive(tx, 'UNIT_OF_MEASURE', body.unitOfMeasureId, 'unitOfMeasureId');
    const active = await this.items.listActive(tx, processId);
    const limit = itemLimitIssues(active.length);
    if (limit.length > 0) throw processValidationError(limit);

    // RN-PROC-73 (máximo + 1) e RN-PROC-75 (nome do lote compartilhado).
    const lotNumber = body.lotNumber ?? null;
    const lot = resolveLot(active, lotNumber, body.lotName ?? undefined);
    const item = newProcessItem(body, {
      id: newId(),
      tenantId: context.rows.process.tenantId,
      processId,
      sequence: nextSequence(active),
      lotName: lot.lotName,
      now,
      userId,
    });
    const renamed = lot.renamed.map((other) =>
      touchItem({ ...other, lotName: lot.lotName }, now, userId),
    );
    await this.items.insert(tx, item);
    await this.items.update(tx, renamed);
    const processVersion = await this.processes.touchProcess(tx, processId, now, userId);

    const itemsCount = active.length + 1;
    await this.recorder.record(tx, {
      ...changeBase(context, 'ADD', itemsCount, processVersion),
      changes: [
        ...auditChangesOf(item, null),
        ...lot.renamed.map((other) => lotNameChange(other, lot.lotName)),
      ],
      added: [item.id],
      updated: renamed.map((other) => other.id),
      removed: [],
    });
    const [dto] = await this.presenter.present(tx, [item], context);
    if (!dto) throw new Error('Item recém-criado sem DTO.');
    return {
      dto,
      summary: summaryOf(processId, { added: 1, updated: renamed.length }, itemsCount),
    };
  }
}

function changeBase(
  context: {
    readonly rows: { readonly process: { readonly id: string; readonly code: string | null } };
  },
  operation: ItemsOperation,
  itemsCount: number,
  processVersion: number,
) {
  return {
    processId: context.rows.process.id,
    processCode: context.rows.process.code,
    operation,
    itemsCount,
    processVersion,
  };
}

function lotNameChange(item: ProcessItem, lotName: string | null): ItemAuditChange {
  return { itemId: item.id, field: 'lotName', old: item.lotName, new: lotName };
}

/** 412 se o `If-Match` não é a versão do item (RN-PROC-81 · FA-08). */
function assertItemVersion(context: ItemContext, expectedVersion: number): void {
  if (expectedVersion !== context.item.version) {
    throw processItemsVersionConflict(expectedVersion, context.item.version);
  }
}

export interface UpdateProcessItemInput {
  readonly itemId: string;
  readonly patch: UpdateProcessItem;
  readonly expectedVersion: number;
}

/** `UpdateProcessItemCommand` — PRC-15 (fluxo principal, passo 7). */
@Injectable()
export class UpdateProcessItemCommand extends ProcessItemsCommand<
  UpdateProcessItemInput,
  ItemResult
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    private readonly gate: ProcessItemsGate,
    private readonly catalog: CatalogFacade,
    private readonly presenter: ProcessItemPresenter,
    private readonly recorder: ProcessItemsChangeRecorder,
  ) {
    super('process.items_change', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { itemId, patch, expectedVersion }: UpdateProcessItemInput,
    { now }: { readonly now: Date },
  ): Promise<ItemResult> {
    const context = await this.gate.writableItem(tx, itemId);
    assertItemVersion(context, expectedVersion);
    const { item } = context;
    const userId = userIdOf();
    const active = await this.items.listActive(tx, item.processId);
    const siblings = active.filter((other) => other.id !== item.id);

    // Estado resultante: lote (RN-PROC-75) e regras cruzadas (RN-PROC-75/77) sobre ele.
    const patched = patchedItem(item, patch);
    const lot = resolveLot(siblings, patched.lotNumber, patch.lotName, item);
    const next: ProcessItem = { ...patched, lotName: lot.lotName };
    const issues = itemRuleIssues(next);
    if (issues.length > 0) throw processValidationError(issues);

    const changes = auditChangesOf(next, item);
    if (changes.length === 0 && lot.renamed.length === 0) {
      const [dto] = await this.presenter.present(tx, [item], context);
      if (!dto) throw new Error('Item sem DTO.');
      return { dto, summary: { ...summaryOf(item.processId, {}, active.length), noop: true } };
    }

    if (next.unitOfMeasureId !== item.unitOfMeasureId) {
      await this.catalog.assertActive(
        tx,
        'UNIT_OF_MEASURE',
        next.unitOfMeasureId,
        'unitOfMeasureId',
      );
      // RN-PROC-76 (FA-04): a unidade de item com quantidades em documentos não muda.
      const references = (await this.presenter.references(tx, [item.id])).get(item.id) ?? [];
      if (references.length > 0) {
        this.logger.warn(
          { event: 'process.item_in_use', itemId: item.id, references: references.length },
          'process.item_in_use',
        );
        throw processItemInUse(item.sequence, references);
      }
    }

    const updated = touchItem(next, now, userId);
    const renamed = lot.renamed.map((other) =>
      touchItem({ ...other, lotName: lot.lotName }, now, userId),
    );
    await this.items.update(tx, [updated, ...renamed]);
    const processVersion = await this.processes.touchProcess(tx, item.processId, now, userId);
    await this.recorder.record(tx, {
      ...changeBase(context, 'UPDATE', active.length, processVersion),
      changes: [...changes, ...lot.renamed.map((other) => lotNameChange(other, lot.lotName))],
      added: [],
      updated: [updated.id, ...renamed.map((other) => other.id)],
      removed: [],
    });
    const [dto] = await this.presenter.present(tx, [updated], context);
    if (!dto) throw new Error('Item sem DTO.');
    return {
      dto,
      summary: summaryOf(item.processId, { updated: 1 + renamed.length }, active.length),
    };
  }
}

export interface RemoveProcessItemInput {
  readonly itemId: string;
  readonly expectedVersion: number;
}

/** `RemoveProcessItemCommand` — PRC-16 (fluxo principal, passo 9 · RN-PROC-79). */
@Injectable()
export class RemoveProcessItemCommand extends ProcessItemsCommand<
  RemoveProcessItemInput,
  { readonly summary: ItemsChangeSummary }
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    private readonly gate: ProcessItemsGate,
    private readonly presenter: ProcessItemPresenter,
    private readonly recorder: ProcessItemsChangeRecorder,
  ) {
    super('process.items_change', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { itemId, expectedVersion }: RemoveProcessItemInput,
    { now }: { readonly now: Date },
  ): Promise<{ readonly summary: ItemsChangeSummary }> {
    // O item fica travado (`FOR UPDATE`) antes de consultar o uso: a inclusão concorrente em
    // documento (que valida o item com `FOR SHARE`) espera ou vence de forma consistente.
    const context = await this.gate.writableItem(tx, itemId);
    assertItemVersion(context, expectedVersion);
    const { item } = context;
    const references = (await this.presenter.references(tx, [item.id])).get(item.id) ?? [];
    if (references.length > 0) {
      this.logger.warn(
        { event: 'process.item_in_use', itemId: item.id, references: references.length },
        'process.item_in_use',
      );
      throw processItemInUse(item.sequence, references);
    }
    const userId = userIdOf();
    // RN-PROC-73: a exclusão não renumera (lacunas até o "Renumerar" — FA-02).
    await this.items.softDelete(tx, item, now, userId);
    const processVersion = await this.processes.touchProcess(tx, item.processId, now, userId);
    const { count } = await this.items.stats(tx, item.processId);
    await this.recorder.record(tx, {
      ...changeBase(context, 'REMOVE', count, processVersion),
      changes: [{ itemId: item.id, field: 'deletedAt', old: null, new: now.toISOString() }],
      added: [],
      updated: [],
      removed: [item.id],
    });
    return { summary: summaryOf(item.processId, { removed: 1 }, count) };
  }
}

export interface ReorderProcessItemsInput {
  readonly processId: string;
  readonly itemIds: readonly string[];
  /** `If-Match` com a versão do PROCESSO (o `ETag` do PRC-13 — RN-PROC-81). */
  readonly expectedVersion: number;
}

export interface ReorderResult {
  readonly items: ProcessItemDto[];
  readonly processVersion: number;
  readonly summary: ItemsChangeSummary;
}

/** `ReorderProcessItemsCommand` — PRC-17 (fluxo principal, passo 8 · FA-02 "Renumerar"). */
@Injectable()
export class ReorderProcessItemsCommand extends ProcessItemsCommand<
  ReorderProcessItemsInput,
  ReorderResult
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) clock: ProcessClock,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    private readonly gate: ProcessItemsGate,
    private readonly presenter: ProcessItemPresenter,
    private readonly recorder: ProcessItemsChangeRecorder,
  ) {
    super('process.items_change', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { processId, itemIds, expectedVersion }: ReorderProcessItemsInput,
    { now }: { readonly now: Date },
  ): Promise<ReorderResult> {
    const context = await this.gate.writable(tx, processId);
    const currentVersion = context.rows.process.version;
    if (expectedVersion !== currentVersion) {
      throw processItemsVersionConflict(expectedVersion, currentVersion);
    }
    const active = await this.items.listActive(tx, processId);
    const issues = reorderIssues(
      active.map((item) => item.id),
      itemIds,
    );
    if (issues.length > 0) throw processValidationError(issues);

    const moves = resequence(active, itemIds);
    if (moves.length === 0) {
      return {
        items: await this.presenter.present(tx, active, context),
        processVersion: currentVersion,
        summary: { ...summaryOf(processId, {}, active.length), noop: true },
      };
    }
    const userId = userIdOf();
    await this.items.resequence(tx, moves, now, userId);
    const processVersion = await this.processes.touchProcess(tx, processId, now, userId);
    await this.recorder.record(tx, {
      ...changeBase(context, 'REORDER', active.length, processVersion),
      changes: moves.map((move) => ({
        itemId: move.id,
        field: 'sequence',
        old: move.from,
        new: move.to,
      })),
      added: [],
      updated: moves.map((move) => move.id),
      removed: [],
    });
    return {
      items: await this.presenter.present(tx, await this.items.listActive(tx, processId), context),
      processVersion,
      summary: summaryOf(processId, { updated: moves.length }, active.length),
    };
  }
}

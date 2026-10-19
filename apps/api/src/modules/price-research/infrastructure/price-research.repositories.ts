import type { PriceItemAlert, PriceRoundingMode } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import {
  isActiveTransaction,
  runSimulatedTransaction,
} from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type {
  PriceItemFilter,
  PriceResearchRepository,
  PriceResearchTransactions,
} from '../application/ports.js';
import type { PriceItem, PriceResearch } from '../domain/price-research.js';

/*
 * `price_research`/`price_items` (US-024): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS
 * do tenant + extensão de isolamento); em memória para os testes e o modo de identidade fake
 * (isolados pelo tenant do contexto, como a RLS). Datas (`date`) trafegam como `AAAA-MM-DD`;
 * decimais como string com a escala da coluna.
 */

type ResearchRow = Prisma.PriceResearchGetPayload<object>;
type ItemRow = Prisma.PriceItemGetPayload<object>;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const fixed = (value: Prisma.Decimal | null, scale: number) => value?.toFixed(scale) ?? null;

function toResearch(row: ResearchRow): PriceResearch {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    documentId: row.documentId,
    referenceDate: isoDate(row.referenceDate),
    parameters: {
      defaultMethod: row.defaultMethod,
      cvThresholdPercent: row.cvThresholdPercent.toFixed(4),
      minQuotations: row.minQuotations,
      directQuoteMaxAgeDays: row.directQuoteMaxAgeDays,
      similarContractMaxAgeDays: row.similarContractMaxAgeDays,
      outlierLowerPercent: row.outlierLowerPercent.toFixed(4),
      outlierUpperPercent: row.outlierUpperPercent.toFixed(4),
      unitPriceDecimals: row.unitPriceDecimals === 4 ? 4 : 2,
      roundingMode: row.roundingMode as PriceRoundingMode,
    },
    totalEstimatedValue: fixed(row.totalEstimatedValue, 2),
    itemsCount: row.itemsCount,
    itemsWithAlertsCount: row.itemsWithAlertsCount,
    lastCalculatedAt: row.lastCalculatedAt,
    completedAt: row.completedAt,
    completedById: row.completedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toItem(row: ItemRow): PriceItem {
  return {
    id: row.id,
    tenantId: row.tenantId,
    priceResearchId: row.priceResearchId,
    processItemId: row.processItemId,
    quantity: row.quantity.toFixed(4),
    methodOverride: row.methodOverride,
    effectiveMethod: row.effectiveMethod,
    validQuotationsCount: row.validQuotationsCount,
    meanPrice: fixed(row.meanPrice, 4),
    medianPrice: fixed(row.medianPrice, 4),
    lowestPrice: fixed(row.lowestPrice, 4),
    highestPrice: fixed(row.highestPrice, 4),
    stdDeviation: fixed(row.stdDeviation, 4),
    coefficientOfVariation: fixed(row.coefficientOfVariation, 4),
    recommendedUnitPrice: fixed(row.recommendedUnitPrice, 4),
    manualUnitPrice: fixed(row.manualUnitPrice, 4),
    manualJustification: row.manualJustification,
    totalPrice: fixed(row.totalPrice, 2),
    belowMinimumJustification: row.belowMinimumJustification,
    alerts: (row.alerts ?? []) as unknown as PriceItemAlert[],
    notes: row.notes,
    sortOrder: row.sortOrder,
    calculatedAt: row.calculatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

/**
 * Colunas mutáveis do cabeçalho (sem tenant, processo e documento — DEC-020). Dos parâmetros do
 * snapshot, só os de cálculo mudam depois da criação (RN-PRICE-47 · US-029); os prazos de validade
 * ficam fixos.
 */
function researchChanges(research: PriceResearch) {
  const { parameters } = research;
  return {
    referenceDate: asDate(research.referenceDate),
    defaultMethod: parameters.defaultMethod,
    cvThresholdPercent: parameters.cvThresholdPercent,
    minQuotations: parameters.minQuotations,
    outlierLowerPercent: parameters.outlierLowerPercent,
    outlierUpperPercent: parameters.outlierUpperPercent,
    unitPriceDecimals: parameters.unitPriceDecimals,
    roundingMode: parameters.roundingMode,
    totalEstimatedValue: research.totalEstimatedValue,
    itemsCount: research.itemsCount,
    itemsWithAlertsCount: research.itemsWithAlertsCount,
    lastCalculatedAt: research.lastCalculatedAt,
    completedAt: research.completedAt,
    completedById: research.completedById,
    updatedAt: research.updatedAt,
    updatedById: research.updatedById,
  };
}

function itemData(item: PriceItem) {
  return {
    id: item.id,
    tenantId: item.tenantId,
    priceResearchId: item.priceResearchId,
    processItemId: item.processItemId,
    quantity: item.quantity,
    methodOverride: item.methodOverride,
    effectiveMethod: item.effectiveMethod,
    validQuotationsCount: item.validQuotationsCount,
    meanPrice: item.meanPrice,
    medianPrice: item.medianPrice,
    lowestPrice: item.lowestPrice,
    highestPrice: item.highestPrice,
    stdDeviation: item.stdDeviation,
    coefficientOfVariation: item.coefficientOfVariation,
    recommendedUnitPrice: item.recommendedUnitPrice,
    manualUnitPrice: item.manualUnitPrice,
    manualJustification: item.manualJustification,
    totalPrice: item.totalPrice,
    belowMinimumJustification: item.belowMinimumJustification,
    alerts: item.alerts as unknown as Prisma.InputJsonValue,
    notes: item.notes,
    sortOrder: item.sortOrder,
    calculatedAt: item.calculatedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    createdById: item.createdById,
    updatedById: item.updatedById,
    version: item.version,
  };
}

/** Colunas calculadas do item (US-029) — regravadas pelo recálculo. */
function calculatedData(item: PriceItem) {
  return {
    effectiveMethod: item.effectiveMethod,
    validQuotationsCount: item.validQuotationsCount,
    meanPrice: item.meanPrice,
    medianPrice: item.medianPrice,
    lowestPrice: item.lowestPrice,
    highestPrice: item.highestPrice,
    stdDeviation: item.stdDeviation,
    coefficientOfVariation: item.coefficientOfVariation,
    recommendedUnitPrice: item.recommendedUnitPrice,
    totalPrice: item.totalPrice,
    alerts: item.alerts as unknown as Prisma.InputJsonValue,
    calculatedAt: item.calculatedAt,
    updatedAt: item.updatedAt,
    updatedById: item.updatedById,
  };
}

function itemWhere(priceResearchId: string, filter: PriceItemFilter): Prisma.PriceItemWhereInput {
  return {
    priceResearchId,
    ...(filter.processItemIds === undefined
      ? {}
      : { processItemId: { in: [...filter.processItemIds] } }),
    ...(filter.hasAlerts === undefined
      ? {}
      : filter.hasAlerts
        ? { NOT: { alerts: { equals: [] } } }
        : { alerts: { equals: [] } }),
  };
}

@Injectable()
export class PrismaPriceResearchRepository implements PriceResearchRepository {
  async insert(tx: TenantTx, research: PriceResearch): Promise<void> {
    const { parameters } = research;
    await tx.priceResearch.create({
      data: {
        ...researchChanges(research),
        id: research.id,
        tenantId: research.tenantId,
        processId: research.processId,
        documentId: research.documentId,
        directQuoteMaxAgeDays: parameters.directQuoteMaxAgeDays,
        similarContractMaxAgeDays: parameters.similarContractMaxAgeDays,
        createdAt: research.createdAt,
        createdById: research.createdById,
        version: research.version,
      },
      select: { id: true },
    });
  }

  async findById(tx: TenantTx, id: string): Promise<PriceResearch | null> {
    const row = await tx.priceResearch.findFirst({ where: { id } });
    return row === null ? null : toResearch(row);
  }

  async lockById(tx: TenantTx, id: string): Promise<PriceResearch | null> {
    // A RLS limita ao tenant; a linha fica travada até o commit/rollback do caso de uso.
    await tx.$queryRaw`SELECT id FROM price_research WHERE id = ${id}::uuid FOR UPDATE`;
    return this.findById(tx, id);
  }

  async listByProcess(tx: TenantTx, processId: string): Promise<PriceResearch[]> {
    const rows = await tx.priceResearch.findMany({
      where: { processId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toResearch);
  }

  async update(tx: TenantTx, research: PriceResearch, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'PriceResearch', aggregateId: research.id, expectedVersion },
      () =>
        tx.priceResearch.updateMany({
          where: { id: research.id, version: expectedVersion },
          data: { ...researchChanges(research), version: { increment: 1 } },
        }),
    );
  }

  async insertItems(tx: TenantTx, items: readonly PriceItem[]): Promise<void> {
    if (items.length === 0) return;
    await tx.priceItem.createMany({ data: items.map(itemData) });
  }

  async listItems(tx: TenantTx, priceResearchId: string): Promise<PriceItem[]> {
    const rows = await tx.priceItem.findMany({
      where: { priceResearchId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toItem);
  }

  async pageItems(
    tx: TenantTx,
    priceResearchId: string,
    filter: PriceItemFilter,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ readonly items: PriceItem[]; readonly total: number }> {
    const where = itemWhere(priceResearchId, filter);
    const [rows, total] = await Promise.all([
      tx.priceItem.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
      }),
      tx.priceItem.count({ where }),
    ]);
    return { items: rows.map(toItem), total };
  }

  async findItem(tx: TenantTx, itemId: string): Promise<PriceItem | null> {
    const row = await tx.priceItem.findFirst({ where: { id: itemId } });
    return row === null ? null : toItem(row);
  }

  async updateItems(tx: TenantTx, items: readonly PriceItem[]): Promise<void> {
    for (const item of items) {
      await tx.priceItem.updateMany({
        where: { id: item.id },
        data: { ...calculatedData(item), version: { increment: 1 } },
      });
    }
  }

  async updateItem(tx: TenantTx, item: PriceItem, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'PriceItem', aggregateId: item.id, expectedVersion },
      () =>
        tx.priceItem.updateMany({
          where: { id: item.id, version: expectedVersion },
          data: {
            ...calculatedData(item),
            quantity: item.quantity,
            methodOverride: item.methodOverride,
            manualUnitPrice: item.manualUnitPrice,
            manualJustification: item.manualJustification,
            version: { increment: 1 },
          },
        }),
    );
  }

  async deleteItem(tx: TenantTx, item: PriceItem, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'PriceItem', aggregateId: item.id, expectedVersion },
      () => tx.priceItem.deleteMany({ where: { id: item.id, version: expectedVersion } }),
    );
  }

  async itemsReferencing(tx: TenantTx, processItemIds: readonly string[]): Promise<PriceItem[]> {
    if (processItemIds.length === 0) return [];
    const rows = await tx.priceItem.findMany({
      where: { processItemId: { in: [...processItemIds] } },
    });
    return rows.map(toItem);
  }
}

/** As colunas calculadas do item (as mesmas de `calculatedData`) para o adaptador em memória. */
function calculatedOf(item: PriceItem) {
  return {
    effectiveMethod: item.effectiveMethod,
    validQuotationsCount: item.validQuotationsCount,
    meanPrice: item.meanPrice,
    medianPrice: item.medianPrice,
    lowestPrice: item.lowestPrice,
    highestPrice: item.highestPrice,
    stdDeviation: item.stdDeviation,
    coefficientOfVariation: item.coefficientOfVariation,
    recommendedUnitPrice: item.recommendedUnitPrice,
    totalPrice: item.totalPrice,
    alerts: item.alerts,
    calculatedAt: item.calculatedAt,
    updatedAt: item.updatedAt,
    updatedById: item.updatedById,
  };
}

/** Pesquisas em memória: mesma semântica do adaptador Prisma, isoladas pelo tenant do contexto. */
@Injectable()
export class InMemoryPriceResearchRepository implements PriceResearchRepository {
  private readonly researches = new Map<string, PriceResearch>();
  private readonly items = new Map<string, PriceItem>();
  /** Trava de linha por pesquisa (`lockById`): o `tx` que a detém. */
  private readonly locks = new Map<string, TenantTx>();
  /** `ON DELETE CASCADE` em memória: quem guarda linhas filhas do item (as cotações — US-026). */
  private readonly itemDeletionListeners: ((itemId: string) => void)[] = [];

  /** Liga a cascata `price_items` → `quotations` do adaptador em memória. */
  onItemDeleted(listener: (itemId: string) => void): void {
    this.itemDeletionListeners.push(listener);
  }

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private researchesInTenant(): PriceResearch[] {
    const tenantId = this.tenantId();
    return [...this.researches.values()].filter((research) => research.tenantId === tenantId);
  }

  private itemsInTenant(): PriceItem[] {
    const tenantId = this.tenantId();
    return [...this.items.values()].filter((item) => item.tenantId === tenantId);
  }

  insert(_tx: TenantTx, research: PriceResearch): Promise<void> {
    if (this.researches.has(research.id)) {
      return Promise.reject(new Error('price_research_pkey: pesquisa repetida'));
    }
    this.researches.set(research.id, research);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, id: string): Promise<PriceResearch | null> {
    return Promise.resolve(
      this.researchesInTenant().find((research) => research.id === id) ?? null,
    );
  }

  async lockById(tx: TenantTx, id: string): Promise<PriceResearch | null> {
    for (;;) {
      const holder = this.locks.get(id);
      if (holder === undefined || holder === tx || !isActiveTransaction(holder)) {
        this.locks.set(id, tx);
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return this.findById(tx, id);
  }

  listByProcess(_tx: TenantTx, processId: string): Promise<PriceResearch[]> {
    return Promise.resolve(
      this.researchesInTenant()
        .filter((research) => research.processId === processId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  update(_tx: TenantTx, research: PriceResearch, expectedVersion: number): Promise<void> {
    const current = this.researchesInTenant().find((candidate) => candidate.id === research.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'PriceResearch',
          aggregateId: research.id,
          expectedVersion,
        }),
      );
    }
    this.researches.set(research.id, {
      ...current,
      ...research,
      // Prazos de validade do snapshot fixos (RN-PRICE-47): só os parâmetros de cálculo mudam.
      parameters: {
        ...research.parameters,
        directQuoteMaxAgeDays: current.parameters.directQuoteMaxAgeDays,
        similarContractMaxAgeDays: current.parameters.similarContractMaxAgeDays,
      },
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  insertItems(_tx: TenantTx, items: readonly PriceItem[]): Promise<void> {
    for (const item of items) {
      const duplicated = [...this.items.values()].some(
        (candidate) =>
          candidate.priceResearchId === item.priceResearchId &&
          candidate.processItemId === item.processItemId,
      );
      if (duplicated) {
        return Promise.reject(new Error('price_items_research_process_item_key: item repetido'));
      }
      this.items.set(item.id, item);
    }
    return Promise.resolve();
  }

  listItems(_tx: TenantTx, priceResearchId: string): Promise<PriceItem[]> {
    return Promise.resolve(
      this.itemsInTenant()
        .filter((item) => item.priceResearchId === priceResearchId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
    );
  }

  async pageItems(
    tx: TenantTx,
    priceResearchId: string,
    filter: PriceItemFilter,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ readonly items: PriceItem[]; readonly total: number }> {
    const lot = filter.processItemIds === undefined ? null : new Set(filter.processItemIds);
    const filtered = (await this.listItems(tx, priceResearchId)).filter(
      (item) =>
        (lot === null || lot.has(item.processItemId)) &&
        (filter.hasAlerts === undefined || filter.hasAlerts === item.alerts.length > 0),
    );
    return {
      items: filtered.slice(window.skip, window.skip + window.take),
      total: filtered.length,
    };
  }

  findItem(_tx: TenantTx, itemId: string): Promise<PriceItem | null> {
    return Promise.resolve(this.itemsInTenant().find((item) => item.id === itemId) ?? null);
  }

  updateItems(_tx: TenantTx, items: readonly PriceItem[]): Promise<void> {
    for (const item of items) {
      const current = this.items.get(item.id);
      if (current === undefined) continue;
      this.items.set(item.id, { ...current, ...calculatedOf(item), version: current.version + 1 });
    }
    return Promise.resolve();
  }

  updateItem(_tx: TenantTx, item: PriceItem, expectedVersion: number): Promise<void> {
    const current = this.itemsInTenant().find((candidate) => candidate.id === item.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'PriceItem',
          aggregateId: item.id,
          expectedVersion,
        }),
      );
    }
    this.items.set(item.id, {
      ...current,
      ...calculatedOf(item),
      quantity: item.quantity,
      methodOverride: item.methodOverride,
      manualUnitPrice: item.manualUnitPrice,
      manualJustification: item.manualJustification,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  deleteItem(_tx: TenantTx, item: PriceItem, expectedVersion: number): Promise<void> {
    const current = this.itemsInTenant().find((candidate) => candidate.id === item.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'PriceItem',
          aggregateId: item.id,
          expectedVersion,
        }),
      );
    }
    this.items.delete(item.id);
    for (const listener of this.itemDeletionListeners) listener(item.id);
    return Promise.resolve();
  }

  itemsReferencing(_tx: TenantTx, processItemIds: readonly string[]): Promise<PriceItem[]> {
    const wanted = new Set(processItemIds);
    return Promise.resolve(this.itemsInTenant().filter((item) => wanted.has(item.processItemId)));
  }

  /** Inspeção de testes: todas as pesquisas e itens (de todos os tenants). */
  snapshot(): {
    readonly researches: readonly PriceResearch[];
    readonly items: readonly PriceItem[];
  } {
    return { researches: [...this.researches.values()], items: [...this.items.values()] };
  }

  /** Carga de testes. */
  seed(research: PriceResearch, items: readonly PriceItem[] = []): void {
    this.researches.set(research.id, research);
    for (const item of items) this.items.set(item.id, item);
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaPriceResearchTransactions implements PriceResearchTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

/**
 * Transações simuladas em fila (uma de cada vez): o equivalente em memória da trava de numeração e
 * do índice único do tipo singular sob concorrência.
 */
@Injectable()
export class InMemoryPriceResearchTransactions implements PriceResearchTransactions {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

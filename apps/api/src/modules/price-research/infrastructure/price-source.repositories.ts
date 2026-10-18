import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { PriceSourceRepository } from '../application/ports.js';
import type { PriceSource, Quotation } from '../domain/price-source.js';

/*
 * `price_sources`/`quotations` (US-026): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do
 * tenant + extensão de isolamento); em memória para os testes e o modo de identidade fake (isolados
 * pelo tenant do contexto, como a RLS, com as cascatas `price_sources`/`price_items` → `quotations`).
 * Datas (`date`) trafegam como `AAAA-MM-DD`; preços como string com 4 casas.
 */

type SourceRow = Prisma.PriceSourceGetPayload<object>;
type QuotationRow = Prisma.QuotationGetPayload<object>;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

function toSource(row: SourceRow): PriceSource {
  return {
    id: row.id,
    tenantId: row.tenantId,
    priceResearchId: row.priceResearchId,
    processId: row.processId,
    sourceTypeId: row.sourceTypeId,
    supplierId: row.supplierId,
    description: row.description,
    quoteDate: row.quoteDate === null ? null : isoDate(row.quoteDate),
    accessedAt: row.accessedAt,
    url: row.url,
    referenceOrganization: row.referenceOrganization,
    referenceDocument: row.referenceDocument,
    supplierChoiceJustification: row.supplierChoiceJustification,
    notes: row.notes,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toQuotation(row: QuotationRow): Quotation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    priceResearchId: row.priceResearchId,
    priceItemId: row.priceItemId,
    priceSourceId: row.priceSourceId,
    unitPrice: row.unitPrice.toFixed(4),
    brandModel: row.brandModel,
    status: row.status,
    exclusionReason: row.exclusionReason,
    exclusionJustification: row.exclusionJustification,
    excludedById: row.excludedById,
    excludedAt: row.excludedAt,
    outlierFlag: row.outlierFlag,
    isExpired: row.isExpired,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

/** Colunas mutáveis da fonte (sem tenant, pesquisa nem processo — gatilho de colunas imutáveis). */
function sourceChanges(source: PriceSource) {
  return {
    sourceTypeId: source.sourceTypeId,
    supplierId: source.supplierId,
    description: source.description,
    quoteDate: source.quoteDate === null ? null : asDate(source.quoteDate),
    accessedAt: source.accessedAt,
    url: source.url,
    referenceOrganization: source.referenceOrganization,
    referenceDocument: source.referenceDocument,
    supplierChoiceJustification: source.supplierChoiceJustification,
    notes: source.notes,
    sortOrder: source.sortOrder,
    updatedAt: source.updatedAt,
    updatedById: source.updatedById,
  };
}

function quotationData(quotation: Quotation) {
  return {
    id: quotation.id,
    tenantId: quotation.tenantId,
    priceResearchId: quotation.priceResearchId,
    priceItemId: quotation.priceItemId,
    priceSourceId: quotation.priceSourceId,
    unitPrice: quotation.unitPrice,
    brandModel: quotation.brandModel,
    status: quotation.status,
    exclusionReason: quotation.exclusionReason,
    exclusionJustification: quotation.exclusionJustification,
    excludedById: quotation.excludedById,
    excludedAt: quotation.excludedAt,
    outlierFlag: quotation.outlierFlag,
    isExpired: quotation.isExpired,
    notes: quotation.notes,
    createdAt: quotation.createdAt,
    updatedAt: quotation.updatedAt,
    createdById: quotation.createdById,
    updatedById: quotation.updatedById,
    version: quotation.version,
  };
}

const SOURCE_ORDER = [
  { sortOrder: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

@Injectable()
export class PrismaPriceSourceRepository implements PriceSourceRepository {
  async insertSource(tx: TenantTx, source: PriceSource): Promise<void> {
    await tx.priceSource.create({
      data: {
        ...sourceChanges(source),
        id: source.id,
        tenantId: source.tenantId,
        priceResearchId: source.priceResearchId,
        processId: source.processId,
        createdAt: source.createdAt,
        createdById: source.createdById,
        version: source.version,
      },
      select: { id: true },
    });
  }

  async findSource(tx: TenantTx, id: string): Promise<PriceSource | null> {
    const row = await tx.priceSource.findFirst({ where: { id } });
    return row === null ? null : toSource(row);
  }

  async listSources(tx: TenantTx, priceResearchId: string): Promise<PriceSource[]> {
    const rows = await tx.priceSource.findMany({
      where: { priceResearchId },
      orderBy: SOURCE_ORDER,
    });
    return rows.map(toSource);
  }

  async nextSortOrder(tx: TenantTx, priceResearchId: string): Promise<number> {
    const result = await tx.priceSource.aggregate({
      where: { priceResearchId },
      _max: { sortOrder: true },
    });
    return (result._max.sortOrder ?? -1) + 1;
  }

  async updateSource(tx: TenantTx, source: PriceSource, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'PriceSource', aggregateId: source.id, expectedVersion },
      () =>
        tx.priceSource.updateMany({
          where: { id: source.id, version: expectedVersion },
          data: { ...sourceChanges(source), version: { increment: 1 } },
        }),
    );
  }

  async deleteSource(tx: TenantTx, source: PriceSource, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'PriceSource', aggregateId: source.id, expectedVersion },
      () => tx.priceSource.deleteMany({ where: { id: source.id, version: expectedVersion } }),
    );
  }

  async listQuotations(tx: TenantTx, priceResearchId: string): Promise<Quotation[]> {
    const rows = await tx.quotation.findMany({
      where: { priceResearchId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toQuotation);
  }

  async findQuotation(tx: TenantTx, id: string): Promise<Quotation | null> {
    const row = await tx.quotation.findFirst({ where: { id } });
    return row === null ? null : toQuotation(row);
  }

  async insertQuotations(tx: TenantTx, quotations: readonly Quotation[]): Promise<void> {
    if (quotations.length === 0) return;
    await tx.quotation.createMany({ data: quotations.map(quotationData) });
  }

  async updateQuotation(
    tx: TenantTx,
    quotation: Quotation,
    expectedVersion: number,
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'Quotation', aggregateId: quotation.id, expectedVersion },
      () =>
        tx.quotation.updateMany({
          where: { id: quotation.id, version: expectedVersion },
          data: {
            unitPrice: quotation.unitPrice,
            brandModel: quotation.brandModel,
            isExpired: quotation.isExpired,
            updatedAt: quotation.updatedAt,
            updatedById: quotation.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async deleteQuotation(
    tx: TenantTx,
    quotation: Quotation,
    expectedVersion: number,
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'Quotation', aggregateId: quotation.id, expectedVersion },
      () => tx.quotation.deleteMany({ where: { id: quotation.id, version: expectedVersion } }),
    );
  }

  async quotationCounts(
    tx: TenantTx,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map(itemIds.map((id) => [id, 0]));
    if (itemIds.length === 0) return counts;
    const rows = await tx.quotation.groupBy({
      by: ['priceItemId'],
      where: { priceItemId: { in: [...itemIds] } },
      _count: { _all: true },
    });
    for (const row of rows) counts.set(row.priceItemId, row._count._all);
    return counts;
  }

  async isSupplierInUse(tx: TenantTx, supplierId: string): Promise<boolean> {
    return (await tx.priceSource.count({ where: { supplierId }, take: 1 })) > 0;
  }
}

/** Fontes e cotações em memória: mesma semântica do adaptador Prisma, isoladas pelo tenant. */
@Injectable()
export class InMemoryPriceSourceRepository implements PriceSourceRepository {
  private readonly sources = new Map<string, PriceSource>();
  private readonly quotations = new Map<string, Quotation>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private sourcesInTenant(): PriceSource[] {
    const tenantId = this.tenantId();
    return [...this.sources.values()].filter((source) => source.tenantId === tenantId);
  }

  private quotationsInTenant(): Quotation[] {
    const tenantId = this.tenantId();
    return [...this.quotations.values()].filter((quotation) => quotation.tenantId === tenantId);
  }

  private conflict(aggregateType: string, aggregateId: string, expectedVersion: number) {
    return Promise.reject(
      new VersionConflictError({ aggregateType, aggregateId, expectedVersion }),
    );
  }

  insertSource(_tx: TenantTx, source: PriceSource): Promise<void> {
    if (this.sources.has(source.id)) {
      return Promise.reject(new Error('price_sources_pkey: fonte repetida'));
    }
    this.sources.set(source.id, source);
    return Promise.resolve();
  }

  findSource(_tx: TenantTx, id: string): Promise<PriceSource | null> {
    return Promise.resolve(this.sourcesInTenant().find((source) => source.id === id) ?? null);
  }

  listSources(_tx: TenantTx, priceResearchId: string): Promise<PriceSource[]> {
    return Promise.resolve(
      this.sourcesInTenant()
        .filter((source) => source.priceResearchId === priceResearchId)
        .sort(
          (a, b) =>
            a.sortOrder - b.sortOrder ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        ),
    );
  }

  async nextSortOrder(tx: TenantTx, priceResearchId: string): Promise<number> {
    const sources = await this.listSources(tx, priceResearchId);
    return sources.reduce((max, source) => Math.max(max, source.sortOrder), -1) + 1;
  }

  updateSource(_tx: TenantTx, source: PriceSource, expectedVersion: number): Promise<void> {
    const current = this.sourcesInTenant().find((candidate) => candidate.id === source.id);
    if (current?.version !== expectedVersion) {
      return this.conflict('PriceSource', source.id, expectedVersion);
    }
    this.sources.set(source.id, {
      ...source,
      tenantId: current.tenantId,
      priceResearchId: current.priceResearchId,
      processId: current.processId,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  deleteSource(_tx: TenantTx, source: PriceSource, expectedVersion: number): Promise<void> {
    const current = this.sourcesInTenant().find((candidate) => candidate.id === source.id);
    if (current?.version !== expectedVersion) {
      return this.conflict('PriceSource', source.id, expectedVersion);
    }
    this.sources.delete(source.id);
    for (const quotation of [...this.quotations.values()]) {
      if (quotation.priceSourceId === source.id) this.quotations.delete(quotation.id);
    }
    return Promise.resolve();
  }

  listQuotations(_tx: TenantTx, priceResearchId: string): Promise<Quotation[]> {
    return Promise.resolve(
      this.quotationsInTenant()
        .filter((quotation) => quotation.priceResearchId === priceResearchId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
    );
  }

  findQuotation(_tx: TenantTx, id: string): Promise<Quotation | null> {
    return Promise.resolve(
      this.quotationsInTenant().find((quotation) => quotation.id === id) ?? null,
    );
  }

  insertQuotations(_tx: TenantTx, quotations: readonly Quotation[]): Promise<void> {
    for (const quotation of quotations) {
      const duplicated = [...this.quotations.values()].some(
        (candidate) =>
          candidate.tenantId === quotation.tenantId &&
          candidate.priceItemId === quotation.priceItemId &&
          candidate.priceSourceId === quotation.priceSourceId,
      );
      if (duplicated) {
        return Promise.reject(new Error('quotations_item_source_key: cotação repetida'));
      }
    }
    for (const quotation of quotations) this.quotations.set(quotation.id, quotation);
    return Promise.resolve();
  }

  updateQuotation(_tx: TenantTx, quotation: Quotation, expectedVersion: number): Promise<void> {
    const current = this.quotationsInTenant().find((candidate) => candidate.id === quotation.id);
    if (current?.version !== expectedVersion) {
      return this.conflict('Quotation', quotation.id, expectedVersion);
    }
    this.quotations.set(quotation.id, {
      ...current,
      unitPrice: quotation.unitPrice,
      brandModel: quotation.brandModel,
      isExpired: quotation.isExpired,
      updatedAt: quotation.updatedAt,
      updatedById: quotation.updatedById,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  deleteQuotation(_tx: TenantTx, quotation: Quotation, expectedVersion: number): Promise<void> {
    const current = this.quotationsInTenant().find((candidate) => candidate.id === quotation.id);
    if (current?.version !== expectedVersion) {
      return this.conflict('Quotation', quotation.id, expectedVersion);
    }
    this.quotations.delete(quotation.id);
    return Promise.resolve();
  }

  quotationCounts(_tx: TenantTx, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const counts = new Map(itemIds.map((id) => [id, 0]));
    for (const quotation of this.quotationsInTenant()) {
      const count = counts.get(quotation.priceItemId);
      if (count !== undefined) counts.set(quotation.priceItemId, count + 1);
    }
    return Promise.resolve(counts);
  }

  isSupplierInUse(_tx: TenantTx, supplierId: string): Promise<boolean> {
    return Promise.resolve(
      this.sourcesInTenant().some((source) => source.supplierId === supplierId),
    );
  }

  /** Cascata `price_items` → `quotations` (`ON DELETE CASCADE` — PRS-08). */
  removeQuotationsOfItem(itemId: string): void {
    for (const quotation of [...this.quotations.values()]) {
      if (quotation.priceItemId === itemId) this.quotations.delete(quotation.id);
    }
  }

  /** Inspeção de testes: todas as fontes e cotações (de todos os tenants). */
  snapshot(): {
    readonly sources: readonly PriceSource[];
    readonly quotations: readonly Quotation[];
  } {
    return { sources: [...this.sources.values()], quotations: [...this.quotations.values()] };
  }

  /** Carga de testes. */
  seed(sources: readonly PriceSource[], quotations: readonly Quotation[] = []): void {
    for (const source of sources) this.sources.set(source.id, source);
    for (const quotation of quotations) this.quotations.set(quotation.id, quotation);
  }

  /** Testes: substitui uma cotação (ex.: marcar como `EXCLUDED` antes da US-027). */
  replaceQuotation(quotation: Quotation): void {
    this.quotations.set(quotation.id, quotation);
  }
}

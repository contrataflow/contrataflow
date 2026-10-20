import type { CatalogType } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { CatalogCodeTakenError } from '../application/catalog-ports.js';
import type {
  CatalogItemPage,
  CatalogItemRepository,
  CatalogListFilter,
  CatalogSortMove,
  CatalogTransactions,
} from '../application/catalog-ports.js';
import type { CatalogItem } from '../domain/catalog-item.js';

type Row = Prisma.CatalogItemGetPayload<object>;

const ORDER: Prisma.CatalogItemOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { code: 'asc' },
  { id: 'asc' },
];

function toDomain(row: Row): CatalogItem {
  const metadata =
    typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    tenantId: row.tenantId,
    catalogType: row.catalogType,
    code: row.code,
    label: row.label,
    description: row.description,
    isSystem: row.isSystem,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    parentId: row.parentId,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toCreateData(item: CatalogItem): Prisma.CatalogItemUncheckedCreateInput {
  return {
    id: item.id,
    tenantId: item.tenantId,
    catalogType: item.catalogType,
    code: item.code,
    label: item.label,
    description: item.description,
    isSystem: item.isSystem,
    isActive: item.isActive,
    sortOrder: item.sortOrder,
    parentId: item.parentId,
    metadata: item.metadata as Prisma.InputJsonObject,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    createdById: item.createdById,
    updatedById: item.updatedById,
    version: item.version,
  };
}

/**
 * `catalog_items` no PostgreSQL (US-104): leituras e escritas no `tx` do caso de uso, sob a RLS do
 * tenant e a extensão de isolamento (que injeta o `tenantId`). Nenhuma exclusão (RN-TEN-64).
 */
@Injectable()
export class PrismaCatalogItemRepository implements CatalogItemRepository {
  async list(
    tx: TenantTx,
    catalogType: CatalogType,
    filter: CatalogListFilter,
  ): Promise<CatalogItemPage> {
    const q = filter.q?.trim();
    const where: Prisma.CatalogItemWhereInput = {
      catalogType,
      ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
      ...(q
        ? {
            OR: [
              { code: { contains: q, mode: 'insensitive' } },
              { label: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, totalItems] = await Promise.all([
      tx.catalogItem.findMany({
        where,
        orderBy: ORDER,
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      tx.catalogItem.count({ where }),
    ]);
    return { items: rows.map(toDomain), totalItems };
  }

  async listAll(tx: TenantTx, catalogType: CatalogType, lock: boolean): Promise<CatalogItem[]> {
    if (lock) {
      // Ordem por `id` evita deadlock entre reordenações concorrentes; a RLS limita ao tenant.
      await tx.$queryRaw`
        SELECT id FROM catalog_items
         WHERE catalog_type = ${catalogType}::catalog_type
         ORDER BY id
           FOR UPDATE`;
    }
    const rows = await tx.catalogItem.findMany({ where: { catalogType }, orderBy: ORDER });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<CatalogItem | null> {
    const row = await tx.catalogItem.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByCode(
    tx: TenantTx,
    catalogType: CatalogType,
    code: string,
  ): Promise<CatalogItem | null> {
    const row = await tx.catalogItem.findFirst({ where: { catalogType, code } });
    return row === null ? null : toDomain(row);
  }

  async maxSortOrder(tx: TenantTx, catalogType: CatalogType): Promise<number> {
    const result = await tx.catalogItem.aggregate({
      where: { catalogType },
      _max: { sortOrder: true },
    });
    return result._max.sortOrder ?? 0;
  }

  async insert(tx: TenantTx, item: CatalogItem): Promise<void> {
    try {
      await tx.catalogItem.create({ data: toCreateData(item) });
    } catch (error) {
      if (isUniqueViolation(error)) throw new CatalogCodeTakenError(item.code);
      throw error;
    }
  }

  async update(tx: TenantTx, item: CatalogItem, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'CatalogItem', aggregateId: item.id, expectedVersion },
      () =>
        tx.catalogItem.updateMany({
          where: { id: item.id, version: expectedVersion },
          data: {
            label: item.label,
            description: item.description,
            parentId: item.parentId,
            sortOrder: item.sortOrder,
            metadata: item.metadata as Prisma.InputJsonObject,
            isActive: item.isActive,
            updatedAt: item.updatedAt,
            updatedById: item.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async applySortOrder(tx: TenantTx, moves: readonly CatalogSortMove[]): Promise<void> {
    for (const move of moves) {
      await tx.catalogItem.updateMany({
        where: { id: move.id },
        data: {
          sortOrder: move.sortOrder,
          updatedAt: move.now,
          updatedById: move.userId,
          version: { increment: 1 },
        },
      });
    }
  }

  async insertMissing(tx: TenantTx, items: readonly CatalogItem[]): Promise<number> {
    const result = await tx.catalogItem.createMany({
      data: items.map(toCreateData),
      skipDuplicates: true,
    });
    return result.count;
  }

  async systemCodes(tx: TenantTx): Promise<ReadonlyMap<CatalogType, ReadonlySet<string>>> {
    const rows = await tx.catalogItem.findMany({
      where: { isSystem: true },
      select: { catalogType: true, code: true },
    });
    const byType = new Map<CatalogType, Set<string>>();
    for (const row of rows) {
      const codes = byType.get(row.catalogType) ?? new Set<string>();
      codes.add(row.code);
      byType.set(row.catalogType, codes);
    }
    return byType;
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaCatalogTransactions implements CatalogTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

import type { CatalogType } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { CatalogCodeTakenError } from '../application/catalog-ports.js';
import type {
  CatalogItemPage,
  CatalogItemRepository,
  CatalogListFilter,
  CatalogSortMove,
  CatalogTransactions,
} from '../application/catalog-ports.js';
import type { CatalogItem } from '../domain/catalog-item.js';

/** Minúsculas e sem acentos: a busca do SCR-109 ignora ambos. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function byOrder(a: CatalogItem, b: CatalogItem): number {
  return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code) || a.id.localeCompare(b.id);
}

/**
 * Itens de catálogo em memória (testes e modo de identidade fake de local/dev/test): mesma
 * semântica do adaptador Prisma — isolamento pelo tenant do contexto da requisição (como o
 * `app.tenant_id` da RLS), unicidade `(tenant, catálogo, código)` e concorrência otimista por
 * versão. Sem concorrência real: `listAll(…, lock)` não precisa travar.
 */
@Injectable()
export class InMemoryCatalogItemRepository implements CatalogItemRepository {
  private readonly rows = new Map<string, CatalogItem>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private inTenant(): CatalogItem[] {
    const tenantId = this.tenantId();
    return [...this.rows.values()].filter((item) => item.tenantId === tenantId);
  }

  list(
    _tx: TenantTx,
    catalogType: CatalogType,
    filter: CatalogListFilter,
  ): Promise<CatalogItemPage> {
    const needle = filter.q === undefined ? null : fold(filter.q.trim());
    const matching = this.inTenant()
      .filter((item) => item.catalogType === catalogType)
      .filter((item) => filter.isActive === undefined || item.isActive === filter.isActive)
      .filter(
        (item) =>
          needle === null || fold(item.code).includes(needle) || fold(item.label).includes(needle),
      )
      .sort(byOrder);
    const start = (filter.page - 1) * filter.pageSize;
    return Promise.resolve({
      items: matching.slice(start, start + filter.pageSize),
      totalItems: matching.length,
    });
  }

  listAll(_tx: TenantTx, catalogType: CatalogType, _lock: boolean): Promise<CatalogItem[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((item) => item.catalogType === catalogType)
        .sort(byOrder),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<CatalogItem | null> {
    return Promise.resolve(this.inTenant().find((item) => item.id === id) ?? null);
  }

  findByCode(_tx: TenantTx, catalogType: CatalogType, code: string): Promise<CatalogItem | null> {
    return Promise.resolve(
      this.inTenant().find((item) => item.catalogType === catalogType && item.code === code) ??
        null,
    );
  }

  maxSortOrder(_tx: TenantTx, catalogType: CatalogType): Promise<number> {
    return Promise.resolve(
      this.inTenant()
        .filter((item) => item.catalogType === catalogType)
        .reduce((max, item) => Math.max(max, item.sortOrder), 0),
    );
  }

  insert(_tx: TenantTx, item: CatalogItem): Promise<void> {
    const taken = this.inTenant().some(
      (existing) => existing.catalogType === item.catalogType && existing.code === item.code,
    );
    if (taken) return Promise.reject(new CatalogCodeTakenError(item.code));
    this.rows.set(item.id, item);
    return Promise.resolve();
  }

  update(_tx: TenantTx, item: CatalogItem, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((existing) => existing.id === item.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'CatalogItem',
          aggregateId: item.id,
          expectedVersion,
        }),
      );
    }
    // `code`, tipo e `isSystem` nunca mudam (gatilho do banco).
    this.rows.set(item.id, {
      ...current,
      label: item.label,
      description: item.description,
      parentId: item.parentId,
      sortOrder: item.sortOrder,
      metadata: item.metadata,
      isActive: item.isActive,
      updatedAt: item.updatedAt,
      updatedById: item.updatedById,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  applySortOrder(_tx: TenantTx, moves: readonly CatalogSortMove[]): Promise<void> {
    for (const move of moves) {
      const current = this.inTenant().find((item) => item.id === move.id);
      if (!current) continue;
      this.rows.set(move.id, {
        ...current,
        sortOrder: move.sortOrder,
        updatedAt: move.now,
        updatedById: move.userId,
        version: current.version + 1,
      });
    }
    return Promise.resolve();
  }

  insertMissing(_tx: TenantTx, items: readonly CatalogItem[]): Promise<number> {
    let created = 0;
    for (const item of items) {
      const exists = [...this.rows.values()].some(
        (existing) =>
          existing.tenantId === item.tenantId &&
          existing.catalogType === item.catalogType &&
          existing.code === item.code,
      );
      if (exists) continue;
      this.rows.set(item.id, item);
      created += 1;
    }
    return Promise.resolve(created);
  }

  systemCodes(_tx: TenantTx): Promise<ReadonlyMap<CatalogType, ReadonlySet<string>>> {
    const byType = new Map<CatalogType, Set<string>>();
    for (const item of this.inTenant().filter((existing) => existing.isSystem)) {
      const codes = byType.get(item.catalogType) ?? new Set<string>();
      codes.add(item.code);
      byType.set(item.catalogType, codes);
    }
    return Promise.resolve(byType);
  }

  /** Inspeção e carga de testes: todos os itens de todos os tenants. */
  snapshot(): readonly CatalogItem[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (item de outro tenant, itens já existentes…). */
  seed(...items: readonly CatalogItem[]): void {
    for (const item of items) this.rows.set(item.id, item);
  }
}

/** Transações simuladas: um `tx` sentinela ativo só durante o trabalho. */
@Injectable()
export class InMemoryCatalogTransactions implements CatalogTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

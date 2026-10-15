import type { CatalogType } from '@contrataflow/types';

import type { TenantTx } from '#shared/database/prisma.js';

import type { CatalogItem } from '../domain/catalog-item.js';

/*
 * Portas da aplicação dos catálogos (US-104): implementadas em `infrastructure/` (Prisma) e em
 * memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

/** Código já usado no catálogo do tenant (índice único `(tenant_id, catalog_type, code)` — V-02). */
export class CatalogCodeTakenError extends Error {
  constructor(readonly code: string) {
    super('Código de item de catálogo já usado no catálogo do tenant.');
    this.name = 'CatalogCodeTakenError';
  }
}

export interface CatalogListFilter {
  readonly isActive?: boolean;
  /** Código ou rótulo (contém, sem diferenciar maiúsculas). */
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface CatalogItemPage {
  readonly items: readonly CatalogItem[];
  readonly totalItems: number;
}

export interface CatalogSortMove {
  readonly id: string;
  readonly sortOrder: number;
  readonly now: Date;
  readonly userId: string | null;
}

export interface CatalogItemRepository {
  /** Itens do catálogo por `sortOrder` e `code` (tenant da transação — RLS). */
  list(tx: TenantTx, catalogType: CatalogType, filter: CatalogListFilter): Promise<CatalogItemPage>;
  /**
   * Todos os itens do catálogo (ativos e inativos), por `sortOrder` e `code`. Com `lock`, trava as
   * linhas (`FOR UPDATE`, por `id`) até o fim da transação — reordenações concorrentes serializam.
   */
  listAll(tx: TenantTx, catalogType: CatalogType, lock: boolean): Promise<CatalogItem[]>;
  /** `null` se o id não existe NO TENANT da transação (outro tenant → `null`, nunca o registro). */
  findById(tx: TenantTx, id: string): Promise<CatalogItem | null>;
  findByCode(tx: TenantTx, catalogType: CatalogType, code: string): Promise<CatalogItem | null>;
  /** Maior `sortOrder` do catálogo (0 sem itens). */
  maxSortOrder(tx: TenantTx, catalogType: CatalogType): Promise<number>;
  /** @throws CatalogCodeTakenError */
  insert(tx: TenantTx, item: CatalogItem): Promise<void>;
  /**
   * Grava rótulo, descrição, pai, ordem, metadados e `isActive` com `version = version + 1`
   * condicionada a `expectedVersion` (DEC-055). `code`, tipo e `isSystem` nunca mudam.
   * @throws VersionConflictError
   */
  update(tx: TenantTx, item: CatalogItem, expectedVersion: number): Promise<void>;
  /** Reordenação: grava só `sortOrder` (e `version + 1`) dos itens já travados por `listAll`. */
  applySortOrder(tx: TenantTx, moves: readonly CatalogSortMove[]): Promise<void>;
  /** Seeder: grava só os itens cujo `(catalogType, code)` ainda não existe; devolve quantos criou. */
  insertMissing(tx: TenantTx, items: readonly CatalogItem[]): Promise<number>;
  /** Seeder: códigos de itens de sistema existentes por tipo. */
  systemCodes(tx: TenantTx): Promise<ReadonlyMap<CatalogType, ReadonlySet<string>>>;
}

export const CATALOG_ITEM_REPOSITORY = Symbol('CatalogItemRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface CatalogTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const CATALOG_TRANSACTIONS = Symbol('CatalogTransactions');

export type CatalogClock = () => Date;

export const CATALOG_CLOCK = Symbol('CatalogClock');

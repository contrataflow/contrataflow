import type { SupplierDocumentType } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

import type { Supplier } from '../domain/supplier.js';

/*
 * Portas da aplicação dos fornecedores (US-025): implementadas em `infrastructure/` (Prisma) e em
 * memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

/** Documento já cadastrado no tenant (índice único parcial `suppliers_document_key` — RN-PRICE-17). */
export class SupplierDocumentTakenError extends Error {
  constructor() {
    super('Documento de fornecedor já cadastrado no tenant.');
    this.name = 'SupplierDocumentTakenError';
  }
}

export interface SupplierListFilter {
  /** Razão social, nome fantasia ou documento (contém, sem diferenciar maiúsculas nem acentos). */
  readonly q?: string;
  readonly isActive?: boolean;
}

export interface SupplierRepository {
  /** Página dos fornecedores não excluídos do tenant, por razão social. */
  list(
    tx: TenantTx,
    filter: SupplierListFilter,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ readonly items: Supplier[]; readonly total: number }>;
  /** `null` se o id não existe, foi excluído ou é de outro tenant (a RLS decide). */
  findById(tx: TenantTx, id: string): Promise<Supplier | null>;
  /** Fornecedores do tenant cujo blind index está em `hashes` (SUP-06). */
  findByDocumentHashes(tx: TenantTx, hashes: readonly string[]): Promise<Supplier[]>;
  /** Duplicidade por `(tipo, hash)` entre os não excluídos (RN-PRICE-17). */
  findByDocument(
    tx: TenantTx,
    documentType: SupplierDocumentType,
    hash: string,
  ): Promise<Supplier | null>;
  /** @throws SupplierDocumentTakenError (corrida entre duas criações do mesmo documento). */
  insert(tx: TenantTx, supplier: Supplier): Promise<void>;
  /** `version = version + 1` condicionada a `expectedVersion` (DEC-055). @throws VersionConflictError */
  update(tx: TenantTx, supplier: Supplier, expectedVersion: number): Promise<void>;
  /** Exclusão lógica condicionada à versão (RN-PRICE-19). @throws VersionConflictError */
  softDelete(
    tx: TenantTx,
    supplier: Supplier,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void>;
}

export const SUPPLIER_REPOSITORY = Symbol('SupplierRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface SupplierTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const SUPPLIER_TRANSACTIONS = Symbol('SupplierTransactions');

export type SupplierClock = () => Date;

export const SUPPLIER_CLOCK = Symbol('SupplierClock');

/**
 * Uso do fornecedor por outros módulos (RN-PRICE-19): `price-research` (nível acima) registra, pela
 * `SupplierFacade`, quem diz se há `PriceSource` não excluída referenciando o fornecedor.
 */
export interface SupplierUsageProvider {
  isInUse(tx: TenantTx, supplierId: string): Promise<boolean>;
}

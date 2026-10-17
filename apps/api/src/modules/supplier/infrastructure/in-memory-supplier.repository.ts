import type { SupplierDocumentType } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { SupplierDocumentTakenError } from '../application/supplier-ports.js';
import type {
  SupplierListFilter,
  SupplierRepository,
  SupplierTransactions,
} from '../application/supplier-ports.js';
import type { Supplier } from '../domain/supplier.js';

/** Minúsculas e sem acentos: a busca do SCR-107 ignora ambos. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(supplier: Supplier, q: string | undefined): boolean {
  if (q === undefined) return true;
  const needle = fold(q.trim());
  return [supplier.legalName, supplier.tradeName, supplier.documentNumber].some(
    (text) => text !== null && fold(text).includes(needle),
  );
}

/**
 * Fornecedores em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento por tenant (o do contexto, como o `app.tenant_id`), unicidade
 * `(tenant, tipo, hash)` entre os não excluídos, exclusão lógica e concorrência otimista por versão.
 */
@Injectable()
export class InMemorySupplierRepository implements SupplierRepository {
  private readonly rows = new Map<string, Supplier>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private inTenant(): Supplier[] {
    const tenantId = this.tenantId();
    return [...this.rows.values()].filter(
      (supplier) => supplier.tenantId === tenantId && supplier.deletedAt === null,
    );
  }

  list(
    _tx: TenantTx,
    filter: SupplierListFilter,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ items: Supplier[]; total: number }> {
    const found = this.inTenant()
      .filter((s) => filter.isActive === undefined || s.isActive === filter.isActive)
      .filter((s) => matches(s, filter.q))
      .sort((a, b) => a.legalName.localeCompare(b.legalName, 'pt-BR') || a.id.localeCompare(b.id));
    return Promise.resolve({
      items: found.slice(window.skip, window.skip + window.take),
      total: found.length,
    });
  }

  findById(_tx: TenantTx, id: string): Promise<Supplier | null> {
    return Promise.resolve(this.inTenant().find((s) => s.id === id) ?? null);
  }

  findByDocumentHashes(_tx: TenantTx, hashes: readonly string[]): Promise<Supplier[]> {
    return Promise.resolve(this.inTenant().filter((s) => hashes.includes(s.documentNumberHash)));
  }

  findByDocument(
    _tx: TenantTx,
    documentType: SupplierDocumentType,
    hash: string,
  ): Promise<Supplier | null> {
    return Promise.resolve(
      this.inTenant().find(
        (s) => s.documentType === documentType && s.documentNumberHash === hash,
      ) ?? null,
    );
  }

  insert(_tx: TenantTx, supplier: Supplier): Promise<void> {
    const taken = this.inTenant().some(
      (s) =>
        s.documentType === supplier.documentType &&
        s.documentNumberHash === supplier.documentNumberHash,
    );
    if (taken) return Promise.reject(new SupplierDocumentTakenError());
    this.rows.set(supplier.id, supplier);
    return Promise.resolve();
  }

  update(_tx: TenantTx, supplier: Supplier, expectedVersion: number): Promise<void> {
    const current = this.current(supplier.id, expectedVersion);
    if (current instanceof Error) return Promise.reject(current);
    // Como no banco: a edição nunca reescreve o documento.
    this.rows.set(supplier.id, {
      ...supplier,
      documentType: current.documentType,
      documentNumber: current.documentNumber,
      documentNumberEncrypted: current.documentNumberEncrypted,
      documentNumberHash: current.documentNumberHash,
      deletedAt: null,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  softDelete(
    _tx: TenantTx,
    supplier: Supplier,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void> {
    const current = this.current(supplier.id, expectedVersion);
    if (current instanceof Error) return Promise.reject(current);
    this.rows.set(supplier.id, {
      ...current,
      deletedAt: deletion.at,
      updatedAt: deletion.at,
      updatedById: deletion.userId,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  private current(id: string, expectedVersion: number): Supplier | VersionConflictError {
    const current = this.inTenant().find((s) => s.id === id);
    if (current?.version !== expectedVersion) {
      return new VersionConflictError({
        aggregateType: 'Supplier',
        aggregateId: id,
        expectedVersion,
      });
    }
    return current;
  }

  /** Inspeção e carga de testes: todos os fornecedores de todos os tenants, inclusive excluídos. */
  snapshot(): readonly Supplier[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (fornecedor de outro tenant, cadastro já existente…). */
  seed(...suppliers: readonly Supplier[]): void {
    for (const supplier of suppliers) this.rows.set(supplier.id, supplier);
  }
}

/**
 * Transações simuladas: um `tx` sentinela ativo só durante o trabalho, uma de cada vez — o
 * equivalente em memória da serialização pelo índice único (Concorrência da US-025).
 */
@Injectable()
export class InMemorySupplierTransactions implements SupplierTransactions {
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

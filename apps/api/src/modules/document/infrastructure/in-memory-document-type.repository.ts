import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DocumentTypeCodeTakenError } from '../application/ports.js';
import type {
  DocumentCounter,
  DocumentTransactions,
  DocumentTypeRepository,
} from '../application/ports.js';
import type { DocumentType } from '../domain/document-type.js';

function byDisplayOrder(a: DocumentType, b: DocumentType): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pt-BR');
}

/**
 * Tipos em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento por tenant (o do contexto, como o `app.tenant_id`), unicidade de
 * código por tenant e concorrência otimista por versão.
 */
@Injectable()
export class InMemoryDocumentTypeRepository implements DocumentTypeRepository {
  private readonly rows = new Map<string, DocumentType>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private inTenant(): DocumentType[] {
    const tenantId = this.tenantId();
    return [...this.rows.values()].filter((type) => type.tenantId === tenantId);
  }

  list(_tx: TenantTx): Promise<DocumentType[]> {
    return Promise.resolve(this.inTenant().sort(byDisplayOrder));
  }

  findById(_tx: TenantTx, id: string): Promise<DocumentType | null> {
    return Promise.resolve(this.inTenant().find((type) => type.id === id) ?? null);
  }

  findByCode(_tx: TenantTx, code: string): Promise<DocumentType | null> {
    return Promise.resolve(this.inTenant().find((type) => type.code === code) ?? null);
  }

  insert(_tx: TenantTx, type: DocumentType): Promise<void> {
    if (this.inTenant().some((existing) => existing.code === type.code)) {
      return Promise.reject(new DocumentTypeCodeTakenError(type.code));
    }
    this.rows.set(type.id, type);
    return Promise.resolve();
  }

  update(_tx: TenantTx, type: DocumentType, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((existing) => existing.id === type.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'DocumentType',
          aggregateId: type.id,
          expectedVersion,
        }),
      );
    }
    this.rows.set(type.id, { ...type, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  insertMissing(_tx: TenantTx, types: readonly DocumentType[]): Promise<number> {
    const codes = new Set(this.inTenant().map((type) => type.code));
    let inserted = 0;
    for (const type of types) {
      if (codes.has(type.code)) continue;
      this.rows.set(type.id, type);
      codes.add(type.code);
      inserted += 1;
    }
    return Promise.resolve(inserted);
  }

  /** Inspeção e carga de testes: todos os tipos de todos os tenants. */
  snapshot(): readonly DocumentType[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (tipo de outro tenant, tipos já existentes…). */
  seed(...types: readonly DocumentType[]): void {
    for (const type of types) this.rows.set(type.id, type);
  }
}

/** Transações simuladas: um `tx` sentinela ativo só durante o trabalho. */
@Injectable()
export class InMemoryDocumentTransactions implements DocumentTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

/** Sem a tabela `documents` (US-062/065) a contagem é 0; testes informam a sua. */
export class StaticDocumentCounter implements DocumentCounter {
  constructor(private readonly counts: Readonly<Record<string, number>> = {}) {}

  countByType(_tx: TenantTx, documentTypeId: string): Promise<number> {
    return Promise.resolve(this.counts[documentTypeId] ?? 0);
  }
}

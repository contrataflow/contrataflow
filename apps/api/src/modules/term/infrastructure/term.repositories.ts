import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { TermRepository, TermTransactions } from '../application/ports.js';
import type { TermOfReference } from '../domain/term-of-reference.js';

/*
 * `terms_of_reference` (US-036): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do tenant +
 * extensão de isolamento); em memória para os testes e o modo de identidade fake (isolados pelo
 * tenant do contexto, como a RLS). Decimais trafegam como string.
 */

type TermRow = Prisma.TermOfReferenceGetPayload<object>;

function toTerm(row: TermRow): TermOfReference {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    documentId: row.documentId,
    objectDefinition: row.objectDefinition,
    contractDurationMonths: row.contractDurationMonths,
    executionDeadline: row.executionDeadline,
    executionDeadlineType: row.executionDeadlineType,
    deliveryLocation: row.deliveryLocation,
    paymentTermDays: row.paymentTermDays,
    productWarrantyMonths: row.productWarrantyMonths,
    contractGuaranteePercent: row.contractGuaranteePercent?.toString() ?? null,
    allowsSubcontracting: row.allowsSubcontracting,
    selectionCriterionId: row.selectionCriterionId,
    awardType: row.awardType,
    estimatedTotalValue: row.estimatedTotalValue?.toFixed(2) ?? null,
    estimatedValueSource:
      row.estimatedValueSource === 'MANUAL' ||
      row.estimatedValueSource === 'PRICE_RESEARCH' ||
      row.estimatedValueSource === 'ETP'
        ? row.estimatedValueSource
        : null,
    priceResearchId: row.priceResearchId,
    importedFromEtpId: row.importedFromEtpId,
    importedFromEtpVersionId: row.importedFromEtpVersionId,
    importedAt: row.importedAt,
    importedById: row.importedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

@Injectable()
export class PrismaTermRepository implements TermRepository {
  async insert(tx: TenantTx, term: TermOfReference): Promise<void> {
    await tx.termOfReference.create({
      data: {
        id: term.id,
        tenantId: term.tenantId,
        processId: term.processId,
        documentId: term.documentId,
        objectDefinition: term.objectDefinition,
        contractDurationMonths: term.contractDurationMonths,
        executionDeadline: term.executionDeadline,
        executionDeadlineType: term.executionDeadlineType,
        deliveryLocation: term.deliveryLocation,
        paymentTermDays: term.paymentTermDays,
        productWarrantyMonths: term.productWarrantyMonths,
        contractGuaranteePercent: term.contractGuaranteePercent,
        allowsSubcontracting: term.allowsSubcontracting,
        selectionCriterionId: term.selectionCriterionId,
        awardType: term.awardType,
        estimatedTotalValue: term.estimatedTotalValue,
        estimatedValueSource: term.estimatedValueSource,
        priceResearchId: term.priceResearchId,
        importedFromEtpId: term.importedFromEtpId,
        importedFromEtpVersionId: term.importedFromEtpVersionId,
        importedAt: term.importedAt,
        importedById: term.importedById,
        createdAt: term.createdAt,
        updatedAt: term.updatedAt,
        createdById: term.createdById,
        updatedById: term.updatedById,
        version: term.version,
      },
      select: { id: true },
    });
  }

  async findById(tx: TenantTx, id: string): Promise<TermOfReference | null> {
    const row = await tx.termOfReference.findFirst({ where: { id } });
    return row === null ? null : toTerm(row);
  }

  async listByProcess(tx: TenantTx, processId: string): Promise<TermOfReference[]> {
    const rows = await tx.termOfReference.findMany({
      where: { processId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toTerm);
  }

  async updateHeader(tx: TenantTx, term: TermOfReference, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'TermOfReference', aggregateId: term.id, expectedVersion },
      () =>
        tx.termOfReference.updateMany({
          where: { id: term.id, version: expectedVersion },
          data: {
            objectDefinition: term.objectDefinition,
            estimatedTotalValue: term.estimatedTotalValue,
            estimatedValueSource: term.estimatedValueSource,
            priceResearchId: term.priceResearchId,
            updatedAt: term.updatedAt,
            updatedById: term.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }
}

/** TRs em memória: mesma semântica do adaptador Prisma, isolados pelo tenant do contexto. */
@Injectable()
export class InMemoryTermRepository implements TermRepository {
  private readonly rows = new Map<string, TermOfReference>();

  private inTenant(): TermOfReference[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((term) => term.tenantId === tenantId);
  }

  insert(_tx: TenantTx, term: TermOfReference): Promise<void> {
    if (this.rows.has(term.id)) {
      return Promise.reject(new Error('terms_of_reference_pkey: TR repetido'));
    }
    this.rows.set(term.id, term);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, id: string): Promise<TermOfReference | null> {
    return Promise.resolve(this.inTenant().find((term) => term.id === id) ?? null);
  }

  listByProcess(_tx: TenantTx, processId: string): Promise<TermOfReference[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((term) => term.processId === processId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  updateHeader(_tx: TenantTx, term: TermOfReference, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((row) => row.id === term.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'TermOfReference',
          aggregateId: term.id,
          expectedVersion,
        }),
      );
    }
    this.rows.set(term.id, {
      ...current,
      objectDefinition: term.objectDefinition,
      estimatedTotalValue: term.estimatedTotalValue,
      estimatedValueSource: term.estimatedValueSource,
      priceResearchId: term.priceResearchId,
      updatedAt: term.updatedAt,
      updatedById: term.updatedById,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  /** Inspeção de testes: todos os TRs (de todos os tenants). */
  snapshot(): readonly TermOfReference[] {
    return [...this.rows.values()];
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaTermTransactions implements TermTransactions {
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
export class InMemoryTermTransactions implements TermTransactions {
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

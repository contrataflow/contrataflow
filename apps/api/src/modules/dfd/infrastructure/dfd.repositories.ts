import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { DfdRepository, DfdTransactions } from '../application/ports.js';
import type { Dfd } from '../domain/dfd.js';

/*
 * `dfds` (US-014): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do tenant + extensão de
 * isolamento); em memória para os testes e o modo de identidade fake (isolados pelo tenant do
 * contexto, como a RLS). Datas (`date`) trafegam como `AAAA-MM-DD`.
 */

type DfdRow = Prisma.DfdGetPayload<object>;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

function toDfd(row: DfdRow): Dfd {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    documentId: row.documentId,
    requestingDepartmentId: row.requestingDepartmentId,
    responsibleId: row.responsibleId,
    requestDate: isoDate(row.requestDate),
    objectSummary: row.objectSummary,
    priority: row.priority,
    expectedDate: row.expectedDate === null ? null : isoDate(row.expectedDate),
    estimatedValue: row.estimatedValue?.toFixed(2) ?? null,
    pcaStatus: row.pcaStatus,
    pcaYear: row.pcaYear,
    pcaItemCode: row.pcaItemCode,
    pcaJustification: row.pcaJustification,
    wizardStep: row.wizardStep,
    completedSteps: row.completedSteps,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

@Injectable()
export class PrismaDfdRepository implements DfdRepository {
  async insert(tx: TenantTx, dfd: Dfd): Promise<void> {
    await tx.dfd.create({
      data: {
        id: dfd.id,
        tenantId: dfd.tenantId,
        processId: dfd.processId,
        documentId: dfd.documentId,
        requestingDepartmentId: dfd.requestingDepartmentId,
        responsibleId: dfd.responsibleId,
        requestDate: asDate(dfd.requestDate),
        objectSummary: dfd.objectSummary,
        priority: dfd.priority,
        expectedDate: dfd.expectedDate === null ? null : asDate(dfd.expectedDate),
        estimatedValue: dfd.estimatedValue,
        pcaStatus: dfd.pcaStatus,
        pcaYear: dfd.pcaYear,
        pcaItemCode: dfd.pcaItemCode,
        pcaJustification: dfd.pcaJustification,
        wizardStep: dfd.wizardStep,
        completedSteps: [...dfd.completedSteps],
        createdAt: dfd.createdAt,
        updatedAt: dfd.updatedAt,
        createdById: dfd.createdById,
        updatedById: dfd.updatedById,
        version: dfd.version,
      },
      select: { id: true },
    });
  }

  async update(tx: TenantTx, dfd: Dfd, expectedVersion: number): Promise<void> {
    await updateVersioned({ aggregateType: 'Dfd', aggregateId: dfd.id, expectedVersion }, () =>
      tx.dfd.updateMany({
        where: { id: dfd.id, version: expectedVersion },
        data: {
          requestingDepartmentId: dfd.requestingDepartmentId,
          responsibleId: dfd.responsibleId,
          requestDate: asDate(dfd.requestDate),
          objectSummary: dfd.objectSummary,
          priority: dfd.priority,
          expectedDate: dfd.expectedDate === null ? null : asDate(dfd.expectedDate),
          estimatedValue: dfd.estimatedValue,
          pcaStatus: dfd.pcaStatus,
          pcaYear: dfd.pcaYear,
          pcaItemCode: dfd.pcaItemCode,
          pcaJustification: dfd.pcaJustification,
          wizardStep: dfd.wizardStep,
          completedSteps: [...dfd.completedSteps],
          updatedAt: dfd.updatedAt,
          updatedById: dfd.updatedById,
          version: { increment: 1 },
        },
      }),
    );
  }

  async findById(tx: TenantTx, id: string): Promise<Dfd | null> {
    const row = await tx.dfd.findFirst({ where: { id } });
    return row === null ? null : toDfd(row);
  }

  async listByProcess(tx: TenantTx, processId: string): Promise<Dfd[]> {
    const rows = await tx.dfd.findMany({
      where: { processId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDfd);
  }
}

/** DFDs em memória: mesma semântica do adaptador Prisma, isolados pelo tenant do contexto. */
@Injectable()
export class InMemoryDfdRepository implements DfdRepository {
  private readonly rows = new Map<string, Dfd>();

  private inTenant(): Dfd[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((dfd) => dfd.tenantId === tenantId);
  }

  insert(_tx: TenantTx, dfd: Dfd): Promise<void> {
    if (this.rows.has(dfd.id)) return Promise.reject(new Error('dfds_pkey: DFD repetido'));
    this.rows.set(dfd.id, dfd);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, id: string): Promise<Dfd | null> {
    return Promise.resolve(this.inTenant().find((dfd) => dfd.id === id) ?? null);
  }

  update(_tx: TenantTx, dfd: Dfd, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((row) => row.id === dfd.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({ aggregateType: 'Dfd', aggregateId: dfd.id, expectedVersion }),
      );
    }
    this.rows.set(dfd.id, { ...dfd, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  listByProcess(_tx: TenantTx, processId: string): Promise<Dfd[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((dfd) => dfd.processId === processId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  /** Inspeção de testes: todos os DFDs (de todos os tenants). */
  snapshot(): readonly Dfd[] {
    return [...this.rows.values()];
  }

  /** Carga de testes. */
  seed(...dfds: readonly Dfd[]): void {
    for (const dfd of dfds) this.rows.set(dfd.id, dfd);
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaDfdTransactions implements DfdTransactions {
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
export class InMemoryDfdTransactions implements DfdTransactions {
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

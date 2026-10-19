import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { EtpRepository, EtpTransactions } from '../application/ports.js';
import type { Etp } from '../domain/etp.js';

/*
 * `etps` (US-019 · US-021 — a recomendada desnormalizada · US-022 — estimativas): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do tenant + extensão de
 * isolamento); em memória para os testes e o modo de identidade fake (isolados pelo tenant do
 * contexto, como a RLS).
 */

type EtpRow = Prisma.EtpGetPayload<object>;

function toEtp(row: EtpRow): Etp {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    documentId: row.documentId,
    recommendedAlternativeId: row.recommendedAlternativeId,
    parcelingDecision: row.parcelingDecision,
    conclusion: row.conclusion,
    estimatedTotalValue: row.estimatedTotalValue?.toFixed(2) ?? null,
    estimatedValueSource:
      row.estimatedValueSource === 'MANUAL' || row.estimatedValueSource === 'PRICE_RESEARCH'
        ? row.estimatedValueSource
        : null,
    priceResearchId: row.priceResearchId,
    importedFromDfdVersionId: row.importedFromDfdVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

@Injectable()
export class PrismaEtpRepository implements EtpRepository {
  async insert(tx: TenantTx, etp: Etp): Promise<void> {
    await tx.etp.create({
      data: {
        id: etp.id,
        tenantId: etp.tenantId,
        processId: etp.processId,
        documentId: etp.documentId,
        recommendedAlternativeId: etp.recommendedAlternativeId,
        parcelingDecision: etp.parcelingDecision,
        conclusion: etp.conclusion,
        estimatedTotalValue: etp.estimatedTotalValue,
        estimatedValueSource: etp.estimatedValueSource,
        priceResearchId: etp.priceResearchId,
        importedFromDfdVersionId: etp.importedFromDfdVersionId,
        createdAt: etp.createdAt,
        updatedAt: etp.updatedAt,
        createdById: etp.createdById,
        updatedById: etp.updatedById,
        version: etp.version,
      },
      select: { id: true },
    });
  }

  async findById(tx: TenantTx, id: string): Promise<Etp | null> {
    const row = await tx.etp.findFirst({ where: { id } });
    return row === null ? null : toEtp(row);
  }

  async listByProcess(tx: TenantTx, processId: string): Promise<Etp[]> {
    const rows = await tx.etp.findMany({
      where: { processId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toEtp);
  }

  async setRecommendedAlternative(tx: TenantTx, etp: Etp): Promise<void> {
    await tx.etp.update({
      where: { id: etp.id },
      data: {
        recommendedAlternativeId: etp.recommendedAlternativeId,
        updatedAt: etp.updatedAt,
        updatedById: etp.updatedById,
        version: { increment: 1 },
      },
      select: { id: true },
    });
  }

  async updateEstimate(tx: TenantTx, etp: Etp, expectedVersion: number): Promise<void> {
    await updateVersioned({ aggregateType: 'Etp', aggregateId: etp.id, expectedVersion }, () =>
      tx.etp.updateMany({
        where: { id: etp.id, version: expectedVersion },
        data: {
          estimatedValueSource: etp.estimatedValueSource,
          estimatedTotalValue: etp.estimatedTotalValue,
          priceResearchId: etp.priceResearchId,
          updatedAt: etp.updatedAt,
          updatedById: etp.updatedById,
          version: { increment: 1 },
        },
      }),
    );
  }
}

/** ETPs em memória: mesma semântica do adaptador Prisma, isolados pelo tenant do contexto. */
@Injectable()
export class InMemoryEtpRepository implements EtpRepository {
  private readonly rows = new Map<string, Etp>();

  private inTenant(): Etp[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((etp) => etp.tenantId === tenantId);
  }

  insert(_tx: TenantTx, etp: Etp): Promise<void> {
    if (this.rows.has(etp.id)) return Promise.reject(new Error('etps_pkey: ETP repetido'));
    this.rows.set(etp.id, etp);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, id: string): Promise<Etp | null> {
    return Promise.resolve(this.inTenant().find((etp) => etp.id === id) ?? null);
  }

  listByProcess(_tx: TenantTx, processId: string): Promise<Etp[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((etp) => etp.processId === processId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  setRecommendedAlternative(_tx: TenantTx, etp: Etp): Promise<void> {
    const current = this.inTenant().find((candidate) => candidate.id === etp.id);
    if (current === undefined) return Promise.reject(new Error('etps: ETP ausente'));
    this.rows.set(etp.id, {
      ...current,
      recommendedAlternativeId: etp.recommendedAlternativeId,
      updatedAt: etp.updatedAt,
      updatedById: etp.updatedById,
      version: current.version + 1,
    });
    return Promise.resolve();
  }

  updateEstimate(_tx: TenantTx, etp: Etp, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((candidate) => candidate.id === etp.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({ aggregateType: 'Etp', aggregateId: etp.id, expectedVersion }),
      );
    }
    this.rows.set(etp.id, {
      ...current,
      estimatedValueSource: etp.estimatedValueSource,
      estimatedTotalValue: etp.estimatedTotalValue,
      priceResearchId: etp.priceResearchId,
      updatedAt: etp.updatedAt,
      updatedById: etp.updatedById,
      version: current.version + 1,
    });
    return Promise.resolve();
  }

  /**
   * Inspeção/simulação de testes: o efeito do sincronizador do worker (RN-ETP-29/31) sobre a
   * linha, sem passar pela API.
   */
  patch(id: string, changes: Partial<Etp>): void {
    const current = this.rows.get(id);
    if (current !== undefined) this.rows.set(id, { ...current, ...changes });
  }

  /** Inspeção de testes: todos os ETPs (de todos os tenants). */
  snapshot(): readonly Etp[] {
    return [...this.rows.values()];
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaEtpTransactions implements EtpTransactions {
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
export class InMemoryEtpTransactions implements EtpTransactions {
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

import type { RiskScaleSnapshot } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';
import { withLockTiming } from '#shared/database/row-lock.js';

import type {
  RiskListFilter,
  RiskRepository,
  RiskTransactions,
  RiskTreatmentRef,
} from '../application/ports.js';
import type { Risk } from '../domain/risk.js';

type Row = Prisma.RiskGetPayload<object>;

function toDomain(row: Row): Risk {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    code: row.code,
    title: row.title,
    description: row.description,
    categoryId: row.categoryId,
    phase: row.phase,
    cause: row.cause,
    consequence: row.consequence,
    probability: row.probability,
    impact: row.impact,
    score: row.score,
    level: row.level,
    scaleSnapshot: row.scaleSnapshot as unknown as RiskScaleSnapshot,
    ownerId: row.ownerId,
    ownerDepartmentId: row.ownerDepartmentId,
    status: row.status,
    residualProbability: row.residualProbability,
    residualImpact: row.residualImpact,
    residualScore: row.residualScore,
    residualLevel: row.residualLevel,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    deletedAt: row.deletedAt,
    deletedById: row.deletedById,
    version: row.version,
  };
}

/** Colunas editáveis (RSK-04): nunca tenant, processo nem código (gatilho na migração). */
function editable(risk: Risk) {
  return {
    title: risk.title,
    description: risk.description,
    categoryId: risk.categoryId,
    phase: risk.phase,
    cause: risk.cause,
    consequence: risk.consequence,
    probability: risk.probability,
    impact: risk.impact,
    score: risk.score,
    level: risk.level,
    scaleSnapshot: risk.scaleSnapshot as unknown as Prisma.InputJsonObject,
    ownerId: risk.ownerId,
    ownerDepartmentId: risk.ownerDepartmentId,
    status: risk.status,
    residualProbability: risk.residualProbability,
    residualImpact: risk.residualImpact,
    residualScore: risk.residualScore,
    residualLevel: risk.residualLevel,
    sortOrder: risk.sortOrder,
    updatedAt: risk.updatedAt,
    updatedById: risk.updatedById,
  };
}

/** Riscos no PostgreSQL sob a RLS do tenant da transação (`app.tenant_id`). */
@Injectable()
export class PrismaRiskRepository implements RiskRepository {
  async listByProcess(tx: TenantTx, processId: string, filter: RiskListFilter): Promise<Risk[]> {
    const rows = await tx.risk.findMany({
      where: {
        processId,
        deletedAt: null,
        ...(filter.phase ? { phase: filter.phase } : {}),
        ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<Risk | null> {
    const row = await tx.risk.findFirst({ where: { id, deletedAt: null } });
    return row ? toDomain(row) : null;
  }

  async processOf(tx: TenantTx, id: string): Promise<string | null> {
    const row = await tx.risk.findFirst({ where: { id }, select: { processId: true } });
    return row?.processId ?? null;
  }

  async lockProcessCodes(tx: TenantTx, processId: string): Promise<void> {
    const key = `risk-code:${processId}`;
    await withLockTiming(
      { lockType: 'advisory', tableName: 'risks' },
      () => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  async usedCodes(tx: TenantTx, processId: string): Promise<string[]> {
    const rows = await tx.risk.findMany({ where: { processId }, select: { code: true } });
    return rows.map((row) => row.code);
  }

  async insert(tx: TenantTx, risk: Risk): Promise<void> {
    await tx.risk.create({
      data: {
        ...editable(risk),
        id: risk.id,
        tenantId: risk.tenantId,
        processId: risk.processId,
        code: risk.code,
        createdAt: risk.createdAt,
        createdById: risk.createdById,
        version: risk.version,
      },
    });
  }

  async update(tx: TenantTx, risk: Risk, expectedVersion: number): Promise<void> {
    await updateVersioned({ aggregateType: 'Risk', aggregateId: risk.id, expectedVersion }, () =>
      tx.risk.updateMany({
        where: { id: risk.id, version: expectedVersion, deletedAt: null },
        data: { ...editable(risk), version: { increment: 1 } },
      }),
    );
  }

  async softDelete(
    tx: TenantTx,
    risk: Risk,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void> {
    await updateVersioned({ aggregateType: 'Risk', aggregateId: risk.id, expectedVersion }, () =>
      tx.risk.updateMany({
        where: { id: risk.id, version: expectedVersion, deletedAt: null },
        data: {
          deletedAt: deletion.at,
          deletedById: deletion.userId,
          updatedAt: deletion.at,
          updatedById: deletion.userId,
          version: { increment: 1 },
        },
      }),
    );
  }

  async treatmentsOf(tx: TenantTx, riskIds: readonly string[]): Promise<RiskTreatmentRef[]> {
    if (riskIds.length === 0) return [];
    return tx.riskTreatment.findMany({
      where: { riskId: { in: [...riskIds] }, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, riskId: true, type: true, description: true, status: true },
    });
  }

  async softDeleteTreatments(
    tx: TenantTx,
    riskId: string,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<number> {
    const { count } = await tx.riskTreatment.updateMany({
      where: { riskId, deletedAt: null },
      data: {
        deletedAt: deletion.at,
        deletedById: deletion.userId,
        updatedAt: deletion.at,
        updatedById: deletion.userId,
        version: { increment: 1 },
      },
    });
    return count;
  }

  async labels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, { readonly code: string; readonly title: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.risk.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, code: true, title: true },
    });
    return new Map(rows.map((row) => [row.id, { code: row.code, title: row.title }]));
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaRiskTransactions implements RiskTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

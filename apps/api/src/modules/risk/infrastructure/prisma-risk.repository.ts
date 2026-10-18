import type { RiskScaleSnapshot } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';
import { withLockTiming } from '#shared/database/row-lock.js';

import type { RiskListFilter, RiskRepository, RiskTransactions } from '../application/ports.js';
import type { RiskTreatment } from '../domain/risk-treatment.js';
import type { Risk } from '../domain/risk.js';

type Row = Prisma.RiskGetPayload<object>;
type TreatmentRow = Prisma.RiskTreatmentGetPayload<object>;

/** Coluna `date` ↔ `YYYY-MM-DD` (o Prisma lê/grava a meia-noite UTC). */
const toDateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);
const fromDateOnly = (value: string | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);

function treatmentToDomain(row: TreatmentRow): RiskTreatment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    riskId: row.riskId,
    processId: row.processId,
    type: row.type,
    description: row.description,
    responsibleId: row.responsibleId,
    responsibleDepartmentId: row.responsibleDepartmentId,
    dueDate: toDateOnly(row.dueDate),
    status: row.status,
    completedAt: row.completedAt,
    notes: row.notes,
    sortOrder: row.sortOrder,
    aiGenerationId: row.aiGenerationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    deletedAt: row.deletedAt,
    deletedById: row.deletedById,
    version: row.version,
  };
}

/** Colunas editáveis (RSK-07): nunca tenant, risco nem processo (gatilho na migração). */
function editableTreatment(treatment: RiskTreatment) {
  return {
    type: treatment.type,
    description: treatment.description,
    responsibleId: treatment.responsibleId,
    responsibleDepartmentId: treatment.responsibleDepartmentId,
    dueDate: fromDateOnly(treatment.dueDate),
    status: treatment.status,
    completedAt: treatment.completedAt,
    notes: treatment.notes,
    sortOrder: treatment.sortOrder,
    updatedAt: treatment.updatedAt,
    updatedById: treatment.updatedById,
  };
}

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
    aiGenerationId: row.aiGenerationId,
    aiReviewedAt: row.aiReviewedAt,
    aiReviewedById: row.aiReviewedById,
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
    aiReviewedAt: risk.aiReviewedAt,
    aiReviewedById: risk.aiReviewedById,
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
        aiGenerationId: risk.aiGenerationId,
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

  async markInTreatment(
    tx: TenantTx,
    riskId: string,
    change: { readonly at: Date; readonly userId: string | null },
  ): Promise<boolean> {
    const { count } = await tx.risk.updateMany({
      where: { id: riskId, status: 'OPEN', deletedAt: null },
      data: {
        status: 'IN_TREATMENT',
        updatedAt: change.at,
        updatedById: change.userId,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  async treatmentsOf(tx: TenantTx, riskIds: readonly string[]): Promise<RiskTreatment[]> {
    if (riskIds.length === 0) return [];
    const rows = await tx.riskTreatment.findMany({
      where: { riskId: { in: [...riskIds] }, deletedAt: null },
      orderBy: [
        { sortOrder: 'asc' },
        { dueDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
    return rows.map(treatmentToDomain);
  }

  async findTreatment(tx: TenantTx, id: string): Promise<RiskTreatment | null> {
    const row = await tx.riskTreatment.findFirst({ where: { id, deletedAt: null } });
    return row ? treatmentToDomain(row) : null;
  }

  async insertTreatment(tx: TenantTx, treatment: RiskTreatment): Promise<void> {
    await tx.riskTreatment.create({
      data: {
        ...editableTreatment(treatment),
        id: treatment.id,
        tenantId: treatment.tenantId,
        riskId: treatment.riskId,
        processId: treatment.processId,
        aiGenerationId: treatment.aiGenerationId,
        createdAt: treatment.createdAt,
        createdById: treatment.createdById,
        version: treatment.version,
      },
    });
  }

  async updateTreatment(
    tx: TenantTx,
    treatment: RiskTreatment,
    expectedVersion: number,
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'RiskTreatment', aggregateId: treatment.id, expectedVersion },
      () =>
        tx.riskTreatment.updateMany({
          where: { id: treatment.id, version: expectedVersion, deletedAt: null },
          data: { ...editableTreatment(treatment), version: { increment: 1 } },
        }),
    );
  }

  async softDeleteTreatment(
    tx: TenantTx,
    treatment: RiskTreatment,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'RiskTreatment', aggregateId: treatment.id, expectedVersion },
      () =>
        tx.riskTreatment.updateMany({
          where: { id: treatment.id, version: expectedVersion, deletedAt: null },
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

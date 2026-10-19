import type { ApprovalCancelReason } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { PendingApprovalExistsError } from '../application/ports.js';
import type {
  ApprovalRepository,
  ApprovalSummaryRow,
  ApprovalTransactions,
  ApprovalWithCoverage,
} from '../application/ports.js';
import { recordOf } from '../domain/approval-decision.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';
import type { Approval, ApprovalCoverage, ApprovalStatus } from '../domain/approval.js';

type ApprovalRow = NonNullable<Awaited<ReturnType<TenantTx['approval']['findFirst']>>>;

function approvalOf(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    subjectType: row.subjectType,
    processStageId: row.processStageId,
    documentId: row.documentId,
    title: row.title,
    requestedById: row.requestedById,
    requestedAt: row.requestedAt,
    requestComment: row.requestComment,
    approverType: row.approverType,
    approverUserId: row.approverUserId,
    approverRoleId: row.approverRoleId,
    approverDepartmentId: row.approverDepartmentId,
    allowDeputy: row.allowDeputy,
    dueAt: row.dueAt,
    status: row.status,
    createdAt: row.createdAt,
    createdById: row.createdById ?? row.requestedById,
    decision: row.decision,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt,
    decisionComment: row.decisionComment,
    decidedAsDeputy: row.decidedAsDeputy,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaApprovalTransactions implements ApprovalTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

/** Transações simuladas (modo de identidade fake e testes). */
@Injectable()
export class InMemoryApprovalTransactions implements ApprovalTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

/**
 * `approvals` e `approval_documents` no PostgreSQL (US-065/US-051): INSERT no `tx` do caso de uso,
 * sob a RLS do tenant e a extensão de isolamento. A pendência única é dos índices parciais
 * `approvals_pending_stage_key` (etapa) e `approvals_pending_document_key` (avulsa) — RN-TRAM-43.
 */
@Injectable()
export class PrismaApprovalRepository implements ApprovalRepository {
  async insert(
    tx: TenantTx,
    approval: Approval,
    coverage: readonly ApprovalCoverage[],
  ): Promise<void> {
    try {
      await tx.approval.create({
        data: {
          id: approval.id,
          tenantId: approval.tenantId,
          processId: approval.processId,
          subjectType: approval.subjectType,
          processStageId: approval.processStageId,
          documentId: approval.documentId,
          title: approval.title,
          requestedById: approval.requestedById,
          requestedAt: approval.requestedAt,
          requestComment: approval.requestComment,
          approverType: approval.approverType,
          approverUserId: approval.approverUserId,
          approverRoleId: approval.approverRoleId,
          approverDepartmentId: approval.approverDepartmentId,
          allowDeputy: approval.allowDeputy,
          dueAt: approval.dueAt,
          status: approval.status,
          createdAt: approval.createdAt,
          updatedAt: approval.createdAt,
          createdById: approval.createdById,
          updatedById: approval.createdById,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new PendingApprovalExistsError(subjectIdOf(approval));
      throw error;
    }
    if (coverage.length === 0) return;
    await tx.approvalDocument.createMany({
      data: coverage.map((item) => ({
        id: item.id,
        tenantId: approval.tenantId,
        approvalId: approval.id,
        documentId: item.documentId,
        documentVersionId: item.documentVersionId,
        createdAt: approval.createdAt,
      })),
    });
  }

  async findPendingForStage(tx: TenantTx, processStageId: string): Promise<Approval | null> {
    const row = await tx.approval.findFirst({ where: { processStageId, status: 'PENDING' } });
    return row === null ? null : approvalOf(row);
  }

  async findById(tx: TenantTx, approvalId: string): Promise<ApprovalWithCoverage | null> {
    const row = await tx.approval.findFirst({ where: { id: approvalId } });
    if (row === null) return null;
    const coverage = await tx.approvalDocument.findMany({
      where: { approvalId },
      select: { id: true, documentId: true, documentVersionId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { approval: approvalOf(row), coverage };
  }

  async lockForUpdate(tx: TenantTx, approvalId: string): Promise<ApprovalRecord | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT a.id
        FROM approvals a
       WHERE a.tenant_id = current_setting('app.tenant_id')::uuid
         AND a.id = ${approvalId}::uuid
         FOR UPDATE`;
    if (locked.length === 0) return null;
    const row = await tx.approval.findFirst({ where: { id: approvalId } });
    return row === null ? null : approvalOf(row);
  }

  async recordDecision(
    tx: TenantTx,
    decided: ApprovalRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const updated = await tx.approval.updateMany({
      where: { id: decided.id, status: 'PENDING', version: expectedVersion },
      data: {
        status: decided.status,
        decision: decided.decision,
        decidedById: decided.decidedById,
        decidedAt: decided.decidedAt,
        decisionComment: decided.decisionComment,
        decidedAsDeputy: decided.decidedAsDeputy,
        updatedAt: decided.updatedAt,
        updatedById: decided.decidedById,
        version: decided.version,
      },
    });
    return updated.count === 1;
  }

  async updatePendingDueAt(
    tx: TenantTx,
    approvalId: string,
    dueAt: Date,
    at: Date,
    userId: string | null,
  ): Promise<boolean> {
    const updated = await tx.approval.updateMany({
      where: { id: approvalId, status: 'PENDING' },
      data: { dueAt, updatedAt: at, updatedById: userId, version: { increment: 1 } },
    });
    return updated.count === 1;
  }

  async cancelPendingByProcess(
    tx: TenantTx,
    processId: string,
    reason: ApprovalCancelReason,
    at: Date,
    userId: string,
  ): Promise<{ readonly approvalId: string; readonly documentIds: readonly string[] }[]> {
    const pending = await tx.approval.findMany({
      where: { processId, status: 'PENDING' },
      select: { id: true, documentId: true },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    });
    if (pending.length === 0) return [];
    const ids = pending.map((row) => row.id);
    await tx.approval.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: {
        status: 'CANCELED',
        canceledAt: at,
        canceledById: userId,
        cancellationReason: reason,
        updatedAt: at,
        updatedById: userId,
        version: { increment: 1 },
      },
    });
    const coverage = await tx.approvalDocument.findMany({
      where: { approvalId: { in: ids } },
      select: { approvalId: true, documentId: true },
    });
    return pending.map((row) => ({
      approvalId: row.id,
      documentIds: [
        ...new Set([
          ...(row.documentId === null ? [] : [row.documentId]),
          ...coverage.filter((item) => item.approvalId === row.id).map((item) => item.documentId),
        ]),
      ],
    }));
  }

  async listPendingByProcess(tx: TenantTx, processId: string): Promise<Approval[]> {
    const rows = await tx.approval.findMany({
      where: { processId, status: 'PENDING' },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(approvalOf);
  }

  async summariesByIds(tx: TenantTx, ids: readonly string[]): Promise<ApprovalSummaryRow[]> {
    if (ids.length === 0) return [];
    return tx.approval.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, title: true, status: true, decision: true },
    });
  }

  async coversDocumentVersion(
    tx: TenantTx,
    approvalId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<boolean> {
    const row = await tx.approvalDocument.findFirst({
      where: { approvalId, documentId, documentVersionId },
      select: { id: true },
    });
    return row !== null;
  }
}

/** A etapa ou o documento sob aprovação (o alvo dos índices de pendência única). */
function subjectIdOf(approval: Approval): string {
  return (
    (approval.subjectType === 'PROCESS_STAGE' ? approval.processStageId : approval.documentId) ?? ''
  );
}

/** Decisão implícita no status da carga de teste que vem como `Approval` (sem a coluna). */
const DECISION_OF_STATUS: Readonly<Record<ApprovalStatus, ApprovalRecord['decision']>> = {
  PENDING: null,
  APPROVED: 'APPROVE',
  RETURNED: 'RETURN',
  REJECTED: 'REJECT',
  CANCELED: null,
};

/** A carga de teste vira registro (versão 1; decisão pelo status) quando vem como `Approval`. */
function asRecord(approval: Approval | ApprovalRecord): ApprovalRecord {
  return 'version' in approval
    ? approval
    : { ...recordOf(approval), decision: DECISION_OF_STATUS[approval.status] };
}

/** Aprovações em memória (testes e modo de identidade fake): mesma regra de pendência única. */
@Injectable()
export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly rows = new Map<string, ApprovalRecord>();
  private readonly coverage = new Map<string, readonly ApprovalCoverage[]>();

  insert(_tx: TenantTx, approval: Approval, coverage: readonly ApprovalCoverage[]): Promise<void> {
    const pending = [...this.rows.values()].some(
      (row) =>
        row.tenantId === approval.tenantId &&
        row.status === 'PENDING' &&
        row.subjectType === approval.subjectType &&
        subjectIdOf(row) === subjectIdOf(approval),
    );
    if (pending) return Promise.reject(new PendingApprovalExistsError(subjectIdOf(approval)));
    this.rows.set(approval.id, recordOf(approval));
    this.coverage.set(approval.id, coverage);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, approvalId: string): Promise<ApprovalWithCoverage | null> {
    const tenantId = currentRequestContext()?.tenantId;
    const approval = this.rows.get(approvalId);
    if (approval === undefined || approval.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve({ approval, coverage: this.coverage.get(approvalId) ?? [] });
  }

  async lockForUpdate(tx: TenantTx, approvalId: string): Promise<ApprovalRecord | null> {
    return (await this.findById(tx, approvalId))?.approval ?? null;
  }

  recordDecision(
    _tx: TenantTx,
    decided: ApprovalRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const tenantId = currentRequestContext()?.tenantId;
    const current = this.rows.get(decided.id);
    if (
      current === undefined ||
      current.tenantId !== tenantId ||
      current.status !== 'PENDING' ||
      current.version !== expectedVersion
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(decided.id, decided);
    return Promise.resolve(true);
  }

  listPendingByProcess(_tx: TenantTx, processId: string): Promise<Approval[]> {
    const tenantId = currentRequestContext()?.tenantId;
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.tenantId === tenantId && row.processId === processId && row.status === 'PENDING',
        )
        .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime()),
    );
  }

  async cancelPendingByProcess(
    tx: TenantTx,
    processId: string,
  ): Promise<{ readonly approvalId: string; readonly documentIds: readonly string[] }[]> {
    const pending = await this.listPendingByProcess(tx, processId);
    for (const row of pending) {
      const record = asRecord(row);
      this.rows.set(row.id, { ...record, status: 'CANCELED', version: record.version + 1 });
    }
    return pending.map((row) => ({
      approvalId: row.id,
      documentIds: [
        ...new Set([
          ...(row.documentId === null ? [] : [row.documentId]),
          ...(this.coverage.get(row.id) ?? []).map((item) => item.documentId),
        ]),
      ],
    }));
  }

  summariesByIds(_tx: TenantTx, ids: readonly string[]): Promise<ApprovalSummaryRow[]> {
    const tenantId = currentRequestContext()?.tenantId;
    const wanted = new Set(ids);
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.tenantId === tenantId && wanted.has(row.id))
        .map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          decision: row.decision,
        })),
    );
  }

  findPendingForStage(_tx: TenantTx, processStageId: string): Promise<Approval | null> {
    const tenantId = currentRequestContext()?.tenantId;
    return Promise.resolve(
      [...this.rows.values()].find(
        (row) =>
          row.tenantId === tenantId &&
          row.processStageId === processStageId &&
          row.status === 'PENDING',
      ) ?? null,
    );
  }

  updatePendingDueAt(_tx: TenantTx, approvalId: string, dueAt: Date): Promise<boolean> {
    const tenantId = currentRequestContext()?.tenantId;
    const row = this.rows.get(approvalId);
    if (row === undefined || row.tenantId !== tenantId || row.status !== 'PENDING') {
      return Promise.resolve(false);
    }
    this.rows.set(approvalId, { ...row, dueAt, version: row.version + 1 });
    return Promise.resolve(true);
  }

  coversDocumentVersion(
    _tx: TenantTx,
    approvalId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<boolean> {
    const tenantId = currentRequestContext()?.tenantId;
    const approval = this.rows.get(approvalId);
    if (approval?.tenantId !== tenantId) return Promise.resolve(false);
    return Promise.resolve(
      (this.coverage.get(approvalId) ?? []).some(
        (item) => item.documentId === documentId && item.documentVersionId === documentVersionId,
      ),
    );
  }

  /** Carga de teste: aprovação já aberta (com os documentos cobertos, quando houver). */
  seed(approval: Approval | ApprovalRecord, coverage: readonly ApprovalCoverage[] = []): void {
    this.rows.set(approval.id, asRecord(approval));
    if (coverage.length > 0) this.coverage.set(approval.id, coverage);
  }

  /** Inspeção de testes: aprovações do tenant do contexto (ou todas, fora de contexto). */
  approvals(): readonly ApprovalRecord[] {
    const tenantId = currentRequestContext()?.tenantId;
    return [...this.rows.values()].filter(
      (row) => tenantId === undefined || tenantId === null || row.tenantId === tenantId,
    );
  }

  coverageOf(approvalId: string): readonly ApprovalCoverage[] {
    return this.coverage.get(approvalId) ?? [];
  }
}

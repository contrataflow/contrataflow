import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { PendingApprovalExistsError } from '../application/ports.js';
import type { ApprovalRepository, ApprovalSummaryRow } from '../application/ports.js';
import type { Approval, ApprovalCoverage, ApprovalStatus } from '../domain/approval.js';

type ApprovalRow = NonNullable<Awaited<ReturnType<TenantTx['approval']['findFirst']>>>;

function approvalOf(row: ApprovalRow): Approval {
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
  };
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

/** Decisão implícita no status (o domínio em memória não guarda a coluna `decision`). */
const DECISION_OF_STATUS: Readonly<Record<ApprovalStatus, ApprovalSummaryRow['decision']>> = {
  PENDING: null,
  APPROVED: 'APPROVE',
  RETURNED: 'RETURN',
  REJECTED: 'REJECT',
  CANCELED: null,
};

/** Aprovações em memória (testes e modo de identidade fake): mesma regra de pendência única. */
@Injectable()
export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly rows = new Map<string, Approval>();
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
    this.rows.set(approval.id, approval);
    this.coverage.set(approval.id, coverage);
    return Promise.resolve();
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
          decision: DECISION_OF_STATUS[row.status],
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
    this.rows.set(approvalId, { ...row, dueAt });
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

  /** Carga de teste: aprovação já aberta. */
  seed(approval: Approval): void {
    this.rows.set(approval.id, approval);
  }

  /** Inspeção de testes: aprovações do tenant do contexto (ou todas, fora de contexto). */
  approvals(): readonly Approval[] {
    const tenantId = currentRequestContext()?.tenantId;
    return [...this.rows.values()].filter(
      (row) => tenantId === undefined || tenantId === null || row.tenantId === tenantId,
    );
  }

  coverageOf(approvalId: string): readonly ApprovalCoverage[] {
    return this.coverage.get(approvalId) ?? [];
  }
}

import { APPROVAL_SKIPPED_REASONS } from '@contrataflow/validation';
import type { ApprovalCancelReason, ApprovalSkippedReason } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { PendingApprovalExistsError } from '../application/ports.js';
import type {
  ApprovalRepository,
  ApprovalSummaryRow,
  DocumentDecisionRow,
  ApprovalTransactions,
  ApprovalWithCoverage,
  LineReassignmentWrite,
  VoteWrite,
} from '../application/ports.js';
import { recordOf } from '../domain/approval-decision.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';
import { backfillLineOf, linesAfterCancellation } from '../domain/approval-lines.js';
import type { ApprovalApprover } from '../domain/approval-lines.js';
import type { Approval, ApprovalCoverage, ApprovalStatus } from '../domain/approval.js';

type ApprovalRow = NonNullable<Awaited<ReturnType<TenantTx['approval']['findFirst']>>>;
type ApprovalApproverRow = NonNullable<
  Awaited<ReturnType<TenantTx['approvalApprover']['findFirst']>>
>;

const SKIPPED_REASONS: ReadonlyMap<string, ApprovalSkippedReason> = new Map(
  APPROVAL_SKIPPED_REASONS.map((reason) => [reason, reason]),
);

const skippedReasonOf = (value: string | null): ApprovalSkippedReason | null =>
  value === null ? null : (SKIPPED_REASONS.get(value) ?? null);

function lineOf(row: ApprovalApproverRow): ApprovalApprover {
  return {
    id: row.id,
    approvalId: row.approvalId,
    sequence: row.sequence,
    approverType: row.approverType,
    approverUserId: row.approverUserId,
    approverRoleId: row.approverRoleId,
    approverDepartmentId: row.approverDepartmentId,
    allowDeputy: row.allowDeputy,
    status: row.status,
    activatedAt: row.activatedAt,
    dueAt: row.dueAt,
    decision: row.decision,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt,
    decisionComment: row.decisionComment,
    decidedAsDeputy: row.decidedAsDeputy,
    reassignedFromId: row.reassignedFromId,
    skippedReason: skippedReasonOf(row.skippedReason),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    version: row.version,
  };
}

/** A linha como o Prisma a grava (`tenantId` vem da aprovação; o id é da aplicação). */
function lineData(tenantId: string, line: ApprovalApprover) {
  return {
    id: line.id,
    tenantId,
    approvalId: line.approvalId,
    sequence: line.sequence,
    approverType: line.approverType,
    approverUserId: line.approverUserId,
    approverRoleId: line.approverRoleId,
    approverDepartmentId: line.approverDepartmentId,
    allowDeputy: line.allowDeputy,
    status: line.status,
    activatedAt: line.activatedAt,
    dueAt: line.dueAt,
    decision: line.decision,
    decidedById: line.decidedById,
    decidedAt: line.decidedAt,
    decisionComment: line.decisionComment,
    decidedAsDeputy: line.decidedAsDeputy,
    reassignedFromId: line.reassignedFromId,
    skippedReason: line.skippedReason,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
    createdById: line.createdById,
    updatedById: line.createdById,
    version: line.version,
  };
}

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
    canceledAt: row.canceledAt,
    canceledById: row.canceledById,
    cancellationReason: row.cancellationReason,
    updatedAt: row.updatedAt,
    version: row.version,
    decisionPolicy: row.decisionPolicy,
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
    lines: readonly ApprovalApprover[],
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
          decisionPolicy: approval.decisionPolicy ?? 'ANY',
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
    // US-133 (RN-APV-17/29): as linhas no mesmo `tx` — falha em qualquer uma desfaz a origem.
    if (lines.length > 0) {
      await tx.approvalApprover.createMany({
        data: lines.map((line) => lineData(approval.tenantId, line)),
      });
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
    return { approval: approvalOf(row), coverage, lines: await this.linesOf(tx, approvalId) };
  }

  findLines(tx: TenantTx, approvalId: string): Promise<ApprovalApprover[]> {
    return this.linesOf(tx, approvalId);
  }

  private async linesOf(tx: TenantTx, approvalId: string): Promise<ApprovalApprover[]> {
    const rows = await tx.approvalApprover.findMany({
      where: { approvalId },
      orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(lineOf);
  }

  /**
   * Grava as linhas que mudaram (cada uma na versão lida — a trava da aprovação serializa).
   * `false` = alguma linha já não estava na versão lida.
   */
  private async saveChangedLines(
    tx: TenantTx,
    before: readonly ApprovalApprover[],
    after: readonly ApprovalApprover[],
    userId: string | null,
  ): Promise<boolean> {
    const previous = new Map(before.map((line) => [line.id, line]));
    let saved = true;
    for (const line of after) {
      const old = previous.get(line.id);
      if (old === undefined || old.version === line.version) continue;
      const updated = await tx.approvalApprover.updateMany({
        where: { id: line.id, version: old.version },
        data: {
          approverType: line.approverType,
          approverUserId: line.approverUserId,
          approverRoleId: line.approverRoleId,
          approverDepartmentId: line.approverDepartmentId,
          allowDeputy: line.allowDeputy,
          status: line.status,
          activatedAt: line.activatedAt,
          decision: line.decision,
          decidedById: line.decidedById,
          decidedAt: line.decidedAt,
          decisionComment: line.decisionComment,
          decidedAsDeputy: line.decidedAsDeputy,
          skippedReason: line.skippedReason,
          updatedAt: line.updatedAt,
          updatedById: userId,
          version: line.version,
        },
      });
      saved &&= updated.count === 1;
    }
    return saved;
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

  async recordVote(
    tx: TenantTx,
    vote: VoteWrite,
    expectedVersion: number,
    userId: string,
  ): Promise<boolean> {
    const { approval } = vote;
    const updated = await tx.approval.updateMany({
      where: { id: approval.id, status: 'PENDING', version: expectedVersion },
      data: {
        status: approval.status,
        decision: approval.decision,
        decidedById: approval.decidedById,
        decidedAt: approval.decidedAt,
        decisionComment: approval.decisionComment,
        decidedAsDeputy: approval.decidedAsDeputy,
        // RN-APV-24/39: o espelho da linha corrente (voto) ou da que encerrou.
        approverType: approval.approverType,
        approverUserId: approval.approverUserId,
        approverRoleId: approval.approverRoleId,
        approverDepartmentId: approval.approverDepartmentId,
        allowDeputy: approval.allowDeputy,
        updatedAt: approval.updatedAt,
        updatedById: userId,
        version: approval.version,
      },
    });
    if (updated.count !== 1) return false;
    return this.saveChangedLines(tx, vote.linesBefore, vote.linesAfter, userId);
  }

  async recordWithdrawal(
    tx: TenantTx,
    canceled: ApprovalRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const updated = await tx.approval.updateMany({
      where: { id: canceled.id, status: 'PENDING', version: expectedVersion },
      data: {
        status: 'CANCELED',
        canceledAt: canceled.canceledAt,
        canceledById: canceled.canceledById,
        cancellationReason: canceled.cancellationReason,
        updatedAt: canceled.updatedAt,
        updatedById: canceled.canceledById,
        version: canceled.version,
      },
    });
    if (updated.count !== 1) return false;
    const lines = await this.linesOf(tx, canceled.id);
    await this.saveChangedLines(
      tx,
      lines,
      linesAfterCancellation(lines, canceled.updatedAt),
      canceled.canceledById,
    );
    return true;
  }

  async recordLineReassignment(
    tx: TenantTx,
    write: LineReassignmentWrite,
    expectedVersion: number,
    userId: string,
  ): Promise<boolean> {
    const { approval, lineBefore, canceled, created } = write;
    const updated = await tx.approval.updateMany({
      where: { id: approval.id, status: 'PENDING', version: expectedVersion },
      data: {
        // RN-APV-24: o espelho da linha corrente (muda só quando a redirecionada era ela).
        approverType: approval.approverType,
        approverUserId: approval.approverUserId,
        approverRoleId: approval.approverRoleId,
        approverDepartmentId: approval.approverDepartmentId,
        allowDeputy: approval.allowDeputy,
        updatedAt: approval.updatedAt,
        updatedById: userId,
        version: approval.version,
      },
    });
    if (updated.count !== 1) return false;
    // A antiga sai da posição ANTES da nova entrar (índice único parcial por `sequence`).
    if (!(await this.saveChangedLines(tx, [lineBefore], [canceled], userId))) return false;
    await tx.approvalApprover.create({ data: lineData(approval.tenantId, created) });
    return true;
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
    // US-133: as linhas não decididas das aprovações canceladas (`WITHDRAWN` — lacuna 3).
    await tx.approvalApprover.updateMany({
      where: { approvalId: { in: ids }, status: { in: ['PENDING', 'WAITING'] } },
      data: {
        status: 'CANCELED',
        skippedReason: 'WITHDRAWN',
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

  async latestDecisionForDocument(
    tx: TenantTx,
    documentId: string,
  ): Promise<DocumentDecisionRow | null> {
    const covering = await tx.approvalDocument.findMany({
      where: { documentId },
      select: { approvalId: true },
    });
    const row = await tx.approval.findFirst({
      where: {
        OR: [{ id: { in: covering.map((item) => item.approvalId) } }, { documentId }],
        status: { in: [...DECIDED_STATUSES] },
        decidedAt: { not: null },
      },
      orderBy: { decidedAt: 'desc' },
      select: {
        id: true,
        status: true,
        decisionComment: true,
        decidedAt: true,
        decidedById: true,
      },
    });
    return row === null ? null : decisionRowOf(row);
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

const DECIDED_STATUSES = ['APPROVED', 'RETURNED', 'REJECTED'] as const;

function decisionRowOf(row: {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly decisionComment: string | null;
  readonly decidedAt: Date | null;
  readonly decidedById: string | null;
}): DocumentDecisionRow | null {
  const status = DECIDED_STATUSES.find((candidate) => candidate === row.status);
  if (status === undefined || row.decidedAt === null) return null;
  return {
    approvalId: row.id,
    status,
    decisionComment: row.decisionComment,
    decidedAt: row.decidedAt,
    decidedById: row.decidedById,
  };
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
  private readonly lines = new Map<string, readonly ApprovalApprover[]>();

  insert(
    _tx: TenantTx,
    approval: Approval,
    coverage: readonly ApprovalCoverage[],
    lines: readonly ApprovalApprover[],
  ): Promise<void> {
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
    this.lines.set(
      approval.id,
      [...lines].sort((a, b) => a.sequence - b.sequence),
    );
    return Promise.resolve();
  }

  findById(_tx: TenantTx, approvalId: string): Promise<ApprovalWithCoverage | null> {
    const tenantId = currentRequestContext()?.tenantId;
    const approval = this.rows.get(approvalId);
    if (approval === undefined || approval.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve({
      approval,
      coverage: this.coverage.get(approvalId) ?? [],
      lines: this.linesOf(approvalId),
    });
  }

  async lockForUpdate(tx: TenantTx, approvalId: string): Promise<ApprovalRecord | null> {
    return (await this.findById(tx, approvalId))?.approval ?? null;
  }

  async findLines(tx: TenantTx, approvalId: string): Promise<ApprovalApprover[]> {
    return [...((await this.findById(tx, approvalId))?.lines ?? [])];
  }

  /** A aprovação do tenant do contexto ainda `PENDING` na versão lida (a "trava" em memória). */
  private pendingAt(approvalId: string, expectedVersion: number): ApprovalRecord | null {
    const tenantId = currentRequestContext()?.tenantId;
    const current = this.rows.get(approvalId);
    if (current === undefined || current.tenantId !== tenantId) return null;
    return current.status === 'PENDING' && current.version === expectedVersion ? current : null;
  }

  recordVote(_tx: TenantTx, vote: VoteWrite, expectedVersion: number): Promise<boolean> {
    const { approval } = vote;
    if (this.pendingAt(approval.id, expectedVersion) === null) return Promise.resolve(false);
    const stored = new Map(this.linesOf(approval.id).map((line) => [line.id, line]));
    const before = new Map(vote.linesBefore.map((line) => [line.id, line]));
    const changed = vote.linesAfter.filter((line) => before.get(line.id)?.version !== line.version);
    if (changed.some((line) => stored.get(line.id)?.version !== before.get(line.id)?.version)) {
      return Promise.resolve(false);
    }
    this.rows.set(approval.id, approval);
    for (const line of changed) stored.set(line.id, line);
    this.lines.set(approval.id, [...stored.values()]);
    return Promise.resolve(true);
  }

  recordWithdrawal(
    _tx: TenantTx,
    canceled: ApprovalRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    if (this.pendingAt(canceled.id, expectedVersion) === null) return Promise.resolve(false);
    this.rows.set(canceled.id, canceled);
    this.lines.set(
      canceled.id,
      linesAfterCancellation(this.linesOf(canceled.id), canceled.updatedAt),
    );
    return Promise.resolve(true);
  }

  recordLineReassignment(
    _tx: TenantTx,
    write: LineReassignmentWrite,
    expectedVersion: number,
  ): Promise<boolean> {
    const { approval, lineBefore, canceled, created } = write;
    if (this.pendingAt(approval.id, expectedVersion) === null) return Promise.resolve(false);
    const lines = this.linesOf(approval.id);
    const stored = lines.find((line) => line.id === lineBefore.id);
    if (stored?.version !== lineBefore.version) return Promise.resolve(false);
    if (
      lines.some(
        (line) =>
          line.sequence === created.sequence &&
          line.id !== lineBefore.id &&
          line.status !== 'CANCELED',
      )
    ) {
      return Promise.reject(new Error('approval_approvers_sequence_key'));
    }
    this.rows.set(approval.id, approval);
    this.lines.set(
      approval.id,
      [...lines.map((line) => (line.id === canceled.id ? canceled : line)), created].sort(
        (a, b) => a.sequence - b.sequence,
      ),
    );
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
      this.lines.set(row.id, linesAfterCancellation(this.linesOf(row.id), record.updatedAt));
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

  latestDecisionForDocument(
    _tx: TenantTx,
    documentId: string,
  ): Promise<DocumentDecisionRow | null> {
    const tenantId = currentRequestContext()?.tenantId;
    const rows = [...this.rows.values()]
      .filter(
        (row) =>
          row.tenantId === tenantId &&
          (row.documentId === documentId ||
            (this.coverage.get(row.id) ?? []).some((item) => item.documentId === documentId)),
      )
      .map((row) => decisionRowOf(row))
      .filter((row): row is DocumentDecisionRow => row !== null)
      .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime());
    return Promise.resolve(rows[0] ?? null);
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

  /**
   * Carga de teste: aprovação já aberta (com os documentos cobertos, quando houver). Sem linhas,
   * ganha a do backfill (M2-03 — `backfillLineOf`), como toda aprovação do MVP 1.
   */
  seed(
    approval: Approval | ApprovalRecord,
    coverage: readonly ApprovalCoverage[] = [],
    lines?: readonly ApprovalApprover[],
  ): void {
    const record = asRecord(approval);
    this.rows.set(approval.id, record);
    if (coverage.length > 0) this.coverage.set(approval.id, coverage);
    this.lines.set(approval.id, lines ?? [backfillLineOf(record, newId())]);
  }

  /** Inspeção de testes: as linhas da aprovação em ordem de `sequence`. */
  linesOf(approvalId: string): readonly ApprovalApprover[] {
    return [...(this.lines.get(approvalId) ?? [])].sort((a, b) => a.sequence - b.sequence);
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

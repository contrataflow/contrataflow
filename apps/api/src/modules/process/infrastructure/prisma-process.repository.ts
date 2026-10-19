import type {
  CreationChannel,
  DayCountType,
  EstimatedValueSource,
  PcaStatus,
  Priority,
  ProcessStageStatus,
  ProcessStatus,
} from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { buildVisibilityPredicate } from '#shared/database/process-visibility.js';
import type { CursorReader } from '#shared/database/transaction-stream.js';

import {
  buildProcessExportCountSql,
  buildProcessExportSql,
  buildProcessListSql,
  toProcessListRow,
} from './process-list.sql.js';
import type { ProcessListDbRow } from './process-list.sql.js';
import { InternalCodeTakenError } from '../application/ports.js';
import type {
  DuplicateCandidateRow,
  DuplicateSearch,
  ProcessExportSearch,
  ProcessListPage,
  ProcessListRow,
  ProcessListSearch,
  ProcessAccessRow,
  ProcessParticipantRow,
  ProcessAggregateRows,
  ProcessCreation,
  ProcessRepository,
  ProcessSituationRow,
  ProcessStageRow,
  ProcessTransactions,
} from '../application/ports.js';
import { DUPLICATE_SIMILARITY_THRESHOLD } from '../domain/duplicate-detection.js';
import type { CancelPlan, ClosedPass, DiscardPlan } from '../domain/process-cancellation.js';
import type { ClaimPlan } from '../domain/process-claim.js';
import type { MovementFeedSearch, StoredMovement } from '../domain/process-movements.js';
import type { PreviousAssignment } from '../domain/process-return.js';
import type { AccessGrant, ProcessMovementRecord } from '../domain/process-runtime-records.js';
import type { ResumePlan, SuspendPlan } from '../domain/process-suspension.js';
import type { Process } from '../domain/process.js';
import type { StageTransitionPlan } from '../domain/stage-transition.js';

/*
 * `processes` e o runtime da tramitação no PostgreSQL (US-001): sempre no `tx` da
 * `TenantTransaction` (RLS do tenant + extensão de isolamento). A criação grava processo → passagem
 * → responsabilidade → tramitação; as FKs circulares (`current_stage_id`, `entered_via_movement_id`)
 * são DEFERRABLE e verificadas no commit. Leituras do agregado numa ÚNICA instrução (um snapshot).
 */

/** Texto da cadeia do erro (mensagem, restrição) para saber QUAL índice único foi violado. */
function textOf(error: unknown): string {
  const parts: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ['message', 'originalMessage', 'constraint', 'field_name', 'detail']) {
      if (typeof record[key] === 'string') parts.push(record[key]);
    }
    if (record.target !== undefined) parts.push(JSON.stringify(record.target));
    if (record.constraint !== undefined) parts.push(JSON.stringify(record.constraint));
    pending.push(record.cause, record.meta, record.driverAdapterError);
  }
  return parts.join(' | ');
}

/** `YYYY-MM-DD` ↔ coluna `date` (meia-noite UTC no Prisma). */
function toDbDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

function fromDbDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

interface ProcessRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly number: number | null;
  readonly year: number;
  readonly code: string | null;
  readonly internal_code: string | null;
  readonly title: string;
  readonly object: string;
  readonly description: string | null;
  readonly contracting_type_id: string;
  readonly modality_id: string | null;
  readonly is_price_registration: boolean;
  readonly requesting_secretariat_id: string;
  readonly requesting_department_id: string;
  readonly current_department_id: string;
  readonly current_responsible_id: string | null;
  readonly priority: Priority;
  readonly status: ProcessStatus;
  readonly workflow_version_id: string;
  readonly current_stage_id: string | null;
  readonly current_workflow_stage_id: string | null;
  readonly current_stage_due_at: Date | null;
  readonly opened_at: Date | null;
  readonly target_date: Date | null;
  readonly estimated_value: string | null;
  readonly estimated_value_source: EstimatedValueSource | null;
  readonly is_budget_confidential: boolean;
  readonly origin_id: string;
  readonly creation_channel: CreationChannel;
  readonly pca_status: PcaStatus;
  readonly pca_year: number | null;
  readonly pca_item_code: string | null;
  readonly pca_justification: string | null;
  readonly notes: string | null;
  readonly duplicated_from_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly created_by_id: string;
  readonly updated_by_id: string | null;
  readonly version: number;
  readonly status_before_suspension: ProcessStatus | null;
  readonly suspension_reason: string | null;
  readonly suspended_at: Date | null;
  readonly completed_at: Date | null;
  readonly canceled_at: Date | null;
  readonly cancellation_reason: string | null;
  readonly overdue_since: Date | null;
  readonly assignment_since: Date | null;
  readonly stages: readonly {
    readonly id: string;
    readonly workflowStageId: string;
    readonly sequence: number;
    readonly status: ProcessStageStatus;
    readonly departmentId: string;
    readonly assigneeId: string | null;
    readonly enteredAt: string;
    readonly exitedAt: string | null;
    readonly dueAt: string | null;
    readonly slaDays: number | null;
    readonly slaType: DayCountType | null;
    readonly dueDateOverridden: boolean;
    readonly pausedAt: string | null;
    readonly overdueSince: string | null;
  }[];
  readonly access: readonly ProcessAccessRow[];
  /** `expiresAt` chega como texto ISO do `jsonb`. */
  readonly participants: readonly (Omit<ProcessParticipantRow, 'expiresAt'> & {
    readonly expiresAt: string | null;
  })[];
}

function toProcess(row: ProcessRow): Process {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    number: row.number,
    year: row.year,
    code: row.code,
    internalCode: row.internal_code,
    title: row.title,
    object: row.object,
    description: row.description,
    contractingTypeId: row.contracting_type_id,
    modalityId: row.modality_id,
    isPriceRegistration: row.is_price_registration,
    requestingSecretariatId: row.requesting_secretariat_id,
    requestingDepartmentId: row.requesting_department_id,
    currentDepartmentId: row.current_department_id,
    currentResponsibleId: row.current_responsible_id,
    priority: row.priority,
    status: row.status,
    workflowVersionId: row.workflow_version_id,
    currentStageId: row.current_stage_id,
    currentWorkflowStageId: row.current_workflow_stage_id,
    currentStageDueAt: row.current_stage_due_at,
    openedAt: row.opened_at,
    targetDate: fromDbDate(row.target_date),
    estimatedValue: row.estimated_value,
    estimatedValueSource: row.estimated_value_source,
    isBudgetConfidential: row.is_budget_confidential,
    originId: row.origin_id,
    creationChannel: row.creation_channel,
    pcaStatus: row.pca_status,
    pcaYear: row.pca_year,
    pcaItemCode: row.pca_item_code,
    pcaJustification: row.pca_justification,
    notes: row.notes,
    duplicatedFromId: row.duplicated_from_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdById: row.created_by_id,
    updatedById: row.updated_by_id,
    version: row.version,
  };
}

function toStage(row: ProcessRow['stages'][number]): ProcessStageRow {
  return {
    id: row.id,
    workflowStageId: row.workflowStageId,
    sequence: row.sequence,
    status: row.status,
    departmentId: row.departmentId,
    assigneeId: row.assigneeId,
    enteredAt: new Date(row.enteredAt),
    exitedAt: row.exitedAt === null ? null : new Date(row.exitedAt),
    dueAt: row.dueAt === null ? null : new Date(row.dueAt),
    slaDays: row.slaDays,
    slaType: row.slaType,
    dueDateOverridden: row.dueDateOverridden,
    pausedAt: row.pausedAt === null ? null : new Date(row.pausedAt),
    overdueSince: row.overdueSince === null ? null : new Date(row.overdueSince),
  };
}

function toSituation(row: ProcessRow): ProcessSituationRow {
  return {
    statusBeforeSuspension: row.status_before_suspension,
    suspensionReason: row.suspension_reason,
    suspendedAt: row.suspended_at,
    completedAt: row.completed_at,
    canceledAt: row.canceled_at,
    cancellationReason: row.cancellation_reason,
    overdueSince: row.overdue_since,
    assignmentSince: row.assignment_since,
  };
}

/** Tramitação (só INSERT — gatilho `process_movements_append_only`). */
/** RN-PROC-107/109: a passagem ativa vira `CANCELED` e a responsabilidade ativa é encerrada. */
async function closeActivePass(tx: TenantTx, processId: string, stage: ClosedPass): Promise<void> {
  const ended = await tx.processStage.updateMany({
    where: { id: stage.id, status: 'ACTIVE' },
    data: {
      status: 'CANCELED',
      exitedAt: stage.exitedAt,
      exitedViaMovementId: stage.exitedViaMovementId,
      updatedAt: stage.exitedAt,
      version: { increment: 1 },
    },
  });
  if (ended.count !== 1) throw new Error('Passagem ativa ausente ao encerrar o processo.');
  await tx.processAssignment.updateMany({
    where: { processId, isActive: true },
    data: { isActive: false, endedAt: stage.exitedAt },
  });
}

async function insertMovement(tx: TenantTx, movement: ProcessMovementRecord): Promise<void> {
  await tx.processMovement.create({
    data: {
      id: movement.id,
      tenantId: movement.tenantId,
      processId: movement.processId,
      sequence: movement.sequence,
      action: movement.action,
      workflowTransitionId: movement.workflowTransitionId,
      fromProcessStageId: movement.fromProcessStageId,
      toProcessStageId: movement.toProcessStageId,
      fromWorkflowStageId: movement.fromWorkflowStageId,
      toWorkflowStageId: movement.toWorkflowStageId,
      fromDepartmentId: movement.fromDepartmentId,
      toDepartmentId: movement.toDepartmentId,
      fromUserId: movement.fromUserId,
      toUserId: movement.toUserId,
      statusFrom: movement.statusFrom,
      statusTo: movement.statusTo,
      actorType: movement.actorType,
      actorId: movement.actorId,
      actorDepartmentId: movement.actorDepartmentId,
      comment: movement.comment,
      dueAt: movement.dueAt,
      documents: movement.documents,
      approvalId: movement.approvalId,
      ip: movement.ip,
      userAgent: movement.userAgent,
      correlationId: movement.correlationId,
      metadata: movement.metadata as Prisma.InputJsonObject,
      occurredAt: movement.occurredAt,
    },
    select: { id: true },
  });
}

@Injectable()
export class PrismaProcessRepository implements ProcessRepository {
  async insertCreation(tx: TenantTx, { process, stage, assignment, movement }: ProcessCreation) {
    try {
      await tx.process.create({
        data: {
          id: process.id,
          tenantId: process.tenantId,
          organizationId: process.organizationId,
          number: process.number,
          year: process.year,
          code: process.code,
          internalCode: process.internalCode,
          title: process.title,
          object: process.object,
          description: process.description,
          contractingTypeId: process.contractingTypeId,
          modalityId: process.modalityId,
          isPriceRegistration: process.isPriceRegistration,
          requestingSecretariatId: process.requestingSecretariatId,
          requestingDepartmentId: process.requestingDepartmentId,
          currentDepartmentId: process.currentDepartmentId,
          currentResponsibleId: process.currentResponsibleId,
          priority: process.priority,
          status: process.status,
          workflowVersionId: process.workflowVersionId,
          currentStageId: process.currentStageId,
          currentWorkflowStageId: process.currentWorkflowStageId,
          currentStageDueAt: process.currentStageDueAt,
          openedAt: process.openedAt,
          targetDate: toDbDate(process.targetDate),
          estimatedValue: process.estimatedValue,
          estimatedValueSource: process.estimatedValueSource,
          isBudgetConfidential: process.isBudgetConfidential,
          originId: process.originId,
          creationChannel: process.creationChannel,
          pcaStatus: process.pcaStatus,
          pcaYear: process.pcaYear,
          pcaItemCode: process.pcaItemCode,
          pcaJustification: process.pcaJustification,
          notes: process.notes,
          duplicatedFromId: process.duplicatedFromId,
          createdAt: process.createdAt,
          updatedAt: process.updatedAt,
          createdById: process.createdById,
          version: process.version,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error) && /internal_code/i.test(textOf(error))) {
        throw new InternalCodeTakenError(process.internalCode ?? '');
      }
      throw error;
    }
    await tx.processStage.create({
      data: {
        id: stage.id,
        tenantId: stage.tenantId,
        processId: stage.processId,
        workflowStageId: stage.workflowStageId,
        sequence: stage.sequence,
        status: stage.status,
        departmentId: stage.departmentId,
        assigneeId: stage.assigneeId,
        enteredAt: stage.enteredAt,
        dueAt: stage.dueAt,
        slaDays: stage.slaDays,
        slaType: stage.slaType,
        enteredViaMovementId: stage.enteredViaMovementId,
      },
      select: { id: true },
    });
    await tx.processAssignment.create({
      data: {
        id: assignment.id,
        tenantId: assignment.tenantId,
        processId: assignment.processId,
        processStageId: assignment.processStageId,
        departmentId: assignment.departmentId,
        assigneeId: assignment.assigneeId,
        type: assignment.type,
        assignedById: assignment.assignedById,
        startedAt: assignment.startedAt,
      },
      select: { id: true },
    });
    await insertMovement(tx, movement);
  }

  async grantAccess(
    tx: TenantTx,
    processId: string,
    grants: readonly AccessGrant[],
    grantedAt: Date,
  ): Promise<void> {
    if (grants.length === 0) return;
    // `ON CONFLICT DO NOTHING`: a concessão ativa por (principal, motivo) já existe → mantida.
    await tx.processAccess.createMany({
      data: grants.map((grant) => ({
        id: newId(),
        tenantId: requireRequestContext().tenantId ?? '',
        processId,
        principalType: grant.principalType,
        departmentId: grant.principalType === 'DEPARTMENT' ? grant.departmentId : null,
        userId: grant.principalType === 'USER' ? grant.userId : null,
        reason: grant.reason,
        sourceId: grant.sourceId ?? null,
        grantedAt,
      })),
      skipDuplicates: true,
    });
  }

  async lastMovementSequence(tx: TenantTx, processId: string): Promise<number> {
    const row = await tx.processMovement.aggregate({
      where: { processId },
      _max: { sequence: true },
    });
    return row._max.sequence ?? 0;
  }

  async listMovements(tx: TenantTx, search: MovementFeedSearch): Promise<StoredMovement[]> {
    const occurredAt = {
      ...(search.occurredFrom === null ? {} : { gte: search.occurredFrom }),
      ...(search.occurredTo === null ? {} : { lte: search.occurredTo }),
    };
    // `sequence DESC` percorre o índice único (tenant_id, process_id, sequence) de trás para a
    // frente; o cursor é `sequence < n` (estável sob tramitações concorrentes — DEC-106).
    const rows = await tx.processMovement.findMany({
      where: {
        processId: search.processId,
        ...(search.actions === null ? {} : { action: { in: [...search.actions] } }),
        ...(search.fromDepartmentId === null ? {} : { fromDepartmentId: search.fromDepartmentId }),
        ...(search.toDepartmentId === null ? {} : { toDepartmentId: search.toDepartmentId }),
        ...(search.actorId === null ? {} : { actorId: search.actorId }),
        ...(Object.keys(occurredAt).length === 0 ? {} : { occurredAt }),
        ...(search.beforeSequence === null ? {} : { sequence: { lt: search.beforeSequence } }),
      },
      orderBy: { sequence: 'desc' },
      take: search.take,
    });
    return rows.map((row) => ({
      ...row,
      documents: row.documents as unknown as StoredMovement['documents'],
      metadata: row.metadata as StoredMovement['metadata'],
    }));
  }

  async recordStageTransition(tx: TenantTx, plan: StageTransitionPlan): Promise<boolean> {
    const { process, closed, entered, assignment, movement } = plan;
    // O processo primeiro: a versão lida sob a trava é a rede contra uma escrita fora da trava.
    const updated = await tx.process.updateMany({
      where: { id: process.id, version: plan.expectedVersion, deletedAt: null },
      data: {
        status: process.status,
        currentStageId: process.currentStageId,
        currentWorkflowStageId: process.currentWorkflowStageId,
        currentDepartmentId: process.currentDepartmentId,
        currentResponsibleId: process.currentResponsibleId,
        currentStageDueAt: process.currentStageDueAt,
        overdueSince: null,
        number: process.number,
        year: process.year,
        code: process.code,
        openedAt: process.openedAt,
        updatedAt: process.updatedAt,
        updatedById: process.updatedById,
        version: process.version,
      },
    });
    if (updated.count !== 1) return false;
    // Encerra antes de abrir: uma única passagem/responsabilidade ativa por processo (índices parciais).
    const ended = await tx.processStage.updateMany({
      where: { id: closed.id, status: 'ACTIVE' },
      data: {
        status: closed.status,
        exitedAt: closed.exitedAt,
        exitedViaMovementId: closed.exitedViaMovementId,
        updatedAt: closed.exitedAt,
        version: { increment: 1 },
      },
    });
    if (ended.count !== 1) throw new Error('Passagem ativa ausente ao encerrar a etapa.');
    await tx.processAssignment.updateMany({
      where: { processId: process.id, isActive: true },
      data: { isActive: false, endedAt: closed.exitedAt },
    });
    await tx.processStage.create({
      data: {
        id: entered.id,
        tenantId: entered.tenantId,
        processId: entered.processId,
        workflowStageId: entered.workflowStageId,
        sequence: entered.sequence,
        status: entered.status,
        departmentId: entered.departmentId,
        assigneeId: entered.assigneeId,
        enteredAt: entered.enteredAt,
        dueAt: entered.dueAt,
        slaDays: entered.slaDays,
        slaType: entered.slaType,
        dueDateOverridden: entered.dueDateOverridden,
        dueDateOverrideReason: entered.dueDateOverrideReason,
        enteredViaMovementId: entered.enteredViaMovementId,
      },
      select: { id: true },
    });
    await tx.processAssignment.create({
      data: {
        id: assignment.id,
        tenantId: assignment.tenantId,
        processId: assignment.processId,
        processStageId: assignment.processStageId,
        departmentId: assignment.departmentId,
        assigneeId: assignment.assigneeId,
        type: assignment.type,
        assignedById: assignment.assignedById,
        startedAt: assignment.startedAt,
      },
      select: { id: true },
    });
    await insertMovement(tx, movement);
    return true;
  }

  async recordClaim(tx: TenantTx, plan: ClaimPlan): Promise<boolean> {
    const { process, assignment } = plan;
    // O processo primeiro: a versão lida sob a trava é a rede contra uma escrita fora da trava.
    const updated = await tx.process.updateMany({
      where: { id: process.id, version: plan.expectedVersion, deletedAt: null },
      data: {
        currentResponsibleId: process.currentResponsibleId,
        updatedAt: process.updatedAt,
        updatedById: process.updatedById,
        version: process.version,
      },
    });
    if (updated.count !== 1) return false;
    const staged = await tx.processStage.updateMany({
      where: { id: plan.stageId, status: 'ACTIVE' },
      data: {
        assigneeId: assignment.assigneeId,
        updatedAt: plan.endedAt,
        version: { increment: 1 },
      },
    });
    if (staged.count !== 1) throw new Error('Passagem ativa ausente ao assumir o processo.');
    // Encerra antes de abrir: uma única responsabilidade ativa por processo (índice parcial).
    await tx.processAssignment.updateMany({
      where: { processId: process.id, isActive: true },
      data: { isActive: false, endedAt: plan.endedAt },
    });
    await tx.processAssignment.create({
      data: {
        id: assignment.id,
        tenantId: assignment.tenantId,
        processId: assignment.processId,
        processStageId: assignment.processStageId,
        departmentId: assignment.departmentId,
        assigneeId: assignment.assigneeId,
        type: assignment.type,
        assignedById: assignment.assignedById,
        startedAt: assignment.startedAt,
      },
      select: { id: true },
    });
    await insertMovement(tx, plan.movement);
    return true;
  }

  async recordSuspension(tx: TenantTx, plan: SuspendPlan): Promise<boolean> {
    const { process, suspension } = plan;
    const updated = await tx.process.updateMany({
      where: { id: process.id, version: plan.expectedVersion, deletedAt: null },
      data: {
        status: process.status,
        statusBeforeSuspension: suspension.statusBeforeSuspension,
        suspendedAt: suspension.suspendedAt,
        suspendedById: suspension.suspendedById,
        suspensionReason: suspension.suspensionReason,
        updatedAt: process.updatedAt,
        updatedById: process.updatedById,
        version: process.version,
      },
    });
    if (updated.count !== 1) return false;
    const staged = await tx.processStage.updateMany({
      where: { id: plan.stageId, status: 'ACTIVE' },
      data: { pausedAt: plan.pausedAt, updatedAt: process.updatedAt, version: { increment: 1 } },
    });
    if (staged.count !== 1) throw new Error('Passagem ativa ausente ao suspender o processo.');
    await insertMovement(tx, plan.movement);
    return true;
  }

  async recordResume(tx: TenantTx, plan: ResumePlan): Promise<boolean> {
    const { process, stage } = plan;
    const updated = await tx.process.updateMany({
      where: { id: process.id, version: plan.expectedVersion, deletedAt: null },
      data: {
        status: process.status,
        statusBeforeSuspension: null,
        suspendedAt: null,
        suspendedById: null,
        suspensionReason: null,
        currentStageDueAt: process.currentStageDueAt,
        ...(stage.clearOverdue ? { overdueSince: null } : {}),
        updatedAt: process.updatedAt,
        updatedById: process.updatedById,
        version: process.version,
      },
    });
    if (updated.count !== 1) return false;
    const staged = await tx.processStage.updateMany({
      where: { id: stage.id, status: 'ACTIVE' },
      data: {
        pausedAt: null,
        pausedTotalSeconds: { increment: stage.pausedSeconds },
        dueAt: stage.dueAt,
        ...(stage.clearOverdue
          ? { overdueSince: null, dueSoonNotifiedAt: null, overdueNotifiedAt: null }
          : {}),
        updatedAt: process.updatedAt,
        version: { increment: 1 },
      },
    });
    if (staged.count !== 1) throw new Error('Passagem ativa ausente ao retomar o processo.');
    await insertMovement(tx, plan.movement);
    return true;
  }

  async recordCancellation(tx: TenantTx, plan: CancelPlan): Promise<boolean> {
    const { process, cancellation, stage } = plan;
    const updated = await tx.process.updateMany({
      where: { id: process.id, version: plan.expectedVersion, deletedAt: null },
      data: {
        status: process.status,
        canceledAt: cancellation.canceledAt,
        canceledById: cancellation.canceledById,
        cancellationReason: cancellation.cancellationReason,
        // FA-03: o status anterior à suspensão é descartado junto com o cancelamento.
        statusBeforeSuspension: null,
        overdueSince: null,
        updatedAt: process.updatedAt,
        updatedById: process.updatedById,
        version: process.version,
      },
    });
    if (updated.count !== 1) return false;
    await closeActivePass(tx, process.id, stage);
    await insertMovement(tx, plan.movement);
    return true;
  }

  async statusOf(tx: TenantTx, processId: string): Promise<ProcessStatus | null> {
    const row = await tx.process.findFirst({
      where: { id: processId, deletedAt: null },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  async recordDraftDiscard(tx: TenantTx, plan: DiscardPlan): Promise<boolean> {
    const updated = await tx.process.updateMany({
      where: {
        id: plan.processId,
        version: plan.expectedVersion,
        status: 'DRAFT',
        code: null,
        deletedAt: null,
      },
      data: {
        deletedAt: plan.deletedAt,
        deletedById: plan.deletedById,
        updatedAt: plan.deletedAt,
        updatedById: plan.deletedById,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) return false;
    if (plan.stage === null) {
      await tx.processAssignment.updateMany({
        where: { processId: plan.processId, isActive: true },
        data: { isActive: false, endedAt: plan.deletedAt },
      });
    } else {
      await closeActivePass(tx, plan.processId, plan.stage);
    }
    return true;
  }

  async previousAssignments(
    tx: TenantTx,
    processId: string,
    workflowStageId: string,
  ): Promise<PreviousAssignment[]> {
    const stages = await tx.processStage.findMany({
      where: { processId, workflowStageId, status: { not: 'ACTIVE' } },
      select: { id: true },
    });
    if (stages.length === 0) return [];
    return tx.processAssignment.findMany({
      where: { processId, processStageId: { in: stages.map((stage) => stage.id) } },
      select: { assigneeId: true, startedAt: true },
      orderBy: { startedAt: 'desc' },
    });
  }

  async retireCurrentAccess(
    tx: TenantTx,
    processId: string,
    departmentId: string,
    at: Date,
  ): Promise<void> {
    await tx.processAccess.updateMany({
      where: {
        processId,
        principalType: 'DEPARTMENT',
        departmentId,
        reason: 'CURRENT',
        revokedAt: null,
      },
      data: { revokedAt: at },
    });
    await this.grantAccess(
      tx,
      processId,
      [{ principalType: 'DEPARTMENT', departmentId, reason: 'HISTORICAL' }],
      at,
    );
  }

  async revokeParticipantAccess(tx: TenantTx, participantId: string, at: Date): Promise<void> {
    await tx.processAccess.updateMany({
      where: { reason: 'PARTICIPANT', sourceId: participantId, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  async internalCodeExists(
    tx: TenantTx,
    internalCode: string,
    exceptProcessId?: string,
  ): Promise<boolean> {
    const row = await tx.process.findFirst({
      where: {
        internalCode,
        deletedAt: null,
        ...(exceptProcessId === undefined ? {} : { id: { not: exceptProcessId } }),
      },
      select: { id: true },
    });
    return row !== null;
  }

  async lockForUpdate(tx: TenantTx, processId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT p.id
        FROM processes p
       WHERE p.tenant_id = current_setting('app.tenant_id')::uuid
         AND p.id = ${processId}::uuid
         AND p.deleted_at IS NULL
         FOR UPDATE`;
    return rows.length > 0;
  }

  async updateProcess(tx: TenantTx, process: Process, expectedVersion: number): Promise<boolean> {
    try {
      const result = await tx.process.updateMany({
        where: { id: process.id, version: expectedVersion, deletedAt: null },
        data: {
          organizationId: process.organizationId,
          requestingSecretariatId: process.requestingSecretariatId,
          requestingDepartmentId: process.requestingDepartmentId,
          title: process.title,
          object: process.object,
          description: process.description,
          contractingTypeId: process.contractingTypeId,
          modalityId: process.modalityId,
          isPriceRegistration: process.isPriceRegistration,
          priority: process.priority,
          targetDate: toDbDate(process.targetDate),
          estimatedValue: process.estimatedValue,
          estimatedValueSource: process.estimatedValueSource,
          isBudgetConfidential: process.isBudgetConfidential,
          originId: process.originId,
          pcaStatus: process.pcaStatus,
          pcaYear: process.pcaYear,
          pcaItemCode: process.pcaItemCode,
          pcaJustification: process.pcaJustification,
          internalCode: process.internalCode,
          notes: process.notes,
          updatedAt: process.updatedAt,
          updatedById: process.updatedById,
          version: process.version,
        },
      });
      return result.count === 1;
    } catch (error) {
      if (isUniqueViolation(error) && /internal_code/i.test(textOf(error))) {
        throw new InternalCodeTakenError(process.internalCode ?? '');
      }
      throw error;
    }
  }

  async touchProcess(tx: TenantTx, processId: string, at: Date, userId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ version: number }[]>`
      UPDATE processes
         SET version = version + 1, updated_at = ${at}, updated_by_id = ${userId}::uuid
       WHERE tenant_id = current_setting('app.tenant_id')::uuid
         AND id = ${processId}::uuid
         AND deleted_at IS NULL
      RETURNING version`;
    const [row] = rows;
    if (!row) throw new Error('Processo travado não encontrado ao incrementar a versão.');
    return row.version;
  }

  async syncRequestingAccess(tx: TenantTx, processId: string, at: Date): Promise<void> {
    const process = await tx.process.findFirst({
      where: { id: processId },
      select: { requestingSecretariatId: true, requestingDepartmentId: true },
    });
    if (process === null) return;
    const units = [...new Set([process.requestingSecretariatId, process.requestingDepartmentId])];
    await tx.processAccess.updateMany({
      where: {
        processId,
        principalType: 'DEPARTMENT',
        reason: 'REQUESTING',
        revokedAt: null,
        departmentId: { notIn: units },
      },
      data: { revokedAt: at },
    });
    await this.grantAccess(
      tx,
      processId,
      units.map((departmentId) => ({
        principalType: 'DEPARTMENT' as const,
        departmentId,
        reason: 'REQUESTING' as const,
      })),
      at,
    );
  }

  async findDuplicateCandidates(
    tx: TenantTx,
    search: DuplicateSearch,
  ): Promise<DuplicateCandidateRow[]> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        code: string | null;
        title: string;
        status: ProcessStatus;
        created_at: Date;
        created_by_id: string;
      }[]
    >`
      SELECT p.id, p.code, p.title, p.status::text AS status, p.created_at, p.created_by_id
        FROM processes p
       WHERE ${buildVisibilityPredicate(search.visibility)}
         AND p.created_at >= ${search.since}
         AND (p.created_by_id = ${search.createdById}::uuid
              OR p.requesting_department_id = ${search.requestingDepartmentId}::uuid)
         AND (similarity(p.title, ${search.title}) >= ${DUPLICATE_SIMILARITY_THRESHOLD}::real
              OR similarity(p.object, ${search.object}) >= ${DUPLICATE_SIMILARITY_THRESHOLD}::real)
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${search.limit}`;
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      createdById: row.created_by_id,
    }));
  }

  async listProcesses(tx: TenantTx, search: ProcessListSearch): Promise<ProcessListPage> {
    // US-002: tempo limite próprio da consulta (escopo da transação, como o `set_config` inicial).
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(search.statementTimeoutMs)}, true)`;
    const rows = await tx.$queryRaw<ProcessListDbRow[]>(buildProcessListSql(search));
    return {
      totalItems: rows[0]?.total ?? 0,
      rows: rows
        .filter((row): row is ProcessListDbRow & { id: string } => row.id !== null)
        .map(toProcessListRow),
    };
  }

  async countForExport(tx: TenantTx, search: ProcessExportSearch): Promise<number> {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(search.statementTimeoutMs)}, true)`;
    const [row] = await tx.$queryRaw<{ total: number }[]>(buildProcessExportCountSql(search));
    return row?.total ?? 0;
  }

  exportCursor(search: ProcessExportSearch, batchSize: number): CursorReader<ProcessListRow> {
    // Cursor no servidor (RN-PROC-45): os parâmetros vão no DECLARE (protocolo estendido); cada
    // FETCH traz um lote. Fecha sozinho no fim da transação somente leitura.
    return {
      open: async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(search.statementTimeoutMs)}, true)`;
        await tx.$executeRaw(
          Prisma.sql`DECLARE process_export NO SCROLL CURSOR FOR ${buildProcessExportSql(search)}`,
        );
      },
      next: async (tx) => {
        const rows = await tx.$queryRaw<(Omit<ProcessListDbRow, 'total'> & { id: string })[]>(
          Prisma.sql`FETCH FORWARD ${Prisma.raw(String(Math.trunc(batchSize)))} FROM process_export`,
        );
        return rows.map(toProcessListRow);
      },
    };
  }

  async hasUserGrant(tx: TenantTx, userId: string): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ granted: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM process_access pa
          JOIN processes p ON p.tenant_id = pa.tenant_id AND p.id = pa.process_id
         WHERE pa.tenant_id = current_setting('app.tenant_id')::uuid
           AND pa.principal_type = 'USER' AND pa.user_id = ${userId}::uuid
           AND pa.revoked_at IS NULL AND p.deleted_at IS NULL
      ) AS granted`;
    return row?.granted === true;
  }

  async loadAggregate(tx: TenantTx, processId: string): Promise<ProcessAggregateRows | null> {
    const rows = await tx.$queryRaw<ProcessRow[]>`
      SELECT p.id, p.tenant_id, p.organization_id, p.number, p.year, p.code, p.internal_code,
             p.title, p.object, p.description, p.contracting_type_id, p.modality_id,
             p.is_price_registration, p.requesting_secretariat_id, p.requesting_department_id,
             p.current_department_id, p.current_responsible_id, p.priority::text AS priority,
             p.status::text AS status, p.workflow_version_id, p.current_stage_id,
             p.current_workflow_stage_id, p.current_stage_due_at, p.opened_at, p.target_date,
             p.estimated_value::text AS estimated_value,
             p.estimated_value_source::text AS estimated_value_source, p.is_budget_confidential,
             p.origin_id, p.creation_channel::text AS creation_channel,
             p.pca_status::text AS pca_status, p.pca_year, p.pca_item_code, p.pca_justification,
             p.notes, p.duplicated_from_id, p.created_at, p.updated_at, p.created_by_id,
             p.updated_by_id, p.version,
             p.status_before_suspension::text AS status_before_suspension, p.suspension_reason,
             p.suspended_at, p.completed_at, p.canceled_at, p.cancellation_reason, p.overdue_since,
             (SELECT pa.started_at
                FROM process_assignments pa
               WHERE pa.tenant_id = p.tenant_id AND pa.process_id = p.id AND pa.is_active
               ORDER BY pa.started_at DESC
               LIMIT 1) AS assignment_since,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', s.id, 'workflowStageId', s.workflow_stage_id, 'sequence', s.sequence,
                        'status', s.status, 'departmentId', s.department_id,
                        'assigneeId', s.assignee_id, 'enteredAt', s.entered_at,
                        'exitedAt', s.exited_at, 'dueAt', s.due_at, 'slaDays', s.sla_days,
                        'slaType', s.sla_type, 'dueDateOverridden', s.due_date_overridden,
                        'pausedAt', s.paused_at, 'overdueSince', s.overdue_since)
                      ORDER BY s.sequence)
                 FROM process_stages s
                WHERE s.tenant_id = p.tenant_id AND s.process_id = p.id
             ), '[]'::jsonb) AS stages,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'principalType', a.principal_type, 'departmentId', a.department_id,
                        'userId', a.user_id, 'reason', a.reason))
                 FROM process_access a
                WHERE a.tenant_id = p.tenant_id AND a.process_id = p.id AND a.revoked_at IS NULL
             ), '[]'::jsonb) AS access,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', pp.id, 'userId', pp.user_id, 'departmentId', pp.department_id,
                        'role', pp.role, 'expiresAt', pp.expires_at)
                      ORDER BY pp.granted_at, pp.id)
                 FROM process_participants pp
                WHERE pp.tenant_id = p.tenant_id AND pp.process_id = p.id
                  AND pp.revoked_at IS NULL
             ), '[]'::jsonb) AS participants
        FROM processes p
       WHERE p.tenant_id = current_setting('app.tenant_id')::uuid
         AND p.id = ${processId}::uuid
         AND p.deleted_at IS NULL`;
    const [row] = rows;
    if (!row) return null;
    return {
      process: toProcess(row),
      stages: row.stages.map(toStage),
      access: row.access,
      participants: row.participants.map((participant) => ({
        ...participant,
        expiresAt: participant.expiresAt === null ? null : new Date(participant.expiresAt),
      })),
      situation: toSituation(row),
    };
  }

  async codes(tx: TenantTx, processIds: readonly string[]) {
    const rows = await tx.process.findMany({
      where: { id: { in: [...processIds] } },
      select: { id: true, code: true, isBudgetConfidential: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { code: row.code, isBudgetConfidential: row.isBudgetConfidential },
      ]),
    );
  }

  async stageRefs(tx: TenantTx, processStageIds: readonly string[]) {
    const stages = await tx.processStage.findMany({
      where: { id: { in: [...processStageIds] } },
      select: { id: true, workflowStageId: true, processId: true },
    });
    const processes = await tx.process.findMany({
      where: { id: { in: [...new Set(stages.map((stage) => stage.processId))] } },
      select: { id: true, workflowVersionId: true },
    });
    const versions = new Map(processes.map((row) => [row.id, row.workflowVersionId]));
    const refs = new Map<string, { workflowStageId: string; workflowVersionId: string }>();
    for (const stage of stages) {
      const workflowVersionId = versions.get(stage.processId);
      if (workflowVersionId) {
        refs.set(stage.id, { workflowStageId: stage.workflowStageId, workflowVersionId });
      }
    }
    return refs;
  }
}

@Injectable()
export class PrismaProcessTransactions implements ProcessTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.snapshot(work);
  }

  longRead<T>(work: (tx: TenantTx) => Promise<T>, timeoutMs: number): Promise<T> {
    return this.transaction.longRead(work, timeoutMs);
  }
}

import type {
  CreationChannel,
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

import { buildProcessListSql, toProcessListRow } from './process-list.sql.js';
import type { ProcessListDbRow } from './process-list.sql.js';
import { InternalCodeTakenError } from '../application/ports.js';
import type {
  DuplicateCandidateRow,
  DuplicateSearch,
  ProcessListPage,
  ProcessListSearch,
  ProcessAccessRow,
  ProcessAggregateRows,
  ProcessCreation,
  ProcessRepository,
  ProcessStageRow,
  ProcessTransactions,
} from '../application/ports.js';
import { DUPLICATE_SIMILARITY_THRESHOLD } from '../domain/duplicate-detection.js';
import type { AccessGrant } from '../domain/process-runtime-records.js';
import type { Process } from '../domain/process.js';

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
  }[];
  readonly access: readonly ProcessAccessRow[];
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
  };
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
    await tx.processMovement.create({
      data: {
        id: movement.id,
        tenantId: movement.tenantId,
        processId: movement.processId,
        sequence: movement.sequence,
        action: movement.action,
        toProcessStageId: movement.toProcessStageId,
        toWorkflowStageId: movement.toWorkflowStageId,
        toDepartmentId: movement.toDepartmentId,
        toUserId: movement.toUserId,
        statusFrom: movement.statusFrom,
        statusTo: movement.statusTo,
        actorType: movement.actorType,
        actorId: movement.actorId,
        dueAt: movement.dueAt,
        ip: movement.ip,
        userAgent: movement.userAgent,
        correlationId: movement.correlationId,
        metadata: movement.metadata as Prisma.InputJsonObject,
        occurredAt: movement.occurredAt,
      },
      select: { id: true },
    });
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
        grantedAt,
      })),
      skipDuplicates: true,
    });
  }

  async internalCodeExists(tx: TenantTx, internalCode: string): Promise<boolean> {
    const row = await tx.process.findFirst({
      where: { internalCode, deletedAt: null },
      select: { id: true },
    });
    return row !== null;
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
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', s.id, 'workflowStageId', s.workflow_stage_id, 'sequence', s.sequence,
                        'status', s.status, 'departmentId', s.department_id,
                        'assigneeId', s.assignee_id, 'enteredAt', s.entered_at,
                        'exitedAt', s.exited_at, 'dueAt', s.due_at) ORDER BY s.sequence)
                 FROM process_stages s
                WHERE s.tenant_id = p.tenant_id AND s.process_id = p.id
             ), '[]'::jsonb) AS stages,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'principalType', a.principal_type, 'departmentId', a.department_id,
                        'userId', a.user_id, 'reason', a.reason))
                 FROM process_access a
                WHERE a.tenant_id = p.tenant_id AND a.process_id = p.id AND a.revoked_at IS NULL
             ), '[]'::jsonb) AS access
        FROM processes p
       WHERE p.tenant_id = current_setting('app.tenant_id')::uuid
         AND p.id = ${processId}::uuid
         AND p.deleted_at IS NULL`;
    const [row] = rows;
    if (!row) return null;
    return { process: toProcess(row), stages: row.stages.map(toStage), access: row.access };
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
}

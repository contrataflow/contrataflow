import { localDateOf } from '@contrataflow/types';
import type { ProcessStageStatus } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { isProcessVisible } from '#shared/auth/process-access.js';
import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { CursorReader } from '#shared/database/transaction-stream.js';

import { InMemoryProcessParticipantRepository } from './process-participant.repositories.js';
import { InMemoryTagRepository } from './tag.repositories.js';
import { InternalCodeTakenError } from '../application/ports.js';
import type {
  DuplicateCandidateRow,
  DuplicateSearch,
  ProcessExportSearch,
  ProcessListPage,
  ProcessListRow,
  ProcessListSearch,
  ProcessAccessRow,
  ProcessAggregateRows,
  ProcessCreation,
  ProcessRepository,
  ProcessSituationRow,
} from '../application/ports.js';
import { isPossibleDuplicate } from '../domain/duplicate-detection.js';
import type { ClaimPlan } from '../domain/process-claim.js';
import {
  canViewConfidentialBudget,
  compareForOrder,
  matchesCriteria,
} from '../domain/process-list.js';
import type { ProcessListFacts } from '../domain/process-list.js';
import type { PreviousAssignment } from '../domain/process-return.js';
import type {
  AccessGrant,
  ProcessAssignmentRecord,
  ProcessMovementRecord,
  ProcessStageRecord,
} from '../domain/process-runtime-records.js';
import type { Process } from '../domain/process.js';
import type { StageTransitionPlan } from '../domain/stage-transition.js';

/**
 * Passagem guardada: a da criação (`ACTIVE`) ou, como carga de teste, as passagens que a
 * tramitação (US-047/US-048) ainda vai gravar — concluídas, devolvidas, com prazo sobrescrito.
 */
export type StoredStage = Omit<ProcessStageRecord, 'status'> & {
  readonly status: ProcessStageStatus;
  readonly exitedAt?: Date | null;
  readonly dueDateOverridden?: boolean;
  readonly pausedAt?: Date | null;
  readonly overdueSince?: Date | null;
};

const NO_SITUATION: Omit<ProcessSituationRow, 'assignmentSince'> = {
  statusBeforeSuspension: null,
  suspensionReason: null,
  suspendedAt: null,
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  overdueSince: null,
};

interface StoredAccess extends ProcessAccessRow {
  readonly processId: string;
  readonly tenantId: string;
  readonly grantedAt: Date;
  readonly sourceId: string | null;
}

/** Fatos do runtime que a criação ainda não produz (US-055/US-008/US-007) — carga de teste. */
export interface ProcessListExtras {
  readonly overdueSince: Date | null;
  readonly stagePausedAt: Date | null;
  readonly tagIds: readonly string[];
}

const NO_EXTRAS: ProcessListExtras = { overdueSince: null, stagePausedAt: null, tagIds: [] };

function tenantOfContext(): string {
  return requireRequestContext().tenantId ?? '';
}

/**
 * Processos em memória (testes e modo de identidade fake): isolados pelo tenant do contexto (como
 * a RLS), com a unicidade do código interno e a heurística de duplicidade do domínio (a mesma
 * similaridade trigram do `pg_trgm`). A transação simulada não desfaz nada — atomicidade, FKs,
 * RLS e concorrência reais são cobertas contra o PostgreSQL em `test/tenant-leak/processes.spec.ts`.
 */
@Injectable()
export class InMemoryProcessRepository implements ProcessRepository {
  private readonly processes = new Map<string, Process>();
  private readonly stages = new Map<string, StoredStage>();
  private readonly situations = new Map<string, Partial<ProcessSituationRow>>();
  private readonly assignments: ProcessAssignmentRecord[] = [];
  /** Responsabilidades encerradas (`endedAt`/`isActive = false` no PostgreSQL). */
  private readonly endedAssignments = new Map<string, Date>();
  private readonly movements: ProcessMovementRecord[] = [];
  private readonly access: StoredAccess[] = [];
  /** Concessões revogadas (`revokedAt` — RN-PROC-62), fora das leituras como no PostgreSQL. */
  private readonly revoked: (StoredAccess & { readonly revokedAt: Date })[] = [];
  private readonly extras = new Map<string, ProcessListExtras>();

  constructor(
    private readonly participants: InMemoryProcessParticipantRepository,
    private readonly tags: InMemoryTagRepository,
  ) {}

  insertCreation(_tx: TenantTx, creation: ProcessCreation): Promise<void> {
    const { process } = creation;
    if (
      process.internalCode !== null &&
      [...this.processes.values()].some(
        (other) =>
          other.tenantId === process.tenantId && other.internalCode === process.internalCode,
      )
    ) {
      return Promise.reject(new InternalCodeTakenError(process.internalCode));
    }
    this.processes.set(process.id, process);
    this.stages.set(creation.stage.id, creation.stage);
    this.assignments.push(creation.assignment);
    this.movements.push(creation.movement);
    return Promise.resolve();
  }

  grantAccess(
    _tx: TenantTx,
    processId: string,
    grants: readonly AccessGrant[],
    grantedAt: Date,
  ): Promise<void> {
    const tenantId = tenantOfContext();
    for (const grant of grants) {
      const row: StoredAccess = {
        tenantId,
        processId,
        principalType: grant.principalType,
        departmentId: grant.principalType === 'DEPARTMENT' ? grant.departmentId : null,
        userId: grant.principalType === 'USER' ? grant.userId : null,
        reason: grant.reason,
        grantedAt,
        sourceId: grant.sourceId ?? null,
      };
      const exists = this.access.some(
        (other) =>
          other.processId === processId &&
          other.principalType === row.principalType &&
          other.departmentId === row.departmentId &&
          other.userId === row.userId &&
          other.reason === row.reason,
      );
      if (!exists) this.access.push(row);
    }
    return Promise.resolve();
  }

  internalCodeExists(
    _tx: TenantTx,
    internalCode: string,
    exceptProcessId?: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.owned().some(
        (process) => process.internalCode === internalCode && process.id !== exceptProcessId,
      ),
    );
  }

  lockForUpdate(_tx: TenantTx, processId: string): Promise<boolean> {
    return Promise.resolve(this.processes.get(processId)?.tenantId === tenantOfContext());
  }

  updateProcess(_tx: TenantTx, process: Process, expectedVersion: number): Promise<boolean> {
    const current = this.processes.get(process.id);
    if (current?.tenantId !== tenantOfContext() || current.version !== expectedVersion) {
      return Promise.resolve(false);
    }
    if (
      process.internalCode !== null &&
      this.owned().some(
        (other) => other.id !== process.id && other.internalCode === process.internalCode,
      )
    ) {
      return Promise.reject(new InternalCodeTakenError(process.internalCode));
    }
    this.processes.set(process.id, { ...process, tenantId: current.tenantId });
    return Promise.resolve(true);
  }

  touchProcess(_tx: TenantTx, processId: string, at: Date, userId: string): Promise<number> {
    const current = this.processes.get(processId);
    if (current?.tenantId !== tenantOfContext())
      return Promise.reject(new Error('processo ausente'));
    const version = current.version + 1;
    this.processes.set(processId, { ...current, version, updatedAt: at, updatedById: userId });
    return Promise.resolve(version);
  }

  lastMovementSequence(_tx: TenantTx, processId: string): Promise<number> {
    return Promise.resolve(
      this.movements
        .filter((movement) => movement.processId === processId)
        .reduce((max, movement) => Math.max(max, movement.sequence), 0),
    );
  }

  recordStageTransition(_tx: TenantTx, plan: StageTransitionPlan): Promise<boolean> {
    const current = this.processes.get(plan.process.id);
    if (current?.tenantId !== tenantOfContext() || current.version !== plan.expectedVersion) {
      return Promise.resolve(false);
    }
    const closing = this.stages.get(plan.closed.id);
    if (closing?.status !== 'ACTIVE') {
      return Promise.reject(new Error('Passagem ativa ausente ao encerrar a etapa.'));
    }
    this.processes.set(plan.process.id, plan.process);
    this.stages.set(closing.id, {
      ...closing,
      status: plan.closed.status,
      exitedAt: plan.closed.exitedAt,
    });
    for (const assignment of this.assignments) {
      if (assignment.processId === plan.process.id && !this.endedAssignments.has(assignment.id)) {
        this.endedAssignments.set(assignment.id, plan.closed.exitedAt);
      }
    }
    this.stages.set(plan.entered.id, plan.entered);
    this.assignments.push(plan.assignment);
    this.movements.push(plan.movement);
    return Promise.resolve(true);
  }

  recordClaim(_tx: TenantTx, plan: ClaimPlan): Promise<boolean> {
    const current = this.processes.get(plan.process.id);
    if (current?.tenantId !== tenantOfContext() || current.version !== plan.expectedVersion) {
      return Promise.resolve(false);
    }
    const stage = this.stages.get(plan.stageId);
    if (stage?.status !== 'ACTIVE') {
      return Promise.reject(new Error('Passagem ativa ausente ao assumir o processo.'));
    }
    this.processes.set(plan.process.id, plan.process);
    this.stages.set(stage.id, { ...stage, assigneeId: plan.assignment.assigneeId });
    for (const assignment of this.assignments) {
      if (assignment.processId === plan.process.id && !this.endedAssignments.has(assignment.id)) {
        this.endedAssignments.set(assignment.id, plan.endedAt);
      }
    }
    this.assignments.push(plan.assignment);
    this.movements.push(plan.movement);
    return Promise.resolve(true);
  }

  previousAssignments(
    _tx: TenantTx,
    processId: string,
    workflowStageId: string,
  ): Promise<PreviousAssignment[]> {
    const stageIds = new Set(
      [...this.stages.values()]
        .filter(
          (stage) =>
            stage.processId === processId &&
            stage.workflowStageId === workflowStageId &&
            stage.status !== 'ACTIVE' &&
            stage.tenantId === tenantOfContext(),
        )
        .map((stage) => stage.id),
    );
    return Promise.resolve(
      this.assignments
        .filter((assignment) => stageIds.has(assignment.processStageId))
        .map((assignment) => ({
          assigneeId: assignment.assigneeId,
          startedAt: assignment.startedAt,
        })),
    );
  }

  async retireCurrentAccess(
    tx: TenantTx,
    processId: string,
    departmentId: string,
    at: Date,
  ): Promise<void> {
    for (let index = this.access.length - 1; index >= 0; index -= 1) {
      const row = this.access[index];
      if (
        row?.processId === processId &&
        row.principalType === 'DEPARTMENT' &&
        row.departmentId === departmentId &&
        row.reason === 'CURRENT'
      ) {
        this.access.splice(index, 1);
        this.revoked.push({ ...row, revokedAt: at });
      }
    }
    await this.grantAccess(
      tx,
      processId,
      [{ principalType: 'DEPARTMENT', departmentId, reason: 'HISTORICAL' }],
      at,
    );
  }

  revokeParticipantAccess(_tx: TenantTx, participantId: string, at: Date): Promise<void> {
    for (let index = this.access.length - 1; index >= 0; index -= 1) {
      const row = this.access[index];
      if (row?.reason === 'PARTICIPANT' && row.sourceId === participantId) {
        this.access.splice(index, 1);
        this.revoked.push({ ...row, revokedAt: at });
      }
    }
    return Promise.resolve();
  }

  async syncRequestingAccess(tx: TenantTx, processId: string, at: Date): Promise<void> {
    const process = this.processes.get(processId);
    if (process?.tenantId !== tenantOfContext()) return;
    const units = new Set([process.requestingSecretariatId, process.requestingDepartmentId]);
    for (let index = this.access.length - 1; index >= 0; index -= 1) {
      const row = this.access[index];
      if (
        row?.processId === processId &&
        row.principalType === 'DEPARTMENT' &&
        row.reason === 'REQUESTING' &&
        !units.has(row.departmentId ?? '')
      ) {
        this.access.splice(index, 1);
        this.revoked.push({ ...row, revokedAt: at });
      }
    }
    await this.grantAccess(
      tx,
      processId,
      [...units].map((departmentId) => ({
        principalType: 'DEPARTMENT' as const,
        departmentId,
        reason: 'REQUESTING' as const,
      })),
      at,
    );
  }

  findDuplicateCandidates(
    _tx: TenantTx,
    search: DuplicateSearch,
  ): Promise<DuplicateCandidateRow[]> {
    const rows = this.owned()
      .filter((process) => isPossibleDuplicate(process, search))
      .filter((process) =>
        isProcessVisible(search.visibility, {
          organizationId: process.organizationId,
          ...this.grantsOf(process.id),
        }),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, search.limit)
      .map((process) => ({
        id: process.id,
        code: process.code,
        title: process.title,
        status: process.status,
        createdAt: process.createdAt,
        createdById: process.createdById,
      }));
    return Promise.resolve(rows);
  }

  listProcesses(_tx: TenantTx, search: ProcessListSearch): Promise<ProcessListPage> {
    const all = this.filteredRows(search, null);
    const start = (search.page - 1) * search.pageSize;
    return Promise.resolve(
      structuredClone({
        rows: all.slice(start, start + search.pageSize),
        totalItems: all.length,
      }),
    );
  }

  countForExport(_tx: TenantTx, search: ProcessExportSearch): Promise<number> {
    return Promise.resolve(this.filteredRows(search, search.exportCoverage).length);
  }

  exportCursor(search: ProcessExportSearch, batchSize: number): CursorReader<ProcessListRow> {
    let rows: ProcessListRow[] = [];
    let position = 0;
    return {
      open: () => {
        rows = structuredClone(this.filteredRows(search, search.exportCoverage));
        return Promise.resolve();
      },
      next: () => {
        const batch = rows.slice(position, position + batchSize);
        position += batch.length;
        return Promise.resolve(batch);
      },
    };
  }

  /** Visíveis, cobertos pela exportação (quando informada), filtrados e ordenados. */
  private filteredRows(
    search: Omit<ProcessListSearch, 'page' | 'pageSize'>,
    coverage: ProcessVisibilityScope | null,
  ): ProcessListRow[] {
    const clock = {
      now: search.now,
      today: search.today,
      localDate: (instant: Date) => localDateOf(instant, search.timezone),
    };
    const reasons = new Set(
      search.historicalDepartmentsCanView
        ? ['REQUESTING', 'CURRENT', 'HISTORICAL']
        : ['REQUESTING', 'CURRENT'],
    );
    const canView = new Map<string, boolean>();
    const facts: ProcessListFacts[] = [];
    for (const process of this.owned()) {
      const rows = this.access.filter((row) => row.processId === process.id);
      const departmentIds = rows.flatMap((row) =>
        row.principalType === 'DEPARTMENT' && row.departmentId !== null && reasons.has(row.reason)
          ? [row.departmentId]
          : [],
      );
      const participantDepartmentIds = rows.flatMap((row) =>
        row.principalType === 'DEPARTMENT' &&
        row.departmentId !== null &&
        row.reason === 'PARTICIPANT'
          ? [row.departmentId]
          : [],
      );
      const userIds = rows.flatMap((row) => (row.userId === null ? [] : [row.userId]));
      if (
        !isProcessVisible(search.visibility, {
          organizationId: process.organizationId,
          departmentIds,
          userIds,
          participantDepartmentIds,
        })
      ) {
        continue;
      }
      const extras = this.extras.get(process.id) ?? NO_EXTRAS;
      const fact: ProcessListFacts = {
        ...process,
        overdueSince: extras.overdueSince,
        tagIds: [...extras.tagIds, ...this.tags.tagIdsOf(process.id)],
      };
      if (
        coverage !== null &&
        !coverage.tenantWide &&
        !coverage.organizationIds.includes(process.organizationId) &&
        !departmentIds.some((id) => coverage.departmentIds.includes(id))
      ) {
        continue;
      }
      const visible = canViewConfidentialBudget(fact, search.budget, departmentIds);
      if (!matchesCriteria(fact, search.criteria, clock, visible)) continue;
      canView.set(process.id, visible);
      facts.push(fact);
    }
    facts.sort(
      compareForOrder(
        search.order,
        search.criteria.search,
        (fact) => canView.get(fact.id) ?? false,
      ),
    );
    return facts.map((fact): ProcessListRow => {
      const visible = canView.get(fact.id) ?? false;
      // A passagem gravada pela criação é sempre a ativa (as demais vêm com a US-047).
      const stage = [...this.stages.values()].find(
        (candidate) => candidate.processId === fact.id && candidate.status === 'ACTIVE',
      );
      return {
        id: fact.id,
        organizationId: fact.organizationId,
        number: fact.number,
        year: fact.year,
        code: fact.code,
        internalCode: fact.internalCode,
        title: fact.title,
        status: fact.status,
        priority: fact.priority,
        requestingSecretariatId: fact.requestingSecretariatId,
        requestingDepartmentId: fact.requestingDepartmentId,
        currentDepartmentId: fact.currentDepartmentId,
        currentResponsibleId: fact.currentResponsibleId,
        currentWorkflowStageId: fact.currentWorkflowStageId,
        currentStageDueAt: fact.currentStageDueAt,
        overdueSince: fact.overdueSince,
        contractingTypeId: fact.contractingTypeId,
        modalityId: fact.modalityId,
        originId: fact.originId,
        isBudgetConfidential: fact.isBudgetConfidential,
        canViewBudget: visible,
        estimatedValue: visible ? fact.estimatedValue : null,
        targetDate: fact.targetDate,
        openedAt: fact.openedAt,
        createdAt: fact.createdAt,
        updatedAt: fact.updatedAt,
        tagIds: fact.tagIds,
        slaType: stage?.slaType ?? null,
        stagePausedAt: this.extras.get(fact.id)?.stagePausedAt ?? null,
      };
    });
  }

  hasUserGrant(_tx: TenantTx, userId: string): Promise<boolean> {
    const owned = new Set(this.owned().map((process) => process.id));
    return Promise.resolve(
      this.access.some(
        (row) => row.principalType === 'USER' && row.userId === userId && owned.has(row.processId),
      ),
    );
  }

  loadAggregate(_tx: TenantTx, processId: string): Promise<ProcessAggregateRows | null> {
    const process = this.processes.get(processId);
    if (process?.tenantId !== tenantOfContext()) return Promise.resolve(null);
    const stages = [...this.stages.values()]
      .filter((stage) => stage.processId === processId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((stage) => ({
        id: stage.id,
        workflowStageId: stage.workflowStageId,
        sequence: stage.sequence,
        status: stage.status,
        departmentId: stage.departmentId,
        assigneeId: stage.assigneeId,
        enteredAt: stage.enteredAt,
        exitedAt: stage.exitedAt ?? null,
        dueAt: stage.dueAt,
        slaDays: stage.slaDays,
        slaType: stage.slaType,
        dueDateOverridden: stage.dueDateOverridden ?? false,
        pausedAt:
          stage.pausedAt ??
          (stage.status === 'ACTIVE' ? (this.extras.get(processId)?.stagePausedAt ?? null) : null),
        overdueSince: stage.overdueSince ?? null,
      }));
    const access = this.access
      .filter((row) => row.processId === processId)
      .map(({ principalType, departmentId, userId, reason }) => ({
        principalType,
        departmentId,
        userId,
        reason,
      }));
    const active = this.assignments
      .filter((assignment) => assignment.processId === processId)
      .at(-1);
    const situation: ProcessSituationRow = {
      ...NO_SITUATION,
      overdueSince: this.extras.get(processId)?.overdueSince ?? null,
      assignmentSince: active?.startedAt ?? null,
      ...this.situations.get(processId),
    };
    const participants = this.participants
      .activeOf(processId)
      .map(({ id, userId, departmentId, role, expiresAt }) => ({
        id,
        userId,
        departmentId,
        role,
        expiresAt,
      }));
    return Promise.resolve(structuredClone({ process, stages, access, participants, situation }));
  }

  codes(_tx: TenantTx, processIds: readonly string[]) {
    const owned = new Map(this.owned().map((process) => [process.id, process]));
    const refs = new Map<string, { code: string | null; isBudgetConfidential: boolean }>();
    for (const id of processIds) {
      const process = owned.get(id);
      if (process) {
        refs.set(id, { code: process.code, isBudgetConfidential: process.isBudgetConfidential });
      }
    }
    return Promise.resolve(refs);
  }

  stageRefs(_tx: TenantTx, processStageIds: readonly string[]) {
    const owned = new Map(this.owned().map((process) => [process.id, process]));
    const refs = new Map<string, { workflowStageId: string; workflowVersionId: string }>();
    for (const id of processStageIds) {
      const stage = this.stages.get(id);
      const process = stage ? owned.get(stage.processId) : undefined;
      if (stage && process) {
        refs.set(id, {
          workflowStageId: stage.workflowStageId,
          workflowVersionId: process.workflowVersionId,
        });
      }
    }
    return Promise.resolve(refs);
  }

  // --- Inspeção (testes) -----------------------------------------------------------------------

  /** Processos de todos os tenants. */
  allProcesses(): readonly Process[] {
    return [...this.processes.values()];
  }

  stagesOf(processId: string): readonly StoredStage[] {
    return [...this.stages.values()].filter((stage) => stage.processId === processId);
  }

  assignmentsOf(processId: string): readonly (ProcessAssignmentRecord & {
    readonly isActive: boolean;
  })[] {
    return this.assignments
      .filter((assignment) => assignment.processId === processId)
      .map((assignment) => ({
        ...assignment,
        isActive: !this.endedAssignments.has(assignment.id),
      }));
  }

  movementsOf(processId: string): readonly ProcessMovementRecord[] {
    return this.movements.filter((movement) => movement.processId === processId);
  }

  accessOf(processId: string): readonly StoredAccess[] {
    return this.access.filter((row) => row.processId === processId);
  }

  /** Concessões revogadas do processo (RN-PROC-62). */
  revokedAccessOf(processId: string): readonly (StoredAccess & { readonly revokedAt: Date })[] {
    return this.revoked.filter((row) => row.processId === processId);
  }

  /** Carga de teste: processo já existente (ex.: candidato a duplicidade criado antes). */
  seed(process: Process, grants: readonly AccessGrant[] = []): void {
    this.processes.set(process.id, process);
    for (const grant of grants) {
      this.access.push({
        tenantId: process.tenantId,
        processId: process.id,
        principalType: grant.principalType,
        departmentId: grant.principalType === 'DEPARTMENT' ? grant.departmentId : null,
        userId: grant.principalType === 'USER' ? grant.userId : null,
        reason: grant.reason,
        grantedAt: process.createdAt,
        sourceId: grant.sourceId ?? null,
      });
    }
  }

  /** Carga de teste: atraso, pausa e etiquetas que as stories donas ainda vão gravar. */
  setListExtras(processId: string, extras: Partial<ProcessListExtras>): void {
    this.extras.set(processId, { ...(this.extras.get(processId) ?? NO_EXTRAS), ...extras });
  }

  /** Carga de teste: responsabilidade de uma passagem (histórico de `PREVIOUS_ASSIGNEE` — US-048). */
  seedAssignment(assignment: ProcessAssignmentRecord, endedAt: Date | null = null): void {
    this.assignments.push(assignment);
    if (endedAt !== null) this.endedAssignments.set(assignment.id, endedAt);
  }

  /** Carga de teste: uma passagem do processo (a ativa com o SLA da etapa, ou já encerrada). */
  seedStage(stage: StoredStage): void {
    this.stages.set(stage.id, stage);
  }

  /** Carga de teste: suspensão, conclusão, cancelamento e o início da responsabilidade ativa. */
  setSituation(processId: string, situation: Partial<ProcessSituationRow>): void {
    this.situations.set(processId, { ...this.situations.get(processId), ...situation });
  }

  /** Carga de teste: troca o agregado (reatribuição, suspensão…) como a tramitação faria. */
  replace(process: Process): void {
    this.processes.set(process.id, process);
  }

  clear(): void {
    this.extras.clear();
    this.processes.clear();
    this.stages.clear();
    this.situations.clear();
    this.assignments.length = 0;
    this.endedAssignments.clear();
    this.movements.length = 0;
    this.access.length = 0;
    this.revoked.length = 0;
  }

  private owned(): Process[] {
    const tenantId = tenantOfContext();
    return [...this.processes.values()].filter((process) => process.tenantId === tenantId);
  }

  private grantsOf(processId: string): { departmentIds: string[]; userIds: string[] } {
    const rows = this.access.filter((row) => row.processId === processId);
    return {
      departmentIds: rows.flatMap((row) => (row.departmentId === null ? [] : [row.departmentId])),
      userIds: rows.flatMap((row) => (row.userId === null ? [] : [row.userId])),
    };
  }
}

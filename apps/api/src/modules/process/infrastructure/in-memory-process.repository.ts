import { Injectable } from '@nestjs/common';

import { isProcessVisible } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { InternalCodeTakenError } from '../application/ports.js';
import type {
  DuplicateCandidateRow,
  DuplicateSearch,
  ProcessAccessRow,
  ProcessAggregateRows,
  ProcessCreation,
  ProcessRepository,
} from '../application/ports.js';
import { isPossibleDuplicate } from '../domain/duplicate-detection.js';
import type {
  AccessGrant,
  ProcessAssignmentRecord,
  ProcessMovementRecord,
  ProcessStageRecord,
} from '../domain/process-runtime-records.js';
import type { Process } from '../domain/process.js';

interface StoredAccess extends ProcessAccessRow {
  readonly processId: string;
  readonly tenantId: string;
  readonly grantedAt: Date;
}

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
  private readonly stages = new Map<string, ProcessStageRecord>();
  private readonly assignments: ProcessAssignmentRecord[] = [];
  private readonly movements: ProcessMovementRecord[] = [];
  private readonly access: StoredAccess[] = [];

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

  internalCodeExists(_tx: TenantTx, internalCode: string): Promise<boolean> {
    return Promise.resolve(this.owned().some((process) => process.internalCode === internalCode));
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
        exitedAt: null,
        dueAt: stage.dueAt,
      }));
    const access = this.access
      .filter((row) => row.processId === processId)
      .map(({ principalType, departmentId, userId, reason }) => ({
        principalType,
        departmentId,
        userId,
        reason,
      }));
    return Promise.resolve(structuredClone({ process, stages, access }));
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

  stagesOf(processId: string): readonly ProcessStageRecord[] {
    return [...this.stages.values()].filter((stage) => stage.processId === processId);
  }

  assignmentsOf(processId: string): readonly ProcessAssignmentRecord[] {
    return this.assignments.filter((assignment) => assignment.processId === processId);
  }

  movementsOf(processId: string): readonly ProcessMovementRecord[] {
    return this.movements.filter((movement) => movement.processId === processId);
  }

  accessOf(processId: string): readonly StoredAccess[] {
    return this.access.filter((row) => row.processId === processId);
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
      });
    }
  }

  clear(): void {
    this.processes.clear();
    this.stages.clear();
    this.assignments.length = 0;
    this.movements.length = 0;
    this.access.length = 0;
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

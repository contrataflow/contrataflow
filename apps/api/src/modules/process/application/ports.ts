import type { ProcessStageStatus, ProcessStatus } from '@contrataflow/validation';

import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  AccessGrant,
  ProcessAssignmentRecord,
  ProcessMovementRecord,
  ProcessStageRecord,
} from '../domain/process-runtime-records.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import type { Process } from '../domain/process.js';

/*
 * Portas da aplicação do módulo `process`. US-041: leitor do runtime para o motor de workflow
 * (PRC-08/PRC-09). US-001: repositório do agregado (criação atômica, duplicidade, código interno),
 * concessões de acesso (projetor síncrono), transações de escrita e relógio. Implementações em
 * `infrastructure/` (PostgreSQL) e em memória (testes e modo de identidade fake).
 */

export interface ProcessRuntimeReader {
  /**
   * O runtime do processo NUM ÚNICO snapshot (processo + passagens + aprovações + documentos +
   * acessos lidos de uma vez, sob `READ COMMITTED` — nunca a etapa de antes misturada com a de
   * depois de uma tramitação concorrente). `null` = inexistente no tenant da transação (RLS),
   * descartado (`deletedAt`) ou de outro tenant.
   */
  load(tx: TenantTx, processId: string): Promise<ProcessRuntime | null>;
}

export const PROCESS_RUNTIME_READER = Symbol('ProcessRuntimeReader');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface ProcessTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const PROCESS_TRANSACTIONS = Symbol('ProcessTransactions');

export type ProcessClock = () => Date;

export const PROCESS_CLOCK = Symbol('ProcessClock');

/** `internal_code` já usado no tenant (índice único parcial `processes_internal_code_key` — V-10). */
export class InternalCodeTakenError extends Error {
  constructor(readonly internalCode: string) {
    super('Código interno de processo já usado no tenant.');
    this.name = 'InternalCodeTakenError';
  }
}

/** Tudo o que a criação grava de uma vez (RN-PROC-15): agregado, passagem, responsável e tramitação. */
export interface ProcessCreation {
  readonly process: Process;
  readonly stage: ProcessStageRecord;
  readonly assignment: ProcessAssignmentRecord;
  readonly movement: ProcessMovementRecord;
}

export interface DuplicateSearch {
  readonly title: string;
  readonly object: string;
  readonly requestingDepartmentId: string;
  readonly createdById: string;
  /** Início da janela `process.duplicateDetectionWindowMinutes`. */
  readonly since: Date;
  /** Só processos que o usuário vê (DEC-024): nunca revela título de processo invisível. */
  readonly visibility: ProcessVisibilityScope;
  readonly limit: number;
}

export interface DuplicateCandidateRow {
  readonly id: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: ProcessStatus;
  readonly createdAt: Date;
  readonly createdById: string;
}

/** Passagem como o runtime a lê. */
export interface ProcessStageRow {
  readonly id: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly status: ProcessStageStatus;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly enteredAt: Date;
  readonly exitedAt: Date | null;
  readonly dueAt: Date | null;
}

/** Concessão ativa como o runtime a lê. */
export interface ProcessAccessRow {
  readonly principalType: 'DEPARTMENT' | 'USER';
  readonly departmentId: string | null;
  readonly userId: string | null;
  readonly reason: string;
}

/** Processo + passagens + concessões ativas lidos numa ÚNICA instrução (um snapshot). */
export interface ProcessAggregateRows {
  readonly process: Process;
  readonly stages: readonly ProcessStageRow[];
  readonly access: readonly ProcessAccessRow[];
}

export interface ProcessRepository {
  /**
   * Grava processo, passagem nº 1, responsabilidade e tramitação nº 1 no `tx` (a FK circular
   * `current_stage_id` é verificada no commit). @throws InternalCodeTakenError
   */
  insertCreation(tx: TenantTx, creation: ProcessCreation): Promise<void>;
  /** Concessões `ProcessAccess` (idempotente por principal + motivo ativos). */
  grantAccess(
    tx: TenantTx,
    processId: string,
    grants: readonly AccessGrant[],
    grantedAt: Date,
  ): Promise<void>;
  /** RN-PROC-09: código interno já usado por processo não descartado do tenant. */
  internalCodeExists(tx: TenantTx, internalCode: string): Promise<boolean>;
  /** RN-PROC-13: candidatos visíveis, mais recentes primeiro. */
  findDuplicateCandidates(tx: TenantTx, search: DuplicateSearch): Promise<DuplicateCandidateRow[]>;
  /** O agregado com passagens e concessões, ou `null` (outro tenant, inexistente, descartado). */
  loadAggregate(tx: TenantTx, processId: string): Promise<ProcessAggregateRows | null>;
  /** Códigos e sigilo dos processos (fonte `PROCESS` da timeline — nomes congelados). */
  codes(
    tx: TenantTx,
    processIds: readonly string[],
  ): Promise<Map<string, { readonly code: string | null; readonly isBudgetConfidential: boolean }>>;
  /** Etapa de workflow e versão fixada de cada passagem (fonte `PROCESS_STAGE` da timeline). */
  stageRefs(
    tx: TenantTx,
    processStageIds: readonly string[],
  ): Promise<Map<string, { readonly workflowStageId: string; readonly workflowVersionId: string }>>;
}

export const PROCESS_REPOSITORY = Symbol('ProcessRepository');

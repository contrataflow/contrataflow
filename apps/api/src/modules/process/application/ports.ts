import type { DayCountType, ProcessStageStatus, ProcessStatus } from '@contrataflow/validation';

import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { ProcessItem } from '../domain/process-items.js';
import type {
  ProcessListCriteria,
  ProcessListFacts,
  ProcessListOrder,
} from '../domain/process-list.js';
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
  /** Leitura em instantâneo único (`REPEATABLE READ READ ONLY` — painel situacional, RN-PROC-56). */
  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
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
  /** SLA congelado na entrada (stepper — RN-PROC-52). */
  readonly slaDays: number | null;
  readonly slaType: DayCountType | null;
  readonly dueDateOverridden: boolean;
  /** Prazo pausado (processo suspenso). */
  readonly pausedAt: Date | null;
  readonly overdueSince: Date | null;
}

/**
 * Situação do processo que o painel mostra (US-004 · RN-PROC-48): suspensão, conclusão,
 * cancelamento, atraso e o início da responsabilidade ativa — no mesmo snapshot do agregado.
 */
export interface ProcessSituationRow {
  readonly statusBeforeSuspension: ProcessStatus | null;
  readonly suspensionReason: string | null;
  readonly suspendedAt: Date | null;
  readonly completedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly overdueSince: Date | null;
  /** `startedAt` da `ProcessAssignment` ativa. */
  readonly assignmentSince: Date | null;
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
  readonly situation: ProcessSituationRow;
}

/**
 * Quem desmascara o valor sigiloso por linha (POL-09 · RN-PROC-25): escopos de
 * `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (vazios sem o MFA exigido) e a custódia atual.
 */
export interface BudgetVisibility {
  readonly userId: string;
  readonly tenantWide: boolean;
  readonly organizationIds: readonly string[];
  readonly departmentIds: readonly string[];
  /** Lotações ativas do vínculo: custódia do processo na fila da unidade (sem responsável). */
  readonly custodyDepartmentIds: readonly string[];
}

/** Consulta da lista de processos (US-002 · PRC-01), com os critérios já resolvidos. */
export interface ProcessListSearch {
  readonly criteria: ProcessListCriteria;
  readonly order: ProcessListOrder;
  readonly page: number;
  readonly pageSize: number;
  readonly now: Date;
  /** Fuso IANA do tenant e o "hoje" local (RN-PROC-23/31). */
  readonly timezone: string;
  readonly today: string;
  /** Predicado de visibilidade (DEC-024 · RN-PROC-19). */
  readonly visibility: ProcessVisibilityScope;
  readonly historicalDepartmentsCanView: boolean;
  readonly budget: BudgetVisibility;
  /** `statement_timeout` da consulta (US-002: 3 s). */
  readonly statementTimeoutMs: number;
}

/** Linha da lista: fatos desnormalizados (RN-PROC-29), sigilo resolvido e a etapa ativa. */
export interface ProcessListRow extends Omit<
  ProcessListFacts,
  'object' | 'description' | 'estimatedValue'
> {
  /** `null` quando não informado OU mascarado (`canViewBudget = false` em processo sigiloso). */
  readonly estimatedValue: string | null;
  /** POL-09 para a linha (permissão com escopo que a cubra ou custódia atual). */
  readonly canViewBudget: boolean;
  readonly slaType: DayCountType | null;
  /** `pausedAt` da passagem ativa (processo suspenso). */
  readonly stagePausedAt: Date | null;
}

export interface ProcessListPage {
  readonly rows: readonly ProcessListRow[];
  /** Total do mesmo snapshot da página (uma única instrução). */
  readonly totalItems: number;
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
  /**
   * RN-PROC-09/70: código interno já usado por processo não descartado do tenant (fora o
   * `exceptProcessId`, na edição).
   */
  internalCodeExists(
    tx: TenantTx,
    internalCode: string,
    exceptProcessId?: string,
  ): Promise<boolean>;
  /**
   * US-005: `SELECT … FOR UPDATE` no processo (serializa a edição com tramitações e com a derivação
   * do valor estimado — DEC-055). `false` = inexistente no tenant ou descartado.
   */
  lockForUpdate(tx: TenantTx, processId: string): Promise<boolean>;
  /**
   * US-005: grava os campos editáveis, `estimatedValueSource`, `updatedAt`, `updatedById` e a nova
   * `version` se a versão gravada ainda for `expectedVersion` (`false` = outra escrita venceu).
   * @throws InternalCodeTakenError
   */
  updateProcess(tx: TenantTx, process: Process, expectedVersion: number): Promise<boolean>;
  /**
   * US-006 (RN-PROC-81): itens são do agregado — `version + 1`, `updatedAt` e `updatedById` do
   * processo (já travado pelo chamador). Devolve a nova versão.
   */
  touchProcess(tx: TenantTx, processId: string, at: Date, userId: string): Promise<number>;
  /**
   * RN-PROC-62: concessões `REQUESTING` iguais à secretaria e ao setor solicitantes ATUAIS do
   * processo — revoga (`revokedAt`) as anteriores e concede as novas, no `tx`.
   */
  syncRequestingAccess(tx: TenantTx, processId: string, at: Date): Promise<void>;
  /** RN-PROC-13: candidatos visíveis, mais recentes primeiro. */
  findDuplicateCandidates(tx: TenantTx, search: DuplicateSearch): Promise<DuplicateCandidateRow[]>;
  /** US-002 · PRC-01: página e total, visíveis e filtrados, num único snapshot. */
  listProcesses(tx: TenantTx, search: ProcessListSearch): Promise<ProcessListPage>;
  /** DEC-024 cond. 4: o usuário tem alguma concessão `USER` ativa em processo não descartado. */
  hasUserGrant(tx: TenantTx, userId: string): Promise<boolean>;
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

/** Contagem dos itens ativos para o painel e o `RuleContext` (`itemsCount`/`hasLots` — RN-PROC-82). */
export interface ProcessItemStats {
  readonly count: number;
  readonly hasLots: boolean;
}

/**
 * Itens da contratação (US-006 · `process_items`): sempre no `tx` do comando, que já travou o
 * processo (`lockForUpdate` — serializa inclusões, reordenações e exclusões do mesmo processo).
 */
export interface ProcessItemRepository {
  /** Itens não excluídos do processo, por `sequence`. */
  listActive(tx: TenantTx, processId: string): Promise<ProcessItem[]>;
  /** O processo do item não excluído (`null` = inexistente, excluído ou de outro tenant — RLS). */
  processOf(tx: TenantTx, itemId: string): Promise<string | null>;
  /** `SELECT … FOR UPDATE` no item não excluído (corrida com a inclusão em documento — RN-PROC-79). */
  lockItem(tx: TenantTx, itemId: string): Promise<ProcessItem | null>;
  insert(tx: TenantTx, item: ProcessItem): Promise<void>;
  /** Grava os campos editáveis, `updatedAt`/`updatedById` e `version` de cada item. */
  update(tx: TenantTx, items: readonly ProcessItem[]): Promise<void>;
  /** Exclusão lógica (`deletedAt`, `deletedById`, `version + 1`). */
  softDelete(tx: TenantTx, item: ProcessItem, at: Date, userId: string): Promise<void>;
  /**
   * RN-PROC-74: grava os novos números em DUAS fases (negativos → definitivos), sem violar o
   * índice único parcial de `sequence`; `version + 1` em cada item renumerado.
   */
  resequence(
    tx: TenantTx,
    changes: readonly { readonly id: string; readonly to: number }[],
    at: Date,
    userId: string,
  ): Promise<void>;
  stats(tx: TenantTx, processId: string): Promise<ProcessItemStats>;
}

export const PROCESS_ITEM_REPOSITORY = Symbol('ProcessItemRepository');

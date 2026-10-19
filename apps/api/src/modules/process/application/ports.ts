import type { DayCountType, ProcessStageStatus, ProcessStatus } from '@contrataflow/validation';

import type { ParticipantRole, ProcessVisibilityScope } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { CursorReader } from '#shared/database/transaction-stream.js';

import type { CancelPlan, DiscardPlan } from '../domain/process-cancellation.js';
import type { ClaimPlan } from '../domain/process-claim.js';
import type { ProcessItem } from '../domain/process-items.js';
import type {
  ProcessListCriteria,
  ProcessListFacts,
  ProcessListOrder,
} from '../domain/process-list.js';
import type { MovementFeedSearch, StoredMovement } from '../domain/process-movements.js';
import type { ProcessParticipant } from '../domain/process-participants.js';
import type { PreviousAssignment } from '../domain/process-return.js';
import type {
  AccessGrant,
  ProcessAssignmentRecord,
  ProcessMovementRecord,
  ProcessStageRecord,
} from '../domain/process-runtime-records.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import type { ResumePlan, SuspendPlan } from '../domain/process-suspension.js';
import type { Process } from '../domain/process.js';
import type { SavedView } from '../domain/saved-view.js';
import type { StageTransitionPlan } from '../domain/stage-transition.js';
import type { Tag, TagSetDiff } from '../domain/tag.js';

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
  /**
   * Leitura longa somente leitura (exportação por cursor — US-003 · RN-PROC-45): `statement_timeout`
   * e tempo da transação iguais a `timeoutMs`.
   */
  longRead<T>(work: (tx: TenantTx) => Promise<T>, timeoutMs: number): Promise<T>;
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

/** Participação não revogada como o runtime a lê (US-012 — a validade é conferida no uso). */
export interface ProcessParticipantRow {
  readonly id: string;
  readonly userId: string | null;
  readonly departmentId: string | null;
  readonly role: ParticipantRole;
  readonly expiresAt: Date | null;
}

/** Processo + passagens + concessões ativas lidos numa ÚNICA instrução (um snapshot). */
export interface ProcessAggregateRows {
  readonly process: Process;
  readonly stages: readonly ProcessStageRow[];
  readonly access: readonly ProcessAccessRow[];
  /** Participações não revogadas (US-012). */
  readonly participants: readonly ProcessParticipantRow[];
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

/**
 * Exportação (US-003 · PRC-34 · RN-PROC-40): os mesmos critérios e ordenação da lista, sem
 * paginação, e só os processos visíveis E cobertos pelo escopo de `PROCESS_EXPORT` (tenant, órgão
 * ou unidade com `ProcessAccess` — sem concessão própria).
 */
export interface ProcessExportSearch extends Omit<ProcessListSearch, 'page' | 'pageSize'> {
  readonly exportCoverage: ProcessVisibilityScope;
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
   * US-005: grava os campos editáveis, `estimatedValueSource`, `isBudgetConfidential` (só mudado
   * pelo PRC-33 — US-013), `updatedAt`, `updatedById` e a nova `version` se a versão gravada ainda
   * for `expectedVersion` (`false` = outra escrita venceu).
   * @throws InternalCodeTakenError
   */
  updateProcess(tx: TenantTx, process: Process, expectedVersion: number): Promise<boolean>;
  /**
   * US-006 (RN-PROC-81): itens são do agregado — `version + 1`, `updatedAt` e `updatedById` do
   * processo (já travado pelo chamador). Devolve a nova versão.
   */
  touchProcess(tx: TenantTx, processId: string, at: Date, userId: string): Promise<number>;
  /**
   * US-012: revoga (`revokedAt`) a concessão `PARTICIPANT` ativa cuja origem é o participante.
   */
  revokeParticipantAccess(tx: TenantTx, participantId: string, at: Date): Promise<void>;
  /**
   * RN-PROC-62: concessões `REQUESTING` iguais à secretaria e ao setor solicitantes ATUAIS do
   * processo — revoga (`revokedAt`) as anteriores e concede as novas, no `tx`.
   */
  syncRequestingAccess(tx: TenantTx, processId: string, at: Date): Promise<void>;
  /** US-047: maior `sequence` das tramitações do processo (0 = nenhuma). */
  lastMovementSequence(tx: TenantTx, processId: string): Promise<number>;
  /**
   * PRC-11 (US-054): tramitações do processo que casam os filtros, `sequence` decrescente, antes do
   * cursor, até `take` (RN-TRAM-72/75). Somente leitura — `process_movements` é imutável.
   */
  listMovements(tx: TenantTx, search: MovementFeedSearch): Promise<StoredMovement[]>;
  /**
   * US-047 (RN-TRAM-14..16 · RN-TRAM-21): grava a mudança de etapa no `tx` — o processo
   * (`WHERE version = expectedVersion`, `overdueSince = null`), o encerramento da passagem e da
   * responsabilidade ativas, a nova passagem, a nova responsabilidade e a tramitação (só INSERT).
   * `false` = outra escrita venceu (nada gravado).
   */
  recordStageTransition(tx: TenantTx, plan: StageTransitionPlan): Promise<boolean>;
  /**
   * US-049 (RN-TRAM-33): grava o "assumir" no `tx` — o processo (`WHERE version = expectedVersion`),
   * o responsável da passagem ativa, o encerramento da responsabilidade ativa (a da fila), a nova
   * responsabilidade `CLAIM` e a tramitação (só INSERT). A passagem NÃO muda. `false` = outra
   * escrita venceu (nada gravado).
   */
  recordClaim(tx: TenantTx, plan: ClaimPlan): Promise<boolean>;
  /**
   * US-008 (RN-PROC-94/95): grava a suspensão no `tx` — o processo (`WHERE version =
   * expectedVersion`: status, `statusBeforeSuspension`, `suspendedAt/ById`, `suspensionReason`), a
   * pausa da passagem ativa (`pausedAt`) e a tramitação `SUSPEND`. `false` = outra escrita venceu.
   */
  recordSuspension(tx: TenantTx, plan: SuspendPlan): Promise<boolean>;
  /**
   * US-008 (RN-PROC-97..99): grava a retomada no `tx` — o processo (status restaurado, campos de
   * suspensão limpos, `currentStageDueAt` e, se o atraso acabou, `overdueSince = null`), a passagem
   * (`pausedAt = null`, `pausedTotalSeconds += n`, `dueAt` e os avisos) e a tramitação `RESUME`.
   * `false` = outra escrita venceu.
   */
  recordResume(tx: TenantTx, plan: ResumePlan): Promise<boolean>;
  /**
   * US-009 (RN-PROC-104/107): grava o cancelamento no `tx` — o processo (`WHERE version =
   * expectedVersion`: `CANCELED`, `canceledAt/ById`, `cancellationReason`, `statusBeforeSuspension`
   * e `overdueSince` limpos), a passagem ativa (`CANCELED`, `exitedAt`, `exitedViaMovementId`), a
   * responsabilidade ativa encerrada e a tramitação `CANCEL`. `false` = outra escrita venceu.
   */
  recordCancellation(tx: TenantTx, plan: CancelPlan): Promise<boolean>;
  /**
   * US-009: o status do processo não excluído, sem trava (`null` = inexistente, excluído ou de outro
   * tenant) — a leitura "na chegada" que separa a corrida perdida (412) do reenvio (409).
   */
  statusOf(tx: TenantTx, processId: string): Promise<ProcessStatus | null>;
  /**
   * US-009 (RN-PROC-108/109): exclusão lógica do rascunho sem número (`deletedAt`, `deletedById`,
   * `version + 1`, só se ainda `DRAFT` sem `code` na versão esperada), a passagem ativa encerrada
   * como `CANCELED` e a responsabilidade ativa encerrada. `false` = outra escrita venceu.
   */
  recordDraftDiscard(tx: TenantTx, plan: DiscardPlan): Promise<boolean>;
  /**
   * US-048 (RN-TRAM-28): as responsabilidades (`ProcessAssignment`) das passagens ENCERRADAS do
   * processo pela etapa de workflow `workflowStageId` — a base de `PREVIOUS_ASSIGNEE`.
   */
  previousAssignments(
    tx: TenantTx,
    processId: string,
    workflowStageId: string,
  ): Promise<PreviousAssignment[]>;
  /**
   * RN-TRAM-17 (DEC-024): a unidade deixou de ter a custódia — revoga o `CURRENT` ativo dela e
   * concede o `HISTORICAL` (idempotente), no `tx`.
   */
  retireCurrentAccess(
    tx: TenantTx,
    processId: string,
    departmentId: string,
    at: Date,
  ): Promise<void>;
  /** RN-PROC-13: candidatos visíveis, mais recentes primeiro. */
  findDuplicateCandidates(tx: TenantTx, search: DuplicateSearch): Promise<DuplicateCandidateRow[]>;
  /** US-002 · PRC-01: página e total, visíveis e filtrados, num único snapshot. */
  listProcesses(tx: TenantTx, search: ProcessListSearch): Promise<ProcessListPage>;
  /** US-003 · RN-PROC-41: total exato das linhas da exportação, antes do primeiro byte. */
  countForExport(tx: TenantTx, search: ProcessExportSearch): Promise<number>;
  /**
   * US-003 · RN-PROC-45: cursor no servidor sobre as linhas da exportação, lido em lotes de
   * `batchSize` dentro de uma transação somente leitura (`pullInTransaction`).
   */
  exportCursor(search: ProcessExportSearch, batchSize: number): CursorReader<ProcessListRow>;
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
  /**
   * `SELECT … FOR SHARE` nos itens não excluídos do processo dentre `itemIds` (inclusão em
   * documento — DOC-07 · US-014): a exclusão concorrente (`lockItem`) espera ou já venceu.
   */
  lockForShare(tx: TenantTx, processId: string, itemIds: readonly string[]): Promise<ProcessItem[]>;
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

/** RN-PROC-129: já existe participação ativa do mesmo usuário/unidade (índice único parcial). */
export class ParticipantAlreadyActiveError extends Error {
  constructor() {
    super('Participante já ativo no processo.');
    this.name = 'ParticipantAlreadyActiveError';
  }
}

/** Nome congelado e papel de um participante (fonte `PROCESS_PARTICIPANT` da timeline). */
export interface ProcessParticipantReference {
  readonly userId: string | null;
  readonly departmentId: string | null;
  readonly role: ParticipantRole;
}

/**
 * Participantes do processo (US-012 · `process_participants`): sempre no `tx` do caso de uso. A
 * unicidade do participante ativo é do banco (índices únicos parciais — RN-PROC-129).
 */
export interface ProcessParticipantRepository {
  /** Participações não revogadas do processo (inclusive vencidas — quem lê decide). */
  listActive(tx: TenantTx, processId: string): Promise<ProcessParticipant[]>;
  /** Participação não revogada do usuário (ou da unidade) no processo. */
  findActive(
    tx: TenantTx,
    processId: string,
    principal: { readonly userId: string } | { readonly departmentId: string },
  ): Promise<ProcessParticipant | null>;
  /** `SELECT … FOR UPDATE` na participação não revogada (`null` = inexistente, revogada ou de outro tenant). */
  lockActive(tx: TenantTx, participantId: string): Promise<ProcessParticipant | null>;
  /** @throws ParticipantAlreadyActiveError */
  insert(tx: TenantTx, participant: ProcessParticipant): Promise<void>;
  /** Grava `revokedAt`, `revokedById` e `revocationReason` (só se ainda ativa). */
  revoke(tx: TenantTx, participant: ProcessParticipant): Promise<void>;
  /** Principal e papel de participações (revogadas ou não) do tenant da transação. */
  references(
    tx: TenantTx,
    participantIds: readonly string[],
  ): Promise<Map<string, ProcessParticipantReference>>;
}

export const PROCESS_PARTICIPANT_REPOSITORY = Symbol('ProcessParticipantRepository');

/**
 * Visões salvas (US-003 · `saved_views`): sempre no `tx` do caso de uso, sob a RLS do tenant. A
 * unicidade do nome e da padrão também é do banco (índices únicos); a trava por dono e escopo
 * serializa criação, limite e troca da padrão.
 */
export interface SavedViewRepository {
  /** `pg_advisory_xact_lock` por dono e escopo (até o fim da transação). */
  lockOwnerScope(tx: TenantTx, ownerId: string, scope: SavedView['scope']): Promise<void>;
  /** Do dono no escopo, por nome. */
  listOwned(tx: TenantTx, ownerId: string, scope: SavedView['scope']): Promise<SavedView[]>;
  /** Compartilhadas por outros donos no escopo, por nome. */
  listSharedByOthers(tx: TenantTx, userId: string, scope: SavedView['scope']): Promise<SavedView[]>;
  findById(tx: TenantTx, id: string): Promise<SavedView | null>;
  /** Desmarca a padrão do dono no escopo (exceto `exceptId`). */
  clearDefault(
    tx: TenantTx,
    ownerId: string,
    scope: SavedView['scope'],
    exceptId: string | null,
  ): Promise<void>;
  /** @throws SavedViewNameTakenError */
  insert(tx: TenantTx, view: SavedView): Promise<void>;
  /** `UPDATE … WHERE version = expected` (412 em divergência). @throws SavedViewNameTakenError */
  update(tx: TenantTx, view: SavedView, expectedVersion: number): Promise<void>;
  /** `DELETE … WHERE version = expected` (412 em divergência). */
  delete(tx: TenantTx, view: SavedView, expectedVersion: number): Promise<void>;
}

export const SAVED_VIEW_REPOSITORY = Symbol('SavedViewRepository');

/** Nome repetido para o mesmo dono e escopo (índice `lower(name)` — V-02). */
export class SavedViewNameTakenError extends Error {
  constructor() {
    super('Nome de visão já usado pelo dono no escopo.');
    this.name = 'SavedViewNameTakenError';
  }
}

/** Nome repetido no tenant (índice `lower(name)` — RN-PROC-85). */
export class TagNameTakenError extends Error {
  constructor() {
    super('Nome de etiqueta já usado no tenant.');
    this.name = 'TagNameTakenError';
  }
}

/**
 * Etiquetas (US-007 · `tags` e `process_tags`): sempre no `tx` do caso de uso, sob a RLS do tenant.
 * A unicidade do nome é do banco; a associação ao processo só muda sob o bloqueio do processo
 * (`ProcessRepository.lockForUpdate`).
 */
export interface TagRepository {
  /** Etiquetas do tenant por nome; `includeInactive = false` só as ativas. */
  list(tx: TenantTx, includeInactive: boolean): Promise<Tag[]>;
  findById(tx: TenantTx, id: string): Promise<Tag | null>;
  /** As etiquetas existentes no tenant dentre `ids` (outro tenant = inexistente). */
  findByIds(tx: TenantTx, ids: readonly string[]): Promise<Tag[]>;
  /** @throws TagNameTakenError */
  insert(tx: TenantTx, tag: Tag): Promise<void>;
  /** `UPDATE … WHERE version = expected` (412 em divergência). @throws TagNameTakenError */
  update(tx: TenantTx, tag: Tag, expectedVersion: number): Promise<void>;
  /** Etiquetas (ativas e inativas) aplicadas a cada processo, por nome. */
  forProcesses(tx: TenantTx, processIds: readonly string[]): Promise<Map<string, Tag[]>>;
  /** Grava só a diferença do conjunto (inserções e remoções) do processo já travado. */
  applyDiff(
    tx: TenantTx,
    processId: string,
    diff: TagSetDiff,
    at: Date,
    userId: string | null,
  ): Promise<void>;
}

export const TAG_REPOSITORY = Symbol('TagRepository');

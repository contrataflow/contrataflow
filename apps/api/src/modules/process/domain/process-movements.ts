import type { ActorType } from '@contrataflow/types';
import type {
  MovementAction,
  MovementItemDto,
  ProcessMovementsQuery,
  ProcessStatus,
} from '@contrataflow/validation';

import type { ProcessMovementRecord } from './process-runtime-records.js';

/*
 * Histórico de tramitações (US-054 · PRC-11): leitura de `ProcessMovement` (imutável — nenhuma
 * escrita aqui). Critérios dos filtros (RN-TRAM-75), ordem e cursor por `sequence` decrescente
 * (RN-TRAM-72 — estável sob tramitações concorrentes: as novas ganham `sequence` maior e nunca
 * entram depois do cursor), as referências a hidratar em lote por página (sem N+1) e o
 * `ProcessMovementPresenter` com a restrição do `ip` (RN-TRAM-74 — só na apresentação, nunca no
 * banco). As mesmas funções valem para a consulta em memória; o SQL de
 * `PrismaProcessRepository.listMovements` as espelha.
 */

/**
 * Tramitação como lida de `process_movements` (entities.md §4.4): as colunas de destino e o status
 * são anuláveis no banco e o ator pode ser qualquer `ActorType`. Toda `ProcessMovementRecord`
 * gravada pelas stories de escrita é uma `StoredMovement`.
 */
export type StoredMovement = Omit<
  ProcessMovementRecord,
  'toProcessStageId' | 'toWorkflowStageId' | 'toDepartmentId' | 'statusTo' | 'actorType'
> & {
  readonly toProcessStageId: string | null;
  readonly toWorkflowStageId: string | null;
  readonly toDepartmentId: string | null;
  readonly statusTo: ProcessStatus | null;
  readonly actorType: ActorType;
};

export interface MovementFeedSearch {
  readonly processId: string;
  /** Ações pedidas (OU); `null` = todas. */
  readonly actions: readonly MovementAction[] | null;
  readonly fromDepartmentId: string | null;
  readonly toDepartmentId: string | null;
  readonly actorId: string | null;
  /** Período inclusivo sobre `occurredAt`. */
  readonly occurredFrom: Date | null;
  readonly occurredTo: Date | null;
  /** `sequence` da última tramitação devolvida (estritamente menores a seguir); `null` = início. */
  readonly beforeSequence: number | null;
  /** `limit + 1` (o excedente indica `hasMore`). */
  readonly take: number;
}

/** Filtros da query (já validados pelo schema de PRC-11) → critérios da consulta. */
export function movementCriteriaOf(
  query: ProcessMovementsQuery,
): Omit<MovementFeedSearch, 'processId' | 'beforeSequence' | 'take'> {
  return {
    actions: query.action === undefined ? null : [...query.action],
    fromDepartmentId: query.fromDepartmentId ?? null,
    toDepartmentId: query.toDepartmentId ?? null,
    actorId: query.actorId ?? null,
    occurredFrom: query.occurredFrom === undefined ? null : new Date(query.occurredFrom),
    occurredTo: query.occurredTo === undefined ? null : new Date(query.occurredTo),
  };
}

/** Chaves dos filtros usados (sem valores) — log `process.movements_listed`. */
export function movementFilterKeys(query: ProcessMovementsQuery): string[] {
  return (
    [
      'action',
      'fromDepartmentId',
      'toDepartmentId',
      'actorId',
      'occurredFrom',
      'occurredTo',
    ] as const
  ).filter((key) => query[key] !== undefined);
}

/** Todos os critérios em memória (mesmo predicado do SQL). */
export function matchesMovementSearch(
  movement: StoredMovement,
  search: MovementFeedSearch,
): boolean {
  if (movement.processId !== search.processId) return false;
  if (search.actions !== null && !search.actions.includes(movement.action)) return false;
  if (search.fromDepartmentId !== null && movement.fromDepartmentId !== search.fromDepartmentId) {
    return false;
  }
  if (search.toDepartmentId !== null && movement.toDepartmentId !== search.toDepartmentId) {
    return false;
  }
  if (search.actorId !== null && movement.actorId !== search.actorId) return false;
  const time = movement.occurredAt.getTime();
  if (search.occurredFrom !== null && time < search.occurredFrom.getTime()) return false;
  if (search.occurredTo !== null && time > search.occurredTo.getTime()) return false;
  return search.beforeSequence === null || movement.sequence < search.beforeSequence;
}

/** Ordem do histórico: `sequence` decrescente (mais recente primeiro — RN-TRAM-72). */
export function compareMovements(
  left: Pick<StoredMovement, 'sequence'>,
  right: Pick<StoredMovement, 'sequence'>,
): number {
  return right.sequence - left.sequence;
}

/** Ids referenciados pela página, sem repetição — uma leitura por tipo (sem N+1). */
export interface MovementReferences {
  readonly processStageIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly userIds: readonly string[];
  readonly approvalIds: readonly string[];
}

const distinct = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((value): value is string => value !== null)),
];

export function movementReferencesOf(movements: readonly StoredMovement[]): MovementReferences {
  return {
    processStageIds: distinct(
      movements.flatMap((movement) => [movement.fromProcessStageId, movement.toProcessStageId]),
    ),
    departmentIds: distinct(
      movements.flatMap((movement) => [
        movement.fromDepartmentId,
        movement.toDepartmentId,
        movement.actorDepartmentId,
      ]),
    ),
    userIds: distinct(
      movements.flatMap((movement) => [movement.fromUserId, movement.toUserId, movement.actorId]),
    ),
    approvalIds: distinct(movements.map((movement) => movement.approvalId)),
  };
}

/** Unidade ou usuário hidratado (FA-05: o nome histórico continua disponível, com `isActive`). */
export interface PartyName {
  readonly name: string;
  readonly isActive: boolean;
}

/** Nomes hidratados da página (id → nome); ausência = não pôde ser hidratado (nome `null`). */
export interface MovementNames {
  /** Por `WorkflowStage.id`. */
  readonly stages: ReadonlyMap<string, string>;
  readonly departments: ReadonlyMap<string, PartyName>;
  readonly users: ReadonlyMap<string, PartyName>;
  readonly approvals: ReadonlyMap<string, NonNullable<MovementItemDto['approvalSummary']>>;
}

/**
 * Ids referenciados que não puderam ser hidratados (unidade/usuário/etapa sem nome): a API devolve
 * o id com nome `null` em vez de falhar a lista (`warn process.movements_hydration_partial`).
 */
export function unresolvedReferences(
  movements: readonly StoredMovement[],
  names: MovementNames,
): { readonly stages: number; readonly departments: number; readonly users: number } {
  const stageIds = distinct(
    movements.flatMap((movement) => [movement.fromWorkflowStageId, movement.toWorkflowStageId]),
  );
  const references = movementReferencesOf(movements);
  return {
    stages: stageIds.filter((id) => !names.stages.has(id)).length,
    departments: references.departmentIds.filter((id) => !names.departments.has(id)).length,
    users: references.userIds.filter((id) => !names.users.has(id)).length,
  };
}

function stageRef(id: string | null, names: MovementNames): MovementItemDto['fromStage'] {
  return id === null ? null : { id, name: names.stages.get(id) ?? null };
}

function partyRef(
  id: string | null,
  known: ReadonlyMap<string, PartyName>,
): MovementItemDto['fromDepartment'] {
  if (id === null) return null;
  const party = known.get(id);
  // Não hidratado: sem nome e sem afirmar que está inativo.
  return { id, name: party?.name ?? null, isActive: party?.isActive ?? true };
}

/**
 * `ProcessMovementPresenter` (RN-TRAM-73/74): o registro com os nomes hidratados na consulta (o
 * registro em si não guarda nomes) e o `ip` só para quem tem `AUDIT_VIEW` — para os demais, `null`.
 * `userAgent` e `correlationId` seguem a visibilidade do processo.
 */
export function toMovementItem(
  movement: StoredMovement,
  names: MovementNames,
  canViewIp: boolean,
): MovementItemDto {
  const actorDepartment =
    movement.actorDepartmentId === null
      ? undefined
      : names.departments.get(movement.actorDepartmentId);
  return {
    id: movement.id,
    sequence: movement.sequence,
    action: movement.action,
    fromStage: stageRef(movement.fromWorkflowStageId, names),
    toStage: stageRef(movement.toWorkflowStageId, names),
    fromDepartment: partyRef(movement.fromDepartmentId, names.departments),
    toDepartment: partyRef(movement.toDepartmentId, names.departments),
    fromUser: partyRef(movement.fromUserId, names.users),
    toUser: partyRef(movement.toUserId, names.users),
    statusFrom: movement.statusFrom,
    statusTo: movement.statusTo,
    actor: {
      type: movement.actorType,
      id: movement.actorId,
      name: movement.actorId === null ? null : (names.users.get(movement.actorId)?.name ?? null),
      departmentName: actorDepartment?.name ?? null,
    },
    comment: movement.comment,
    dueAt: movement.dueAt?.toISOString() ?? null,
    documents: movement.documents.map((document) => ({ ...document })),
    approvalId: movement.approvalId,
    approvalSummary:
      movement.approvalId === null ? null : (names.approvals.get(movement.approvalId) ?? null),
    occurredAt: movement.occurredAt.toISOString(),
    ip: canViewIp ? movement.ip : null,
    userAgent: movement.userAgent,
    correlationId: movement.correlationId,
  };
}

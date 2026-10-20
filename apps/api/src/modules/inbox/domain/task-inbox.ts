import type {
  ApprovalSubjectType,
  DayCountType,
  ProcessStatus,
  TaskInboxSort,
  TaskInboxView,
} from '@contrataflow/validation';

import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';

/*
 * Caixa de tarefas (US-056 · DEC-026): não é entidade — cada visão é um predicado sobre as views
 * publicadas pelos donos (`v_inbox_processes`, `v_inbox_participations` do `process`;
 * `v_inbox_pending_approvals` do `approval`). Estas funções puras são a regra (RN-INBOX-03..08 e
 * RN-INBOX-11) e a referência do SQL de `infrastructure/task-inbox.sql.ts`, que as repete
 * predicado a predicado; o leitor em memória as usa diretamente.
 */

/** `ApproverType` de `approvals` (DEC-022). */
export type InboxApproverType = 'USER' | 'ROLE' | 'DEPARTMENT_HEAD';
/** `AssignmentType` de `process_assignments` (só `RETURN` importa aqui — RN-INBOX-05). */
export type InboxAssignmentType = string;

/** Linha de `v_inbox_processes`: o processo, a passagem ativa e a responsabilidade ativa. */
export interface InboxProcessRow {
  readonly tenantId: string;
  readonly id: string;
  readonly organizationId: string;
  readonly code: string | null;
  readonly number: number | null;
  readonly year: number;
  readonly title: string;
  readonly status: ProcessStatus;
  readonly version: number;
  readonly isBudgetConfidential: boolean;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly currentDepartmentId: string;
  readonly currentResponsibleId: string | null;
  readonly currentWorkflowStageId: string | null;
  /** Passagem ativa (`process_stages` `ACTIVE`); `null` = sem etapa ativa. */
  readonly stageId: string | null;
  readonly enteredAt: Date | null;
  readonly dueAt: Date | null;
  readonly overdueSince: Date | null;
  readonly slaType: DayCountType | null;
  readonly pausedAt: Date | null;
  /** Responsabilidade ativa (`process_assignments` `is_active`); `null` = sem custódia. */
  readonly assignmentDepartmentId: string | null;
  readonly assigneeId: string | null;
  readonly assignmentType: InboxAssignmentType | null;
}

/** Linha de `v_inbox_pending_approvals`. */
export interface InboxApprovalRow {
  readonly tenantId: string;
  readonly id: string;
  readonly processId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly title: string;
  readonly requestedById: string;
  readonly requestedAt: Date;
  readonly dueAt: Date | null;
  readonly approverType: InboxApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
}

/** Linha de `v_inbox_participations` (participação individual não revogada). */
export interface InboxParticipationRow {
  readonly tenantId: string;
  readonly processId: string;
  readonly userId: string;
  readonly expiresAt: Date | null;
}

/** Cobertura de uma atribuição de perfil do usuário (POL-03 por perfil — `AccessFacade`). */
export interface InboxRoleCompetence {
  readonly roleId: string;
  readonly tenantWide: boolean;
  readonly organizationId: string | null;
  readonly departmentIds: readonly string[];
}

/** Escopos expandidos de `PROCESS_CLAIM` (POL-04). */
export interface InboxClaimScope {
  readonly tenantWide: boolean;
  readonly organizationIds: readonly string[];
  readonly departmentIds: readonly string[];
}

/** Quem consulta a caixa, com tudo que os predicados precisam (resolvido uma vez por requisição). */
export interface InboxViewer {
  readonly userId: string;
  /** Lotações (custódia e POL-04). */
  readonly ownDepartmentIds: readonly string[];
  /**
   * RN-INBOX-04: as lotações (quando tem `PROCESS_CLAIM`) e as unidades de que é titular ou
   * substituto. Vazio = a visão "Na fila da minha unidade" não se aplica (FA-01).
   */
  readonly queueDepartmentIds: readonly string[];
  /** `PROCESS_CLAIM` (escopos expandidos) ou `null` sem a permissão. */
  readonly claim: InboxClaimScope | null;
  /** POL-03: titular, substituto e perfis com cobertura. */
  readonly approver: {
    readonly headOf: readonly string[];
    readonly deputyOf: readonly string[];
    readonly roles: readonly InboxRoleCompetence[];
  };
  /** DEC-024: escopos de `PROCESS_VIEW` (o item só aparece se o processo é visível). */
  readonly visibility: ProcessVisibilityScope;
  readonly historicalDepartmentsCanView: boolean;
}

export interface InboxViewerFacts {
  readonly userId: string;
  readonly ownDepartmentIds: readonly string[];
  /** Titular OU substituto de unidade ativa (capacidade implícita — permissions.md §7). */
  readonly headOfDepartmentIds: readonly string[];
  readonly claim: InboxClaimScope | null;
  readonly leadership: { readonly headOf: readonly string[]; readonly deputyOf: readonly string[] };
  readonly roles: readonly InboxRoleCompetence[];
  readonly visibility: ProcessVisibilityScope;
  readonly historicalDepartmentsCanView: boolean;
}

const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort();

export function inboxViewerOf(facts: InboxViewerFacts): InboxViewer {
  return {
    userId: facts.userId,
    ownDepartmentIds: sortedUnique(facts.ownDepartmentIds),
    queueDepartmentIds: sortedUnique([
      ...(facts.claim === null ? [] : facts.ownDepartmentIds),
      ...facts.headOfDepartmentIds,
    ]),
    claim: facts.claim,
    approver: {
      headOf: sortedUnique(facts.leadership.headOf),
      deputyOf: sortedUnique(facts.leadership.deputyOf),
      roles: facts.roles,
    },
    visibility: facts.visibility,
    historicalDepartmentsCanView: facts.historicalDepartmentsCanView,
  };
}

/**
 * Recorte opcional dos contadores pela unidade solicitante do processo (US-076 · RN-DASH-09: os
 * filtros do dashboard, sempre DENTRO da visibilidade). `null` = sem recorte naquele campo.
 */
export interface InboxProcessRestriction {
  readonly secretariatId: string | null;
  /** O setor filtrado e a sua subárvore (já resolvidos). */
  readonly departmentIds: readonly string[] | null;
}

export function matchesRestriction(
  row: Pick<InboxProcessRow, 'requestingSecretariatId' | 'requestingDepartmentId'>,
  restriction: InboxProcessRestriction | null,
): boolean {
  if (restriction === null) return true;
  if (
    restriction.secretariatId !== null &&
    row.requestingSecretariatId !== restriction.secretariatId
  ) {
    return false;
  }
  return (
    restriction.departmentIds === null ||
    restriction.departmentIds.includes(row.requestingDepartmentId)
  );
}

/** FA-01 · RN-INBOX-04: a aba "Na fila da minha unidade" existe para o usuário. */
export function unitQueueApplies(viewer: InboxViewer): boolean {
  return viewer.queueDepartmentIds.length > 0;
}

/** RN-INBOX-03: responsabilidade ativa do próprio usuário. */
export function isMine(row: InboxProcessRow, viewer: InboxViewer): boolean {
  return row.assigneeId !== null && row.assigneeId === viewer.userId;
}

/** RN-INBOX-04: responsabilidade ativa sem responsável numa unidade da fila do usuário. */
export function isInUnitQueue(row: InboxProcessRow, viewer: InboxViewer): boolean {
  return (
    row.assigneeId === null &&
    row.assignmentDepartmentId !== null &&
    viewer.queueDepartmentIds.includes(row.assignmentDepartmentId)
  );
}

/** RN-INBOX-05: devolução ativa comigo ou na fila de uma unidade minha. */
export function isReturned(row: InboxProcessRow, viewer: InboxViewer): boolean {
  return row.assignmentType === 'RETURN' && (isMine(row, viewer) || isInUnitQueue(row, viewer));
}

/** RN-INBOX-06: etapa ativa com `overdueSince`, entre os processos de "Comigo" e da fila. */
export function isOverdueTask(row: InboxProcessRow, viewer: InboxViewer): boolean {
  return (
    row.stageId !== null &&
    row.overdueSince !== null &&
    (isMine(row, viewer) || isInUnitQueue(row, viewer))
  );
}

/** RN-INBOX-08: participação individual ativa (não revogada nem vencida), qualquer `role`. */
export function isFollowing(
  row: InboxProcessRow,
  participations: readonly InboxParticipationRow[],
  viewer: InboxViewer,
  now: Date,
): boolean {
  return participations.some(
    (participation) =>
      participation.processId === row.id &&
      participation.userId === viewer.userId &&
      (participation.expiresAt === null || participation.expiresAt.getTime() > now.getTime()),
  );
}

/**
 * RN-INBOX-07 (POL-03 · DEC-022): `USER` — o próprio; `DEPARTMENT_HEAD` — titular da unidade
 * aprovadora ou, com `allowDeputy`, o substituto; `ROLE` — perfil cuja atribuição cobre o órgão ou
 * a secretaria/setor solicitante do processo.
 */
export function isDesignatedApprover(
  approval: InboxApprovalRow,
  process: Pick<
    InboxProcessRow,
    'organizationId' | 'requestingSecretariatId' | 'requestingDepartmentId'
  >,
  viewer: InboxViewer,
): boolean {
  switch (approval.approverType) {
    case 'USER':
      return approval.approverUserId === viewer.userId;
    case 'DEPARTMENT_HEAD':
      return (
        approval.approverDepartmentId !== null &&
        (viewer.approver.headOf.includes(approval.approverDepartmentId) ||
          (approval.allowDeputy &&
            viewer.approver.deputyOf.includes(approval.approverDepartmentId)))
      );
    case 'ROLE':
      return viewer.approver.roles.some(
        (role) =>
          role.roleId === approval.approverRoleId &&
          (role.tenantWide ||
            role.organizationId === process.organizationId ||
            role.departmentIds.includes(process.requestingSecretariatId) ||
            role.departmentIds.includes(process.requestingDepartmentId)),
      );
  }
}

/** RN-TRAM-32: status em que se assume (o mesmo do PRC-21). */
export const CLAIMABLE_STATUSES: readonly ProcessStatus[] = ['IN_PROGRESS', 'RETURNED'];

/**
 * RN-INBOX-11: a ação rápida "Assumir" aparece para a linha sem responsável quando o usuário tem
 * `PROCESS_CLAIM` cobrindo o processo e está lotado na unidade atual (POL-04), em status
 * elegível. A decisão final é sempre do PRC-21 (US-049), que repete as checagens.
 */
export function canClaim(row: InboxProcessRow, viewer: InboxViewer): boolean {
  const claim = viewer.claim;
  if (claim === null || row.assigneeId !== null || row.assignmentDepartmentId === null) {
    return false;
  }
  if (!viewer.ownDepartmentIds.includes(row.currentDepartmentId)) return false;
  if (!CLAIMABLE_STATUSES.includes(row.status)) return false;
  return (
    claim.tenantWide ||
    claim.organizationIds.includes(row.organizationId) ||
    [row.currentDepartmentId, row.requestingSecretariatId, row.requestingDepartmentId].some((id) =>
      claim.departmentIds.includes(id),
    )
  );
}

/** Item de uma visão: o processo e, em `PENDING_APPROVALS`, a aprovação da linha. */
export interface InboxItemRow {
  /** Chave da linha (processo; aprovação em `PENDING_APPROVALS`). */
  readonly key: string;
  readonly process: InboxProcessRow;
  readonly approval: InboxApprovalRow | null;
}

/** RN-INBOX-10: o prazo da linha — o da aprovação, quando houver, senão o da etapa ativa. */
export function dueAtOf(item: InboxItemRow): Date | null {
  return item.approval?.dueAt ?? item.process.dueAt;
}

/** Itens da visão (fontes já restritas ao tenant e à visibilidade), um por chave. */
export function itemsOfView(
  view: TaskInboxView,
  sources: {
    readonly processes: readonly InboxProcessRow[];
    readonly approvals: readonly InboxApprovalRow[];
    readonly participations: readonly InboxParticipationRow[];
  },
  viewer: InboxViewer,
  now: Date,
): InboxItemRow[] {
  const item = (process: InboxProcessRow): InboxItemRow => ({
    key: process.id,
    process,
    approval: null,
  });
  switch (view) {
    case 'MINE':
      return sources.processes.filter((row) => isMine(row, viewer)).map(item);
    case 'UNIT_QUEUE':
      return sources.processes.filter((row) => isInUnitQueue(row, viewer)).map(item);
    case 'RETURNED':
      return sources.processes.filter((row) => isReturned(row, viewer)).map(item);
    case 'OVERDUE':
      return sources.processes.filter((row) => isOverdueTask(row, viewer)).map(item);
    case 'FOLLOWING':
      return sources.processes
        .filter((row) => isFollowing(row, sources.participations, viewer, now))
        .map(item);
    case 'PENDING_APPROVALS': {
      const byId = new Map(sources.processes.map((row) => [row.id, row]));
      return sources.approvals.flatMap((approval) => {
        const process = byId.get(approval.processId);
        return process && isDesignatedApprover(approval, process, viewer)
          ? [{ key: approval.id, process, approval }]
          : [];
      });
    }
  }
}

/** Valor ordenável de cada campo (nulo sempre ao final — RN-INBOX-10). */
function sortValues(item: InboxItemRow, field: TaskInboxSort['field']): (number | null)[] {
  switch (field) {
    case 'dueAt':
      return [dueAtOf(item)?.getTime() ?? null];
    case 'enteredAt':
      return [item.process.enteredAt?.getTime() ?? null];
    case 'requestedAt':
      return [item.approval?.requestedAt.getTime() ?? null];
    case 'code':
      // Ano e número; sem número ao final (mesma regra da lista de processos).
      return item.process.number === null ? [null, null] : [item.process.year, item.process.number];
  }
}

/** Comparador da ordenação: nulos por último em qualquer direção; desempate pela chave (desc). */
export function compareItems(sort: TaskInboxSort): (a: InboxItemRow, b: InboxItemRow) => number {
  const factor = sort.direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const left = sortValues(a, sort.field);
    const right = sortValues(b, sort.field);
    for (let index = 0; index < left.length; index += 1) {
      const x = left[index] ?? null;
      const y = right[index] ?? null;
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x - y) * factor;
    }
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  };
}

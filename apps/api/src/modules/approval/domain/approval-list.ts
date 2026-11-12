import { localDateOf } from '@contrataflow/types';
import type {
  ApprovalApproverStatus,
  ApprovalDecisionPolicy,
  ApprovalSkippedReason,
  ApprovalListSort,
  ApprovalMyLineStatus,
  ApprovalStatus,
  ApprovalSubjectType,
  ApproverType,
} from '@contrataflow/validation';

/*
 * Lista de aprovações (US-057 · APV-01): a cobertura de aprovador (POL-03 · DEC-022 ·
 * RN-INBOX-14) como PREDICADO da consulta — nunca checagem posterior —, os filtros (RN-INBOX-15),
 * o atraso (RN-INBOX-16) e a ordenação (RN-INBOX-18). Funções puras: a regra e a referência do SQL
 * de `infrastructure/approval-list.sql.ts`, que as repete predicado a predicado; o leitor em memória
 * as usa diretamente.
 */

/** Cobertura de uma atribuição de perfil do usuário (`AccessFacade.approverCompetenceIn`). */
export interface ApproverRoleCoverage {
  readonly roleId: string;
  readonly tenantWide: boolean;
  readonly organizationId: string | null;
  readonly departmentIds: readonly string[];
}

/** Quem consulta, com o que a cobertura precisa (resolvido uma vez por requisição). */
export interface ApproverCoverage {
  readonly userId: string;
  /** Unidades ativas de que é titular / substituto (`OrganizationFacade.departmentLeadership`). */
  readonly headOf: readonly string[];
  readonly deputyOf: readonly string[];
  readonly roles: readonly ApproverRoleCoverage[];
}

/** O processo da aprovação (`v_inbox_processes`, publicada pelo `process`). */
export interface ApprovalListProcess {
  readonly code: string | null;
  readonly number: number | null;
  readonly year: number;
  readonly title: string;
  readonly organizationId: string;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly isBudgetConfidential: boolean;
}

/** Linha `ApprovalApprover` da aprovação (US-136): a cobertura e o andamento por linha. */
export interface ApprovalListLine {
  readonly id: string;
  readonly sequence: number;
  readonly status: ApprovalApproverStatus;
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
  readonly decidedById: string | null;
  readonly skippedReason: ApprovalSkippedReason | null;
}

/**
 * A linha substituída por redirecionamento (`CANCELED` + `REASSIGNED`) não é mais de ninguém: sai
 * da cobertura (como a troca no lugar do MVP 1). As demais `CANCELED` (aprovação retirada ou
 * cancelada) continuam cobrindo quem estava nelas — a lista do MVP 1 mostrava as canceladas.
 */
export function isSupersededLine(
  line: Pick<ApprovalListLine, 'status' | 'skippedReason'>,
): boolean {
  return line.status === 'CANCELED' && line.skippedReason === 'REASSIGNED';
}

/** `myLine` (RN-APV-67): a linha de quem consulta. */
export interface ApprovalListMyLine {
  readonly id: string;
  readonly sequence: number;
  readonly status: ApprovalApproverStatus;
}

/** Linha de `approvals` com o processo. */
export interface ApprovalListRow {
  readonly tenantId: string;
  readonly id: string;
  readonly processId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly title: string;
  readonly documentId: string | null;
  /** US-125: etapa da aprovação de etapa (o ramo dela vem do `process`); ausente = desconhecida. */
  readonly processStageId?: string | null;
  readonly status: ApprovalStatus;
  readonly requestedById: string;
  readonly requestedAt: Date;
  readonly dueAt: Date | null;
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
  readonly decidedById: string | null;
  readonly process: ApprovalListProcess;
  /** US-136: a política copiada na solicitação (`ANY` nas do MVP 1). */
  readonly decisionPolicy: ApprovalDecisionPolicy;
  /** US-136: todas as linhas, em ordem de `sequence` e criação (inclusive as `CANCELED`). */
  readonly lines: readonly ApprovalListLine[];
}

/**
 * POL-03: aprovador designado — `USER` direto; `DEPARTMENT_HEAD` pelo titular ATUAL da unidade
 * aprovadora ou, com `allowDeputy`, pelo substituto; `ROLE` pelo perfil cuja atribuição cobre o
 * órgão ou a secretaria/setor solicitante do processo. O mesmo de `designationOf` (US-052), sobre os
 * fatos de quem consulta em vez dos detentores do perfil.
 */
export function isDesignatedApprover(
  line: Pick<
    ApprovalListLine,
    'approverType' | 'approverUserId' | 'approverRoleId' | 'approverDepartmentId' | 'allowDeputy'
  >,
  process: Pick<
    ApprovalListProcess,
    'organizationId' | 'requestingSecretariatId' | 'requestingDepartmentId'
  >,
  coverage: ApproverCoverage,
): boolean {
  switch (line.approverType) {
    case 'USER':
      return line.approverUserId !== null && line.approverUserId === coverage.userId;
    case 'DEPARTMENT_HEAD':
      return (
        line.approverDepartmentId !== null &&
        (coverage.headOf.includes(line.approverDepartmentId) ||
          (line.allowDeputy && coverage.deputyOf.includes(line.approverDepartmentId)))
      );
    case 'ROLE':
      return coverage.roles.some(
        (role) =>
          role.roleId === line.approverRoleId &&
          (role.tenantWide ||
            role.organizationId === process.organizationId ||
            role.departmentIds.includes(process.requestingSecretariatId) ||
            role.departmentIds.includes(process.requestingDepartmentId)),
      );
  }
}

/** Prioridade da linha de quem consulta: a vez, a espera, as demais. */
const MY_LINE_RANK: Readonly<Record<ApprovalApproverStatus, number>> = {
  PENDING: 0,
  WAITING: 1,
  APPROVED: 2,
  RETURNED: 2,
  REJECTED: 2,
  SKIPPED: 2,
  CANCELED: 3,
};

/**
 * US-136 (RN-APV-66 · FA-04): a linha de quem consulta — entre as não substituídas
 * (`isSupersededLine`) em que está designado ou que decidiu, a `PENDING` de menor `sequence`, senão a `WAITING`, senão a que
 * decidiu, senão a primeira. O mesmo `ORDER BY` do SQL (`myLineSql`).
 */
export function myLineOf(
  row: Pick<ApprovalListRow, 'lines' | 'process'>,
  coverage: ApproverCoverage,
): ApprovalListMyLine | null {
  const candidates = row.lines.filter(
    (line) =>
      !isSupersededLine(line) &&
      (line.decidedById === coverage.userId || isDesignatedApprover(line, row.process, coverage)),
  );
  const ranked = [...candidates].sort(
    (a, b) =>
      MY_LINE_RANK[a.status] - MY_LINE_RANK[b.status] ||
      Number(b.decidedById === coverage.userId) - Number(a.decidedById === coverage.userId) ||
      a.sequence - b.sequence,
  );
  const mine = ranked[0];
  return mine === undefined ? null : { id: mine.id, sequence: mine.sequence, status: mine.status };
}

/**
 * RN-INBOX-14 · US-136 (RN-APV-66): na lista entram as aprovações em que o usuário tem linha não
 * substituída (designado nela agora — em qualquer estado, como no MVP 1, inclusive `WAITING`) ou que
 * decidiu (a linha ou, no MVP 1, a aprovação — o histórico não some quando a titularidade muda).
 */
export function isInApprovalList(row: ApprovalListRow, coverage: ApproverCoverage): boolean {
  return row.decidedById === coverage.userId || myLineOf(row, coverage) !== null;
}

/** Filtros de APV-01 já resolvidos (RN-INBOX-15); período em datas locais do tenant. */
export interface ApprovalListCriteria {
  readonly statuses: readonly ApprovalStatus[];
  readonly subjectType: ApprovalSubjectType | null;
  /** Secretaria OU setor solicitante. */
  readonly requestingDepartmentId: string | null;
  readonly requestedFrom: string | null;
  readonly requestedTo: string | null;
  readonly q: string | null;
  /** US-136 (RN-APV-67): políticas (OU); `null` = todas. */
  readonly decisionPolicies: readonly ApprovalDecisionPolicy[] | null;
  /** US-136 (RN-APV-67): a situação da linha de quem consulta; `null` = qualquer. */
  readonly myLineStatus: ApprovalMyLineStatus | null;
  /** Fuso IANA do tenant (o dia local de `requestedAt`). */
  readonly timezone: string;
}

/** Minúsculas e sem acento (o `lower(cf_unaccent(...))` do SQL). */
export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function matchesCriteria(
  row: ApprovalListRow,
  criteria: ApprovalListCriteria,
  myLine: ApprovalListMyLine | null = null,
): boolean {
  if (!criteria.statuses.includes(row.status)) return false;
  if (
    criteria.decisionPolicies !== null &&
    !criteria.decisionPolicies.includes(row.decisionPolicy)
  ) {
    return false;
  }
  if (criteria.myLineStatus !== null && myLine?.status !== criteria.myLineStatus) return false;
  if (criteria.subjectType !== null && row.subjectType !== criteria.subjectType) return false;
  if (
    criteria.requestingDepartmentId !== null &&
    row.process.requestingSecretariatId !== criteria.requestingDepartmentId &&
    row.process.requestingDepartmentId !== criteria.requestingDepartmentId
  ) {
    return false;
  }
  const requested = localDateOf(row.requestedAt, criteria.timezone);
  if (criteria.requestedFrom !== null && requested < criteria.requestedFrom) return false;
  if (criteria.requestedTo !== null && requested > criteria.requestedTo) return false;
  if (criteria.q !== null) {
    const needle = normalizeSearch(criteria.q);
    const haystack = [row.process.code ?? '', row.process.title, row.title];
    if (!haystack.some((value) => normalizeSearch(value).includes(needle))) return false;
  }
  return true;
}

/** RN-INBOX-16: `dueAt` vencido, só enquanto pendente (independe de `overdueSince` — DEC-031). */
export function isApprovalOverdue(
  row: Pick<ApprovalListRow, 'status' | 'dueAt'>,
  now: Date,
): boolean {
  return row.status === 'PENDING' && row.dueAt !== null && row.dueAt.getTime() < now.getTime();
}

function sortValues(row: ApprovalListRow, field: ApprovalListSort['field']): (number | null)[] {
  switch (field) {
    case 'requestedAt':
      return [row.requestedAt.getTime()];
    case 'dueAt':
      return [row.dueAt?.getTime() ?? null];
    case 'code':
      // Ano e número; sem número ao final (mesma regra da lista de processos).
      return row.process.number === null ? [null, null] : [row.process.year, row.process.number];
  }
}

/** Nulos por último em qualquer direção; desempate pelo id (desc) — paginação determinística. */
export function compareApprovalRows(
  sort: ApprovalListSort,
): (a: ApprovalListRow, b: ApprovalListRow) => number {
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
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };
}

/**
 * US-136 (RN-APV-67/70 · `currentApprover`, `waitingFor`): em `SEQUENTIAL` pendente, a linha
 * corrente — a `PENDING` de menor `sequence`; senão `null`.
 */
export function currentLineOf<
  L extends { readonly sequence: number; readonly status: ApprovalApproverStatus },
>(policy: ApprovalDecisionPolicy, approvalStatus: ApprovalStatus, lines: readonly L[]): L | null {
  if (policy !== 'SEQUENTIAL' || approvalStatus !== 'PENDING') return null;
  return (
    [...lines]
      .filter((line) => line.status === 'PENDING')
      .sort((a, b) => a.sequence - b.sequence)[0] ?? null
  );
}

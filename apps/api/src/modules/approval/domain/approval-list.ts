import { localDateOf } from '@contrataflow/types';
import type {
  ApprovalListSort,
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

/** Linha de `approvals` com o processo. */
export interface ApprovalListRow {
  readonly tenantId: string;
  readonly id: string;
  readonly processId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly title: string;
  readonly documentId: string | null;
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
}

/**
 * POL-03: aprovador designado — `USER` direto; `DEPARTMENT_HEAD` pelo titular ATUAL da unidade
 * aprovadora ou, com `allowDeputy`, pelo substituto; `ROLE` pelo perfil cuja atribuição cobre o
 * órgão ou a secretaria/setor solicitante do processo. O mesmo de `designationOf` (US-052), sobre os
 * fatos de quem consulta em vez dos detentores do perfil.
 */
export function isDesignatedApprover(row: ApprovalListRow, coverage: ApproverCoverage): boolean {
  switch (row.approverType) {
    case 'USER':
      return row.approverUserId !== null && row.approverUserId === coverage.userId;
    case 'DEPARTMENT_HEAD':
      return (
        row.approverDepartmentId !== null &&
        (coverage.headOf.includes(row.approverDepartmentId) ||
          (row.allowDeputy && coverage.deputyOf.includes(row.approverDepartmentId)))
      );
    case 'ROLE':
      return coverage.roles.some(
        (role) =>
          role.roleId === row.approverRoleId &&
          (role.tenantWide ||
            role.organizationId === row.process.organizationId ||
            role.departmentIds.includes(row.process.requestingSecretariatId) ||
            role.departmentIds.includes(row.process.requestingDepartmentId)),
      );
  }
}

/**
 * RN-INBOX-14: na lista entram as aprovações em que o usuário PRECISA atuar (designado agora) ou
 * PRECISOU atuar (decidiu — o histórico não some quando a titularidade muda depois).
 */
export function isInApprovalList(row: ApprovalListRow, coverage: ApproverCoverage): boolean {
  return row.decidedById === coverage.userId || isDesignatedApprover(row, coverage);
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

export function matchesCriteria(row: ApprovalListRow, criteria: ApprovalListCriteria): boolean {
  if (!criteria.statuses.includes(row.status)) return false;
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

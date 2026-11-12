import type { ApprovalListSort } from '@contrataflow/validation';

import { Prisma } from '#shared/database/prisma.js';

import type { ApprovalListSearch } from '../application/ports.js';
import type { ApprovalListCriteria, ApproverCoverage } from '../domain/approval-list.js';

/*
 * `ApprovalListQueryBuilder` (US-057 · APV-01): UMA consulta sobre `approvals` (do módulo) com o
 * processo publicado em `v_inbox_processes` (do `process`, já sem os excluídos), com a cobertura
 * POL-03 como predicado — o mesmo de `domain/approval-list.ts`, linha a linha — e os filtros de
 * RN-INBOX-15. Página e total de uma instrução; ordenação de lista fechada; todo valor do usuário é
 * parâmetro (`Prisma.sql`). Cada aprovação é uma linha (sem junção multiplicadora): coberta por
 * perfil E por titularidade, aparece uma vez. US-136: a cobertura é por linha (`ApprovalApprover`,
 * LATERAL `ml` com `LIMIT 1`), com os filtros `decisionPolicy` e `myLineStatus`.
 */

const SQL_FALSE = Prisma.sql`FALSE`;

const uuidAny = (column: Prisma.Sql, ids: readonly string[]) =>
  ids.length === 0 ? SQL_FALSE : Prisma.sql`${column} = ANY(${[...ids]}::uuid[])`;

/**
 * POL-03 (`isDesignatedApprover`): direto, titular/substituto com `allowDeputy`, perfil — sobre a
 * linha de alias `alias` (US-136: a `ApprovalApprover`, `l`).
 */
export function designatedSql(coverage: ApproverCoverage, alias = 'l'): Prisma.Sql {
  const col = (name: string) => Prisma.raw(`${alias}.${name}`);
  const byRole = coverage.roles.map((role) => {
    const scope: Prisma.Sql[] = [];
    if (role.tenantWide) scope.push(Prisma.sql`TRUE`);
    if (role.organizationId !== null) {
      scope.push(Prisma.sql`pr.organization_id = ${role.organizationId}::uuid`);
    }
    if (role.departmentIds.length > 0) {
      scope.push(
        uuidAny(Prisma.sql`pr.requesting_secretariat_id`, role.departmentIds),
        uuidAny(Prisma.sql`pr.requesting_department_id`, role.departmentIds),
      );
    }
    return scope.length === 0
      ? SQL_FALSE
      : Prisma.sql`(${col('approver_role_id')} = ${role.roleId}::uuid AND (${Prisma.join(scope, ' OR ')}))`;
  });
  return Prisma.sql`(
        (${col('approver_type')}::text = 'USER' AND ${col('approver_user_id')} = ${coverage.userId}::uuid)
     OR (${col('approver_type')}::text = 'DEPARTMENT_HEAD'
         AND (${uuidAny(col('approver_department_id'), coverage.headOf)}
              OR (${col('allow_deputy')}
                  AND ${uuidAny(col('approver_department_id'), coverage.deputyOf)})))
     OR (${col('approver_type')}::text = 'ROLE'
         AND (${byRole.length === 0 ? SQL_FALSE : Prisma.join(byRole, ' OR ')})))`;
}

/**
 * US-136 (`myLineOf` · RN-APV-66 · FA-04): a linha não substituída de quem consulta — designado
 * nela ou quem a decidiu —, a `PENDING` de menor ordem, senão a `WAITING`, senão a que decidiu. LATERAL
 * sobre `approval_approvers` (índice `approval_approvers_approval_idx`): uma linha por aprovação.
 */
export function myLineSql(coverage: ApproverCoverage): Prisma.Sql {
  return Prisma.sql`LEFT JOIN LATERAL (
        SELECT l.id, l.sequence, l.status::text AS status
          FROM approval_approvers l
         WHERE l.tenant_id = ap.tenant_id AND l.approval_id = ap.id
           AND NOT (l.status = 'CANCELED' AND l.skipped_reason IS NOT DISTINCT FROM 'REASSIGNED')
           AND (l.decided_by_id = ${coverage.userId}::uuid OR ${designatedSql(coverage)})
         ORDER BY CASE l.status WHEN 'PENDING' THEN 0 WHEN 'WAITING' THEN 1
                                WHEN 'CANCELED' THEN 3 ELSE 2 END,
                  CASE WHEN l.decided_by_id = ${coverage.userId}::uuid THEN 0 ELSE 1 END,
                  l.sequence
         LIMIT 1) ml ON TRUE`;
}

/** RN-INBOX-14 · RN-APV-66 (`isInApprovalList`): com linha vigente minha ou decidida por mim. */
export function coverageSql(coverage: ApproverCoverage): Prisma.Sql {
  return Prisma.sql`(ap.decided_by_id = ${coverage.userId}::uuid OR ml.id IS NOT NULL)`;
}

/** RN-INBOX-15 (`matchesCriteria`). */
export function criteriaSql(criteria: ApprovalListCriteria): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`ap.status::text = ANY(${[...criteria.statuses]}::text[])`,
  ];
  if (criteria.subjectType !== null) {
    parts.push(Prisma.sql`ap.subject_type::text = ${criteria.subjectType}`);
  }
  if (criteria.decisionPolicies !== null) {
    parts.push(
      Prisma.sql`ap.decision_policy::text = ANY(${[...criteria.decisionPolicies]}::text[])`,
    );
  }
  if (criteria.myLineStatus !== null) {
    parts.push(Prisma.sql`ml.status = ${criteria.myLineStatus}`);
  }
  if (criteria.requestingDepartmentId !== null) {
    parts.push(Prisma.sql`(pr.requesting_secretariat_id = ${criteria.requestingDepartmentId}::uuid
         OR pr.requesting_department_id = ${criteria.requestingDepartmentId}::uuid)`);
  }
  if (criteria.requestedFrom !== null) {
    parts.push(
      Prisma.sql`ap.requested_at >= (${criteria.requestedFrom}::date::timestamp AT TIME ZONE ${criteria.timezone})`,
    );
  }
  if (criteria.requestedTo !== null) {
    parts.push(
      Prisma.sql`ap.requested_at < ((${criteria.requestedTo}::date + 1)::timestamp AT TIME ZONE ${criteria.timezone})`,
    );
  }
  if (criteria.q !== null) {
    const needle = `%${criteria.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const like = (column: Prisma.Sql) =>
      Prisma.sql`lower(cf_unaccent(${column})) LIKE lower(cf_unaccent(${needle}))`;
    parts.push(Prisma.sql`(${like(Prisma.sql`coalesce(pr.code, '')`)}
         OR ${like(Prisma.sql`pr.title`)} OR ${like(Prisma.sql`ap.title`)})`);
  }
  return Prisma.join(parts, ' AND ');
}

const DIRECTION = { asc: Prisma.raw('ASC'), desc: Prisma.raw('DESC') } as const;

/** RN-INBOX-18: colunas de cada campo (lista fechada, alias `i` do conjunto). */
const SORT_COLUMNS: Readonly<Record<ApprovalListSort['field'], readonly Prisma.Sql[]>> = {
  requestedAt: [Prisma.sql`i.requested_at`],
  dueAt: [Prisma.sql`i.due_at`],
  // Ano e número; sem número ao final.
  code: [Prisma.sql`CASE WHEN i.number IS NULL THEN NULL ELSE i.year END`, Prisma.sql`i.number`],
};

export function orderSql(sort: ApprovalListSort): Prisma.Sql {
  const parts = SORT_COLUMNS[sort.field].map(
    (column) => Prisma.sql`${column} ${DIRECTION[sort.direction]} NULLS LAST`,
  );
  parts.push(Prisma.sql`i.id DESC`);
  return Prisma.join(parts, ', ');
}

/** A página e o total numa instrução (LATERAL sobre o conjunto). */
export function buildApprovalListPageSql(search: ApprovalListSearch): Prisma.Sql {
  const offset = (search.page - 1) * search.pageSize;
  return Prisma.sql`
    WITH items AS (
      SELECT ap.id, ap.tenant_id, ap.process_id, ap.subject_type::text AS subject_type, ap.title,
             ap.document_id, ap.process_stage_id, ap.status::text AS status, ap.requested_by_id,
             ap.requested_at,
             ap.due_at, ap.approver_type::text AS approver_type, ap.approver_user_id,
             ap.approver_role_id, ap.approver_department_id, ap.allow_deputy, ap.decided_by_id,
             ap.decision_policy::text AS decision_policy,
             ml.id AS my_line_id, ml.sequence AS my_line_sequence, ml.status AS my_line_status,
             pr.code, pr.number, pr.year, pr.title AS process_title, pr.organization_id,
             pr.requesting_secretariat_id, pr.requesting_department_id, pr.is_budget_confidential
        FROM approvals ap
        JOIN v_inbox_processes pr ON pr.tenant_id = ap.tenant_id AND pr.id = ap.process_id
        ${myLineSql(search.coverage)}
       WHERE ${coverageSql(search.coverage)} AND ${criteriaSql(search.criteria)}
    )
    SELECT t.total, page.*
      FROM (SELECT count(*)::int AS total FROM items) t
      LEFT JOIN LATERAL (
        SELECT i.* FROM items i
         ORDER BY ${orderSql(search.sort)}
         LIMIT ${search.pageSize} OFFSET ${offset}
      ) page ON TRUE`;
}

/** Linha crua da página (`page.*` nulo quando a página está vazia). */
export interface ApprovalListDbRow {
  readonly total: number;
  readonly id: string | null;
  readonly tenant_id: string;
  readonly process_id: string;
  readonly subject_type: string;
  readonly title: string;
  readonly document_id: string | null;
  readonly process_stage_id: string | null;
  readonly status: string;
  readonly requested_by_id: string;
  readonly requested_at: Date;
  readonly due_at: Date | null;
  readonly approver_type: string;
  readonly approver_user_id: string | null;
  readonly approver_role_id: string | null;
  readonly approver_department_id: string | null;
  readonly allow_deputy: boolean;
  readonly decided_by_id: string | null;
  readonly decision_policy: string;
  readonly my_line_id: string | null;
  readonly my_line_sequence: number | null;
  readonly my_line_status: string | null;
  readonly code: string | null;
  readonly number: number | null;
  readonly year: number;
  readonly process_title: string;
  readonly organization_id: string;
  readonly requesting_secretariat_id: string;
  readonly requesting_department_id: string;
  readonly is_budget_confidential: boolean;
}

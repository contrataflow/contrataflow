import { TASK_INBOX_VIEWS } from '@contrataflow/validation';
import type { TaskInboxSort, TaskInboxView } from '@contrataflow/validation';

import { Prisma } from '#shared/database/prisma.js';
import { buildVisibilityPredicate } from '#shared/database/process-visibility.js';

import type { InboxPageSearch } from '../application/ports.js';
import type { InboxProcessRestriction, InboxViewer } from '../domain/task-inbox.js';

/*
 * `TaskInboxQueryBuilder` (US-056 · DEC-026): cada visão é UMA consulta sobre as views publicadas
 * (`v_inbox_processes`, `v_inbox_participations`, `v_inbox_pending_approvals_v2` — US-136: uma
 * linha por `ApprovalApprover` `PENDING`, RN-APV-61), com o predicado de
 * visibilidade único (`buildVisibilityPredicate`, DEC-024) e o predicado da visão — o mesmo de
 * `domain/task-inbox.ts`, linha a linha. Página e total saem de uma instrução; os contadores, de
 * outra, compondo os MESMOS `itemsSql` (RN-INBOX-09). Ordenação de lista fechada; todo valor do
 * usuário é parâmetro (`Prisma.sql`).
 */

const SQL_FALSE = Prisma.sql`FALSE`;

const uuidAny = (column: Prisma.Sql, ids: readonly string[]) =>
  ids.length === 0 ? SQL_FALSE : Prisma.sql`${column} = ANY(${[...ids]}::uuid[])`;

/** RN-INBOX-03. */
const mineSql = (viewer: InboxViewer) => Prisma.sql`pr.assignee_id = ${viewer.userId}::uuid`;

/** RN-INBOX-04. */
const unitQueueSql = (viewer: InboxViewer) =>
  viewer.queueDepartmentIds.length === 0
    ? SQL_FALSE
    : Prisma.sql`(pr.assignee_id IS NULL
        AND ${uuidAny(Prisma.sql`pr.assignment_department_id`, viewer.queueDepartmentIds)})`;

/** RN-INBOX-08: participação individual não revogada e não vencida. */
const followingSql = (viewer: InboxViewer, now: Date) => Prisma.sql`EXISTS (
      SELECT 1 FROM v_inbox_participations pp
       WHERE pp.tenant_id = pr.tenant_id AND pp.process_id = pr.id
         AND pp.user_id = ${viewer.userId}::uuid
         AND (pp.expires_at IS NULL OR pp.expires_at > ${now}))`;

/** RN-INBOX-07 (POL-03): designado direto, por titularidade (substituto com `allowDeputy`) ou perfil. */
function designatedSql(viewer: InboxViewer): Prisma.Sql {
  const { headOf, deputyOf, roles } = viewer.approver;
  const byRole = roles.map((role) => {
    const coverage: Prisma.Sql[] = [];
    if (role.tenantWide) coverage.push(Prisma.sql`TRUE`);
    if (role.organizationId !== null) {
      coverage.push(Prisma.sql`pr.organization_id = ${role.organizationId}::uuid`);
    }
    if (role.departmentIds.length > 0) {
      coverage.push(
        uuidAny(Prisma.sql`pr.requesting_secretariat_id`, role.departmentIds),
        uuidAny(Prisma.sql`pr.requesting_department_id`, role.departmentIds),
      );
    }
    return coverage.length === 0
      ? SQL_FALSE
      : Prisma.sql`(ap.approver_role_id = ${role.roleId}::uuid
          AND (${Prisma.join(coverage, ' OR ')}))`;
  });
  return Prisma.sql`(
        (ap.approver_type::text = 'USER' AND ap.approver_user_id = ${viewer.userId}::uuid)
     OR (ap.approver_type::text = 'DEPARTMENT_HEAD'
         AND (${uuidAny(Prisma.sql`ap.approver_department_id`, headOf)}
              OR (ap.allow_deputy
                  AND ${uuidAny(Prisma.sql`ap.approver_department_id`, deputyOf)})))
     OR (ap.approver_type::text = 'ROLE'
         AND (${byRole.length === 0 ? SQL_FALSE : Prisma.join(byRole, ' OR ')})))`;
}

/** Colunas do processo, da passagem ativa e da responsabilidade ativa (alias `pr`). */
const PROCESS_COLUMNS = Prisma.sql`pr.id AS process_id, pr.tenant_id, pr.organization_id, pr.code,
       pr.number, pr.year, pr.title, pr.status::text AS status, pr.version,
       pr.is_budget_confidential, pr.requesting_secretariat_id, pr.requesting_department_id,
       pr.current_department_id, pr.current_responsible_id, pr.current_workflow_stage_id,
       pr.stage_id, pr.entered_at, pr.due_at, pr.overdue_since, pr.sla_type::text AS sla_type,
       pr.paused_at, pr.assignment_department_id, pr.assignee_id,
       pr.assignment_type::text AS assignment_type, pr.branch_key, pr.stage_workflow_stage_id,
       pr.stage_department_id, pr.active_stages_count`;

const NO_APPROVAL_COLUMNS = Prisma.sql`NULL::uuid AS approval_id, NULL::uuid AS approval_approver_id,
       NULL::int AS approval_sequence, NULL::text AS approval_decision_policy,
       NULL::timestamptz AS approval_line_due_at, NULL::int AS approval_total_lines,
       NULL::int AS approval_approved_lines, NULL::int AS approval_pending_lines,
       NULL::int AS approval_waiting_lines, NULL::text AS approval_subject_type,
       NULL::text AS approval_title, NULL::uuid AS approval_requested_by_id,
       NULL::timestamptz AS approval_requested_at, NULL::timestamptz AS approval_due_at,
       NULL::text AS approver_type, NULL::uuid AS approver_user_id, NULL::uuid AS approver_role_id,
       NULL::uuid AS approver_department_id, NULL::boolean AS allow_deputy,
       NULL::uuid AS approval_process_stage_id, NULL::text AS approval_branch_key`;

/** `matchesRestriction` (US-076): recorte pela unidade solicitante; `TRUE` sem recorte. */
function restrictionSql(restriction: InboxProcessRestriction | null): Prisma.Sql {
  if (restriction === null) return Prisma.sql`TRUE`;
  const parts: Prisma.Sql[] = [];
  if (restriction.secretariatId !== null) {
    parts.push(Prisma.sql`pr.requesting_secretariat_id = ${restriction.secretariatId}::uuid`);
  }
  if (restriction.departmentIds !== null) {
    parts.push(uuidAny(Prisma.sql`pr.requesting_department_id`, restriction.departmentIds));
  }
  return parts.length === 0 ? Prisma.sql`TRUE` : Prisma.join(parts, ' AND ');
}

/**
 * O conjunto da visão (uma linha por chave), já com visibilidade (DEC-024). US-125 (RN-WF2-29):
 * `row_key` é o processo (ou a linha de aprovação) e `row_stage_id`, a etapa de ramo que a linha
 * descreve (`NULL` = linha do processo); `branchKey` restringe às linhas daquele ramo.
 */
export function itemsSql(
  view: TaskInboxView,
  viewer: InboxViewer,
  now: Date,
  restriction: InboxProcessRestriction | null = null,
  branchKey: string | null = null,
): Prisma.Sql {
  const visible = Prisma.sql`${buildVisibilityPredicate(viewer.visibility, {
    processAlias: 'pr',
    historicalDepartmentsCanView: viewer.historicalDepartmentsCanView,
  })} AND ${restrictionSql(restriction)}`;
  if (view === 'PENDING_APPROVALS') {
    // RN-APV-62: `ap` é a linha (uma por `approval_approver_id`); a cobertura por dois caminhos é
    // um OR no predicado — nunca uma junção que multiplique. US-125: a linha do processo é UMA —
    // a da etapa da aprovação, senão a da etapa crítica (LATERAL … LIMIT 1).
    const inBranch =
      branchKey === null ? Prisma.sql`TRUE` : Prisma.sql`ap.branch_key = ${branchKey}`;
    return Prisma.sql`
      SELECT ap.approval_approver_id AS row_key,
             CASE WHEN ap.branch_key IS NOT NULL AND pr.process_stage_id = ap.process_stage_id
                  THEN pr.process_stage_id END AS row_stage_id,
             ${PROCESS_COLUMNS},
             ap.approval_id, ap.approval_approver_id, ap.sequence AS approval_sequence,
             ap.decision_policy AS approval_decision_policy,
             ap.line_due_at AS approval_line_due_at, ap.total_lines AS approval_total_lines,
             ap.approved_lines AS approval_approved_lines,
             ap.pending_lines AS approval_pending_lines,
             ap.waiting_lines AS approval_waiting_lines,
             ap.subject_type::text AS approval_subject_type,
             ap.title AS approval_title, ap.requested_by_id AS approval_requested_by_id,
             ap.requested_at AS approval_requested_at, ap.due_at AS approval_due_at,
             ap.approver_type::text AS approver_type, ap.approver_user_id, ap.approver_role_id,
             ap.approver_department_id, ap.allow_deputy,
             ap.process_stage_id AS approval_process_stage_id,
             ap.branch_key AS approval_branch_key,
             COALESCE(ap.line_due_at, ap.due_at, pr.due_at) AS row_due_at
        FROM v_inbox_pending_approvals_v2 ap
        JOIN LATERAL (
          SELECT * FROM v_inbox_processes vp
           WHERE vp.tenant_id = ap.tenant_id AND vp.id = ap.process_id
           ORDER BY (vp.process_stage_id IS NOT DISTINCT FROM ap.process_stage_id) DESC,
                    vp.due_at ASC NULLS LAST, vp.process_stage_id
           LIMIT 1
        ) pr ON TRUE
       WHERE ${visible} AND ${inBranch} AND ${designatedSql(viewer)}`;
  }
  const mine = mineSql(viewer);
  const queue = unitQueueSql(viewer);
  const predicate: Record<Exclude<TaskInboxView, 'PENDING_APPROVALS'>, Prisma.Sql> = {
    MINE: mine,
    UNIT_QUEUE: queue,
    RETURNED: Prisma.sql`(pr.assignment_type::text = 'RETURN' AND (${mine} OR ${queue}))`,
    OVERDUE: Prisma.sql`(pr.stage_id IS NOT NULL AND pr.overdue_since IS NOT NULL
                         AND (${mine} OR ${queue}))`,
    FOLLOWING: followingSql(viewer, now),
  };
  const inBranch = branchKey === null ? Prisma.sql`TRUE` : Prisma.sql`pr.branch_key = ${branchKey}`;
  if (view === 'FOLLOWING') {
    // RN-WF2-29: "Acompanhando" é uma linha por processo, sem ramo — a da etapa crítica.
    return Prisma.sql`
      SELECT DISTINCT ON (pr.id) pr.id AS row_key, NULL::uuid AS row_stage_id, ${PROCESS_COLUMNS},
             ${NO_APPROVAL_COLUMNS}, pr.due_at AS row_due_at
        FROM v_inbox_processes pr
       WHERE ${visible} AND ${inBranch} AND ${predicate[view]}
       ORDER BY pr.id, pr.due_at ASC NULLS LAST, pr.process_stage_id`;
  }
  return Prisma.sql`
      SELECT pr.id AS row_key,
             CASE WHEN pr.branch_key IS NOT NULL THEN pr.process_stage_id END AS row_stage_id,
             ${PROCESS_COLUMNS}, ${NO_APPROVAL_COLUMNS}, pr.due_at AS row_due_at
        FROM v_inbox_processes pr
       WHERE ${visible} AND ${inBranch} AND ${predicate[view]}`;
}

const DIRECTION = { asc: Prisma.raw('ASC'), desc: Prisma.raw('DESC') } as const;

/** RN-INBOX-10: colunas de cada campo (lista fechada, alias `i` do conjunto). */
const SORT_COLUMNS: Readonly<Record<TaskInboxSort['field'], readonly Prisma.Sql[]>> = {
  dueAt: [Prisma.sql`i.row_due_at`],
  enteredAt: [Prisma.sql`i.entered_at`],
  requestedAt: [Prisma.sql`i.approval_requested_at`],
  // Ano e número; sem número ao final.
  code: [Prisma.sql`CASE WHEN i.number IS NULL THEN NULL ELSE i.year END`, Prisma.sql`i.number`],
};

export function orderSql(sort: TaskInboxSort): Prisma.Sql {
  const parts = SORT_COLUMNS[sort.field].map(
    (column) => Prisma.sql`${column} ${DIRECTION[sort.direction]} NULLS LAST`,
  );
  // Desempate final: paginação determinística (US-125: o mesmo processo em várias linhas de ramo).
  parts.push(Prisma.sql`i.row_key DESC`, Prisma.sql`i.row_stage_id DESC NULLS LAST`);
  return Prisma.join(parts, ', ');
}

/** A página e o total da visão numa instrução (LATERAL sobre o conjunto). */
export function buildTaskInboxPageSql(search: InboxPageSearch): Prisma.Sql {
  const offset = (search.page - 1) * search.pageSize;
  return Prisma.sql`
    WITH items AS (${itemsSql(search.view, search.viewer, search.now, null, search.branchKey)}
    )
    SELECT t.total, page.*
      FROM (SELECT count(*)::int AS total FROM items) t
      LEFT JOIN LATERAL (
        SELECT i.* FROM items i
         ORDER BY ${orderSql(search.sort)}
         LIMIT ${search.pageSize} OFFSET ${offset}
      ) page ON TRUE`;
}

/** Os contadores de todas as visões numa instrução (mesmo snapshot — RN-INBOX-09). */
export function buildTaskInboxCountsSql(
  viewer: InboxViewer,
  now: Date,
  restriction: InboxProcessRestriction | null = null,
): Prisma.Sql {
  const counts = TASK_INBOX_VIEWS.map(
    (view) =>
      Prisma.sql`(SELECT count(*) FROM (${itemsSql(view, viewer, now, restriction)}) c)::int AS ${Prisma.raw(
        `"${view}"`,
      )}`,
  );
  return Prisma.sql`SELECT ${Prisma.join(counts, ', ')}`;
}

/** Linha crua da página (`page.*` nulo quando a página está vazia). */
export interface TaskInboxDbRow {
  readonly total: number;
  readonly row_key: string | null;
  readonly row_stage_id: string | null;
  readonly process_id: string;
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly code: string | null;
  readonly number: number | null;
  readonly year: number;
  readonly title: string;
  readonly status: string;
  readonly version: number;
  readonly is_budget_confidential: boolean;
  readonly requesting_secretariat_id: string;
  readonly requesting_department_id: string;
  readonly current_department_id: string;
  readonly current_responsible_id: string | null;
  readonly current_workflow_stage_id: string | null;
  readonly stage_id: string | null;
  readonly entered_at: Date | null;
  readonly due_at: Date | null;
  readonly overdue_since: Date | null;
  readonly sla_type: string | null;
  readonly paused_at: Date | null;
  readonly assignment_department_id: string | null;
  readonly assignee_id: string | null;
  readonly assignment_type: string | null;
  readonly branch_key: string | null;
  readonly stage_workflow_stage_id: string | null;
  readonly stage_department_id: string | null;
  readonly active_stages_count: number;
  readonly approval_id: string | null;
  readonly approval_approver_id: string | null;
  readonly approval_sequence: number | null;
  readonly approval_decision_policy: string | null;
  readonly approval_line_due_at: Date | null;
  readonly approval_total_lines: number | null;
  readonly approval_approved_lines: number | null;
  readonly approval_pending_lines: number | null;
  readonly approval_waiting_lines: number | null;
  readonly approval_subject_type: string | null;
  readonly approval_title: string | null;
  readonly approval_requested_by_id: string | null;
  readonly approval_requested_at: Date | null;
  readonly approval_due_at: Date | null;
  readonly approver_type: string | null;
  readonly approver_user_id: string | null;
  readonly approver_role_id: string | null;
  readonly approver_department_id: string | null;
  readonly allow_deputy: boolean | null;
  readonly approval_process_stage_id: string | null;
  readonly approval_branch_key: string | null;
}

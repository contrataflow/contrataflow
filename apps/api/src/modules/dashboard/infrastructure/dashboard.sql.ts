import { DASHBOARD_DEADLINE_STATUSES, DASHBOARD_OPEN_STATUSES } from '@contrataflow/validation';

import { Prisma } from '#shared/database/prisma.js';
import {
  buildConfidentialBudgetPredicate,
  buildVisibilityPredicate,
} from '#shared/database/process-visibility.js';

import type { DashboardSearch } from '../application/ports.js';
import type { DashboardScope } from '../domain/dashboard.js';

/*
 * `DashboardQueryBuilder` (US-076): cada indicador é UMA instrução sobre as views publicadas pela
 * migração `20261020090000_dashboard_views` (`v_dashboard_processes` com alias `p`,
 * `v_dashboard_stage_passages`, `v_dashboard_timeline` — DEC-088)
 * com o predicado de visibilidade único (`buildVisibilityPredicate`, DEC-024 — RN-DASH-01), o
 * recorte dos filtros (RN-DASH-09) e o predicado do indicador — o mesmo de `domain/dashboard.ts`,
 * linha a linha. POL-09 nos agregados pelo predicado compartilhado
 * (`buildConfidentialBudgetPredicate`). Todo valor do usuário é parâmetro (`Prisma.sql`).
 */

const SQL_TRUE = Prisma.sql`TRUE`;

/** `inScope`: recorte pela unidade solicitante. */
export function scopeSql(scope: DashboardScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (scope.secretariatId !== null) {
    parts.push(Prisma.sql`p.requesting_secretariat_id = ${scope.secretariatId}::uuid`);
  }
  if (scope.departmentIds !== null) {
    parts.push(
      scope.departmentIds.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`p.requesting_department_id = ANY(${[...scope.departmentIds]}::uuid[])`,
    );
  }
  return parts.length === 0 ? SQL_TRUE : Prisma.join(parts, ' AND ');
}

/** Processos visíveis a quem consulta e recortados pelos filtros. */
function baseSql(search: DashboardSearch): Prisma.Sql {
  return Prisma.sql`${buildVisibilityPredicate(search.viewer.visibility, {
    processAlias: 'p',
    historicalDepartmentsCanView: search.viewer.historicalDepartmentsCanView,
  })} AND ${scopeSql(search.scope)}`;
}

const statusIn = (statuses: readonly string[]) =>
  Prisma.sql`p.status::text = ANY(${[...statuses]}::text[])`;

const OPEN = statusIn(DASHBOARD_OPEN_STATUSES);

/** `isOverdue`. */
const overdueSql = Prisma.sql`(${statusIn(DASHBOARD_DEADLINE_STATUSES)} AND p.overdue_since IS NOT NULL)`;

/** `isDueSoon`. */
function dueSoonSql(search: DashboardSearch): Prisma.Sql {
  return Prisma.sql`(${statusIn(DASHBOARD_DEADLINE_STATUSES)} AND p.overdue_since IS NULL
    AND p.current_stage_due_at >= ${search.window.dueSoonFrom}
    AND p.current_stage_due_at <= ${search.window.dueSoonUntil})`;
}

/** `canViewBudget` (POL-09) para a linha `p`. */
function budgetSql(search: DashboardSearch, assumeConfidential = false): Prisma.Sql {
  return buildConfidentialBudgetPredicate(search.viewer.budget, {
    processAlias: 'p',
    historicalDepartmentsCanView: search.viewer.historicalDepartmentsCanView,
    assumeConfidential,
  });
}

/** DSH-01 (`processCounts`): os três contadores do mesmo snapshot. */
export function buildProcessCountsSql(search: DashboardSearch): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*) FILTER (WHERE ${overdueSql})::int AS overdue,
           count(*) FILTER (WHERE ${dueSoonSql(search)})::int AS due_soon,
           count(*) FILTER (WHERE ${OPEN})::int AS open
      FROM v_dashboard_processes p
     WHERE ${baseSql(search)}`;
}

/** `BY_STATUS` (`countByStatus`). */
export function buildCountByStatusSql(search: DashboardSearch): Prisma.Sql {
  return Prisma.sql`
    SELECT p.status::text AS key, count(*)::int AS value
      FROM v_dashboard_processes p
     WHERE ${baseSql(search)}
     GROUP BY p.status`;
}

/** `BY_STAGE`: abertos por etapa atual. */
export function buildCountByStageSql(search: DashboardSearch): Prisma.Sql {
  return Prisma.sql`
    SELECT p.current_workflow_stage_id::text AS key, count(*)::int AS value
      FROM v_dashboard_processes p
     WHERE ${baseSql(search)} AND ${OPEN} AND p.current_workflow_stage_id IS NOT NULL
     GROUP BY p.current_workflow_stage_id`;
}

/** `OVERDUE`/`DUE_SOON`: por secretaria solicitante. */
export function buildDeadlinesBySecretariatSql(
  search: DashboardSearch,
  kind: 'OVERDUE' | 'DUE_SOON',
): Prisma.Sql {
  return Prisma.sql`
    SELECT p.requesting_secretariat_id::text AS key, count(*)::int AS value
      FROM v_dashboard_processes p
     WHERE ${baseSql(search)} AND ${kind === 'OVERDUE' ? overdueSql : dueSoonSql(search)}
     GROUP BY p.requesting_secretariat_id`;
}

/**
 * `AVG_STAGE_DURATION` (RN-DASH-05): passagens que saíram na janela de 90 dias, dos processos
 * visíveis — índice `process_stages_exited_idx`.
 */
export function buildAverageStageDurationsSql(search: DashboardSearch): Prisma.Sql {
  return Prisma.sql`
    SELECT s.workflow_stage_id::text AS key,
           round(avg(GREATEST(extract(epoch FROM (s.exited_at - s.entered_at)), 0)))::int AS average_seconds,
           count(*)::int AS sample_size
      FROM v_dashboard_stage_passages s
      JOIN v_dashboard_processes p ON p.tenant_id = s.tenant_id AND p.id = s.process_id
     WHERE s.exited_at IS NOT NULL
       AND s.exited_at >= ${search.window.stageWindowStart}
       AND s.exited_at <= ${search.window.now}
       AND ${baseSql(search)}
     GROUP BY s.workflow_stage_id`;
}

/** `OPENED_BY_MONTH` (RN-DASH-06): mês de `opened_at` no fuso do tenant. */
export function buildOpenedByMonthSql(search: DashboardSearch): Prisma.Sql {
  return Prisma.sql`
    SELECT to_char(p.opened_at AT TIME ZONE ${search.window.timezone}, 'YYYY-MM') AS key,
           count(*)::int AS value
      FROM v_dashboard_processes p
     WHERE ${baseSql(search)}
       AND p.opened_at IS NOT NULL
       AND p.opened_at >= ${search.window.openedFrom}
       AND p.opened_at <= ${search.window.now}
     GROUP BY 1`;
}

/**
 * `VALUE_BY_SECRETARIAT` (RN-DASH-07 · POL-09, agregados): soma só do que quem consulta pode ver;
 * o grupo com sigiloso fora da soma vem com `confidential_excluded`.
 */
export function buildValueBySecretariatSql(search: DashboardSearch): Prisma.Sql {
  // `NULL` (ex.: responsável nulo comparado ao usuário) conta como "não pode ver".
  const canView = Prisma.sql`COALESCE(${budgetSql(search)}, FALSE)`;
  return Prisma.sql`
    SELECT p.requesting_secretariat_id::text AS key,
           (COALESCE(sum(p.estimated_value) FILTER (WHERE ${canView}), 0))::numeric(38, 2)::text AS value,
           bool_or(NOT ${canView}) AS confidential_excluded
      FROM v_dashboard_processes p
     WHERE ${baseSql(search)} AND ${OPEN} AND p.estimated_value IS NOT NULL
     GROUP BY p.requesting_secretariat_id`;
}

/**
 * `RECENT_ACTIVITY` (RN-DASH-08): as últimas entradas dos processos visíveis, na ordem da timeline
 * (índice `process_timeline_entries_tenant_recent_idx`); `BUDGET_RESTRICTED` só com POL-09
 * avaliada como se o processo fosse sigiloso (RN-TML-13) — no `WHERE`, antes do `LIMIT`.
 */
export function buildRecentActivitySql(search: DashboardSearch, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT t.id, t.tenant_id, t.process_id, t.occurred_at, t.type, t.actor_type::text AS actor_type,
           t.actor_id, t.actor_name, t.actor_department_name, t.entity_type, t.entity_id,
           t.movement_id, t.params, t.visibility::text AS visibility, p.code AS process_code
      FROM v_dashboard_timeline t
      JOIN v_dashboard_processes p ON p.tenant_id = t.tenant_id AND p.id = t.process_id
     WHERE ${baseSql(search)}
       AND (t.visibility = 'STANDARD'::timeline_visibility OR ${budgetSql(search, true)})
     ORDER BY t.occurred_at DESC, t.id DESC
     LIMIT ${limit}`;
}

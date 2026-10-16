import { FINAL_PROCESS_STATUSES, OVERDUE_ELIGIBLE_STATUSES } from '@contrataflow/validation';
import type {
  DayCountType,
  Priority,
  ProcessListSortField,
  ProcessStatus,
} from '@contrataflow/validation';

import { Prisma } from '#shared/database/prisma.js';
import { buildVisibilityPredicate } from '#shared/database/process-visibility.js';

import type { BudgetVisibility, ProcessListRow, ProcessListSearch } from '../application/ports.js';
import type { ProcessListCriteria, ProcessListOrder } from '../domain/process-list.js';

/*
 * `ProcessListQueryBuilder` (US-002 · RN-PROC-19..28): a lista de processos em UMA instrução SQL —
 * página e total do mesmo snapshot — com o predicado de visibilidade único
 * (`buildVisibilityPredicate`), os filtros (E entre filtros, OU dentro de cada um), a busca FTS +
 * trigram e o desmascaramento POL-09 por linha (`can_view_budget`) usado no valor, no filtro e na
 * ordenação. Colunas de filtro e de ordenação vêm de listas fechadas; todo valor do usuário é
 * parâmetro (`Prisma.sql`), nunca texto interpolado.
 */

const SQL_FALSE = Prisma.sql`FALSE`;

function reasonsOf(historicalDepartmentsCanView: boolean): string[] {
  return historicalDepartmentsCanView
    ? ['REQUESTING', 'CURRENT', 'HISTORICAL']
    : ['REQUESTING', 'CURRENT'];
}

/**
 * `BudgetVisibilityService.sqlCanView` (POL-09 · RN-PROC-25): o valor do processo sigiloso é
 * visível com `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo-o (tenant, órgão ou unidade com
 * `ProcessAccess`) ou com a custódia atual (responsável, ou fila de uma lotação do vínculo).
 */
export function budgetVisibilitySql(
  budget: BudgetVisibility,
  historicalDepartmentsCanView: boolean,
): Prisma.Sql {
  return Prisma.sql`(
        NOT p.is_budget_confidential
     OR ${budget.tenantWide}
     OR p.organization_id = ANY(${[...budget.organizationIds]}::uuid[])
     OR p.current_responsible_id = ${budget.userId}::uuid
     OR (p.current_responsible_id IS NULL
         AND p.current_department_id = ANY(${[...budget.custodyDepartmentIds]}::uuid[]))
     OR EXISTS (SELECT 1 FROM process_access ba
                 WHERE ba.tenant_id = p.tenant_id AND ba.process_id = p.id
                   AND ba.revoked_at IS NULL AND ba.principal_type = 'DEPARTMENT'
                   AND ba.department_id = ANY(${[...budget.departmentIds]}::uuid[])
                   AND ba.reason::text = ANY(${reasonsOf(historicalDepartmentsCanView)}::text[])))`;
}

const uuidIn = (column: Prisma.Sql, ids: readonly string[]) =>
  Prisma.sql`${column} = ANY(${[...ids]}::uuid[])`;

/** `ids` OU (`none` E coluna nula); nenhum dos dois = nada casa. */
function idsOrNone(
  column: Prisma.Sql,
  filter: { readonly ids: readonly string[]; readonly none: boolean },
): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filter.ids.length > 0) parts.push(uuidIn(column, filter.ids));
  if (filter.none) parts.push(Prisma.sql`${column} IS NULL`);
  return parts.length === 0 ? SQL_FALSE : Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

const tsQuery = (q: string) =>
  Prisma.sql`websearch_to_tsquery('portuguese'::regconfig, cf_unaccent(${q}))`;

/** RN-PROC-26: FTS sobre `search_vector` OU trigram (`%`, limiar padrão 0,3 = `SEARCH_SIMILARITY_THRESHOLD`) em código ou título. */
function searchSql(q: string): Prisma.Sql {
  return Prisma.sql`(p.search_vector @@ ${tsQuery(q)} OR p.code % ${q} OR p.title % ${q})`;
}

/** RN-PROC-23: status elegível E (`overdue_since` OU prazo da etapa vencido). */
function overdueSql(now: Date): Prisma.Sql {
  return Prisma.sql`(p.status = ANY(${[...OVERDUE_ELIGIBLE_STATUSES]}::process_status[])
    AND (p.overdue_since IS NOT NULL OR p.current_stage_due_at < ${now}))`;
}

function targetDateOverdueSql(today: string): Prisma.Sql {
  return Prisma.sql`COALESCE(p.target_date < ${today}::date
    AND NOT (p.status = ANY(${[...FINAL_PROCESS_STATUSES]}::process_status[])), FALSE)`;
}

/** Condições do `WHERE` além da visibilidade (RN-PROC-20..25 · RN-PROC-31). */
export function criteriaSql(
  criteria: ProcessListCriteria,
  context: Pick<ProcessListSearch, 'now' | 'today' | 'timezone'>,
  canViewBudget: Prisma.Sql,
): Prisma.Sql[] {
  const where: Prisma.Sql[] = [];
  const list = (column: Prisma.Sql, ids: readonly string[] | null) => {
    if (ids !== null) where.push(ids.length === 0 ? SQL_FALSE : uuidIn(column, ids));
  };
  if (criteria.search !== null) where.push(searchSql(criteria.search));
  if (criteria.statuses !== null) {
    where.push(Prisma.sql`p.status = ANY(${[...criteria.statuses]}::process_status[])`);
  }
  list(Prisma.sql`p.current_workflow_stage_id`, criteria.stageIdsByKey);
  list(Prisma.sql`p.current_workflow_stage_id`, criteria.currentWorkflowStageIds);
  list(Prisma.sql`p.current_department_id`, criteria.currentDepartmentIds);
  list(Prisma.sql`p.requesting_secretariat_id`, criteria.requestingSecretariatIds);
  list(Prisma.sql`p.requesting_department_id`, criteria.requestingDepartmentIds);
  list(Prisma.sql`p.organization_id`, criteria.organizationIds);
  if (criteria.responsible !== null) {
    where.push(idsOrNone(Prisma.sql`p.current_responsible_id`, criteria.responsible));
  }
  if (criteria.priorities !== null) {
    where.push(Prisma.sql`p.priority = ANY(${[...criteria.priorities] as Priority[]}::priority[])`);
  }
  list(Prisma.sql`p.contracting_type_id`, criteria.contractingTypeIds);
  if (criteria.modality !== null) {
    where.push(idsOrNone(Prisma.sql`p.modality_id`, criteria.modality));
  }
  list(Prisma.sql`p.origin_id`, criteria.originIds);
  if (criteria.years !== null) where.push(Prisma.sql`p.year = ANY(${[...criteria.years]}::int[])`);
  // Etiquetas (US-007) ainda não têm tabela: nenhum processo tem etiqueta, o filtro não casa.
  if (criteria.tagIds !== null) where.push(SQL_FALSE);
  if (criteria.overdue !== null) {
    const overdue = overdueSql(context.now);
    where.push(criteria.overdue ? overdue : Prisma.sql`NOT ${overdue}`);
  }
  if (criteria.targetDateOverdue !== null) {
    const overdue = targetDateOverdueSql(context.today);
    where.push(criteria.targetDateOverdue ? overdue : Prisma.sql`NOT ${overdue}`);
  }
  // RN-PROC-31: datas locais inclusivas no fuso do tenant.
  if (criteria.createdFrom !== null) {
    where.push(
      Prisma.sql`p.created_at >= (${criteria.createdFrom}::date::timestamp AT TIME ZONE ${context.timezone})`,
    );
  }
  if (criteria.createdTo !== null) {
    where.push(
      Prisma.sql`p.created_at < ((${criteria.createdTo}::date + 1)::timestamp AT TIME ZONE ${context.timezone})`,
    );
  }
  if (criteria.targetDateFrom !== null) {
    where.push(Prisma.sql`p.target_date >= ${criteria.targetDateFrom}::date`);
  }
  if (criteria.targetDateTo !== null) {
    where.push(Prisma.sql`p.target_date <= ${criteria.targetDateTo}::date`);
  }
  // RN-PROC-25(b): sem POL-09 na linha, o sigiloso sai de qualquer filtro de valor.
  if (criteria.estimatedValueMin !== null || criteria.estimatedValueMax !== null) {
    where.push(Prisma.sql`${canViewBudget} AND p.estimated_value IS NOT NULL`);
    if (criteria.estimatedValueMin !== null) {
      where.push(Prisma.sql`p.estimated_value >= ${criteria.estimatedValueMin}::numeric`);
    }
    if (criteria.estimatedValueMax !== null) {
      where.push(Prisma.sql`p.estimated_value <= ${criteria.estimatedValueMax}::numeric`);
    }
  }
  return where;
}

/** Colunas de ordenação (lista fechada, alias `f` do conjunto filtrado — RN-PROC-27). */
const SORT_COLUMNS: Readonly<Record<ProcessListSortField, readonly Prisma.Sql[]>> = {
  updatedAt: [Prisma.sql`f.updated_at`],
  createdAt: [Prisma.sql`f.created_at`],
  openedAt: [Prisma.sql`f.opened_at`],
  // Ano e número; sem número ao final.
  code: [Prisma.sql`CASE WHEN f.number IS NULL THEN NULL ELSE f.year END`, Prisma.sql`f.number`],
  title: [Prisma.sql`f.title`],
  // Enums na ordem declarada: LOW < MEDIUM < HIGH < URGENT; DRAFT < … < PUBLISHED.
  priority: [Prisma.sql`f.priority`],
  status: [Prisma.sql`f.status`],
  currentStageDueAt: [Prisma.sql`f.current_stage_due_at`],
  targetDate: [Prisma.sql`f.target_date`],
  // RN-PROC-25(c): mascarado ordena como nulo (sempre ao final).
  estimatedValue: [Prisma.sql`CASE WHEN f.can_view_budget THEN f.estimated_value END`],
};

const DIRECTION = { asc: Prisma.raw('ASC'), desc: Prisma.raw('DESC') } as const;

export function orderSql(order: ProcessListOrder): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (order.kind === 'RELEVANCE') {
    parts.push(
      Prisma.sql`f.rank_exact DESC`,
      Prisma.sql`f.rank_ts DESC`,
      Prisma.sql`f.rank_similarity DESC`,
    );
  } else {
    for (const term of order.terms) {
      for (const column of SORT_COLUMNS[term.field]) {
        parts.push(Prisma.sql`${column} ${DIRECTION[term.direction]} NULLS LAST`);
      }
    }
  }
  // Desempate final: paginação determinística.
  parts.push(Prisma.sql`f.id DESC`);
  return Prisma.join(parts, ', ');
}

function rankSql(search: string | null): Prisma.Sql {
  if (search === null) {
    return Prisma.sql`FALSE AS rank_exact, 0::real AS rank_ts, 0::real AS rank_similarity`;
  }
  const q = Prisma.sql`lower(cf_unaccent(${search}))`;
  return Prisma.sql`(lower(cf_unaccent(coalesce(p.code, ''))) = ${q}
          OR lower(cf_unaccent(coalesce(p.internal_code, ''))) = ${q}) AS rank_exact,
         ts_rank_cd(p.search_vector, ${tsQuery(search)}) AS rank_ts,
         GREATEST(similarity(coalesce(p.code, ''), ${search}), similarity(p.title, ${search}))
           AS rank_similarity`;
}

/** A instrução completa: conjunto filtrado (CTE), total e a página ordenada (LATERAL). */
export function buildProcessListSql(search: ProcessListSearch): Prisma.Sql {
  const canViewBudget = budgetVisibilitySql(search.budget, search.historicalDepartmentsCanView);
  const conditions = [
    buildVisibilityPredicate(search.visibility, {
      historicalDepartmentsCanView: search.historicalDepartmentsCanView,
    }),
    ...criteriaSql(search.criteria, search, canViewBudget),
  ];
  const offset = (search.page - 1) * search.pageSize;
  return Prisma.sql`
    WITH filtered AS (
      SELECT p.id, p.organization_id, p.number, p.year, p.code, p.internal_code, p.title,
             p.status, p.priority, p.requesting_secretariat_id, p.requesting_department_id,
             p.current_department_id, p.current_responsible_id, p.current_stage_id,
             p.current_workflow_stage_id, p.current_stage_due_at, p.overdue_since,
             p.contracting_type_id, p.modality_id, p.origin_id, p.is_budget_confidential,
             p.estimated_value, p.target_date, p.opened_at, p.created_at, p.updated_at,
             ${canViewBudget} AS can_view_budget,
             ${rankSql(search.criteria.search)}
        FROM processes p
       WHERE ${Prisma.join(conditions, ' AND ')}
    )
    SELECT t.total, page.*
      FROM (SELECT count(*)::int AS total FROM filtered) t
      LEFT JOIN LATERAL (
        SELECT f.id, f.organization_id, f.number, f.year, f.code, f.internal_code, f.title,
               f.status::text AS status, f.priority::text AS priority,
               f.requesting_secretariat_id, f.requesting_department_id, f.current_department_id,
               f.current_responsible_id, f.current_workflow_stage_id, f.current_stage_due_at,
               f.overdue_since, f.contracting_type_id, f.modality_id, f.origin_id,
               f.is_budget_confidential, f.can_view_budget,
               CASE WHEN f.can_view_budget THEN f.estimated_value::text END AS estimated_value,
               f.target_date, f.opened_at, f.created_at, f.updated_at,
               s.sla_type::text AS sla_type, s.paused_at AS stage_paused_at
          FROM filtered f
          LEFT JOIN process_stages s
            ON s.tenant_id = current_setting('app.tenant_id')::uuid AND s.id = f.current_stage_id
         ORDER BY ${orderSql(search.order)}
         LIMIT ${search.pageSize} OFFSET ${offset}
      ) page ON TRUE`;
}

/** Linha crua da instrução (`page.*` nulo quando a página está vazia). */
export interface ProcessListDbRow {
  readonly total: number;
  readonly id: string | null;
  readonly organization_id: string;
  readonly number: number | null;
  readonly year: number;
  readonly code: string | null;
  readonly internal_code: string | null;
  readonly title: string;
  readonly status: ProcessStatus;
  readonly priority: Priority;
  readonly requesting_secretariat_id: string;
  readonly requesting_department_id: string;
  readonly current_department_id: string;
  readonly current_responsible_id: string | null;
  readonly current_workflow_stage_id: string | null;
  readonly current_stage_due_at: Date | null;
  readonly overdue_since: Date | null;
  readonly contracting_type_id: string;
  readonly modality_id: string | null;
  readonly origin_id: string;
  readonly is_budget_confidential: boolean;
  readonly can_view_budget: boolean;
  readonly estimated_value: string | null;
  readonly target_date: Date | null;
  readonly opened_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly sla_type: DayCountType | null;
  readonly stage_paused_at: Date | null;
}

export function toProcessListRow(row: ProcessListDbRow & { readonly id: string }): ProcessListRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    number: row.number,
    year: row.year,
    code: row.code,
    internalCode: row.internal_code,
    title: row.title,
    status: row.status,
    priority: row.priority,
    requestingSecretariatId: row.requesting_secretariat_id,
    requestingDepartmentId: row.requesting_department_id,
    currentDepartmentId: row.current_department_id,
    currentResponsibleId: row.current_responsible_id,
    currentWorkflowStageId: row.current_workflow_stage_id,
    currentStageDueAt: row.current_stage_due_at,
    overdueSince: row.overdue_since,
    contractingTypeId: row.contracting_type_id,
    modalityId: row.modality_id,
    originId: row.origin_id,
    isBudgetConfidential: row.is_budget_confidential,
    canViewBudget: row.can_view_budget,
    estimatedValue: row.estimated_value,
    targetDate: row.target_date === null ? null : row.target_date.toISOString().slice(0, 10),
    openedAt: row.opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tagIds: [],
    slaType: row.sla_type,
    stagePausedAt: row.stage_paused_at,
  };
}

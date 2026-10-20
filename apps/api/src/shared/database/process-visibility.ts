import { Prisma } from './prisma.js';
import type { ProcessVisibilityScope } from '../auth/process-access.js';

/*
 * Predicado SQL de visibilidade de processos (DEC-024 · permissions.md §5 · RN-IAM-103): a ÚNICA
 * implementação usada por toda listagem/consulta de processos e recursos filhos — os repositórios
 * o compõem no `WHERE` com o alias da tabela `processes`. O escopo vem do
 * `AccessFacade.processVisibilityScope()` (escopos de `PROCESS_VIEW` já expandidos); a checagem em
 * memória equivalente é `isProcessVisible` (`#shared/auth/process-access.js`).
 */

export interface VisibilityPredicateOptions {
  /** Alias SQL da tabela `processes` na consulta (padrão `p`). */
  readonly processAlias?: string;
  /**
   * `access.historicalDepartmentsCanView` do tenant (padrão `true`): unidades por onde o processo
   * já passou (`HISTORICAL`) continuam vendo-o.
   */
  readonly historicalDepartmentsCanView?: boolean;
}

const ALIAS = /^[a-z_][a-z0-9_]{0,30}$/;

/**
 * `p.tenant_id = app.tenant_id AND p.deleted_at IS NULL AND (escopo amplo OR órgão OR concessão de
 * unidade OR concessão própria)`, com todos os valores como parâmetros (nunca interpolados).
 */
export function buildVisibilityPredicate(
  scope: ProcessVisibilityScope,
  options: VisibilityPredicateOptions = {},
): Prisma.Sql {
  const alias = options.processAlias ?? 'p';
  if (!ALIAS.test(alias)) throw new Error(`Alias SQL inválido: ${alias}`);
  const p = Prisma.raw(alias);
  // `PARTICIPANT`: unidade participante (US-012) — só visibilidade.
  const reasons =
    options.historicalDepartmentsCanView === false
      ? ['REQUESTING', 'CURRENT', 'PARTICIPANT']
      : ['REQUESTING', 'CURRENT', 'HISTORICAL', 'PARTICIPANT'];
  return Prisma.sql`${p}.tenant_id = current_setting('app.tenant_id')::uuid
  AND ${p}.deleted_at IS NULL
  AND (
        ${scope.tenantWide}
     OR ${p}.organization_id = ANY(${[...scope.organizationIds]}::uuid[])
     OR EXISTS (SELECT 1 FROM process_access pa
                 WHERE pa.tenant_id = ${p}.tenant_id AND pa.process_id = ${p}.id
                   AND pa.revoked_at IS NULL
                   AND (   (pa.principal_type = 'DEPARTMENT'
                            AND pa.department_id = ANY(${[...scope.departmentIds]}::uuid[])
                            AND pa.reason::text = ANY(${reasons}::text[]))
                        OR (pa.principal_type = 'USER' AND pa.user_id = ${scope.userId}::uuid
                            -- RN-PROC-135: consultor vencido perde a visibilidade antes do job.
                            AND NOT (pa.reason = 'PARTICIPANT' AND EXISTS (
                                  SELECT 1 FROM process_participants pp
                                   WHERE pp.tenant_id = pa.tenant_id AND pp.id = pa.source_id
                                     AND pp.expires_at IS NOT NULL
                                     AND pp.expires_at <= now())))))
  )`;
}

/**
 * Quem desmascara o valor estimado sigiloso por linha (POL-09 · RN-PROC-25): escopos de
 * `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (vazios sem o MFA exigido) e a custódia atual.
 */
export interface ConfidentialBudgetScope extends ProcessVisibilityScope {
  /** Lotações ativas do vínculo: custódia do processo na fila da unidade (sem responsável). */
  readonly custodyDepartmentIds: readonly string[];
}

export interface ConfidentialBudgetPredicateOptions extends VisibilityPredicateOptions {
  /**
   * Avalia como se o processo fosse sigiloso (sem o atalho `NOT is_budget_confidential`) — a regra
   * das entradas `BUDGET_RESTRICTED` da timeline (RN-TML-13), para o orçamento tornado público não
   * revelar o passado.
   */
  readonly assumeConfidential?: boolean;
}

/**
 * POL-09 por linha (RN-PROC-25 · US-002, reaproveitado no dashboard — US-076): o valor do processo
 * sigiloso é visível com `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo-o (tenant, órgão ou unidade
 * com `ProcessAccess` solicitante/atual/histórica) ou com a custódia atual (responsável, ou fila de
 * uma lotação do vínculo). Todos os valores como parâmetros.
 */
export function buildConfidentialBudgetPredicate(
  budget: ConfidentialBudgetScope,
  options: ConfidentialBudgetPredicateOptions = {},
): Prisma.Sql {
  const alias = options.processAlias ?? 'p';
  if (!ALIAS.test(alias)) throw new Error(`Alias SQL inválido: ${alias}`);
  const p = Prisma.raw(alias);
  const reasons =
    options.historicalDepartmentsCanView === false
      ? ['REQUESTING', 'CURRENT']
      : ['REQUESTING', 'CURRENT', 'HISTORICAL'];
  const notConfidential =
    options.assumeConfidential === true
      ? Prisma.sql`FALSE`
      : Prisma.sql`NOT ${p}.is_budget_confidential`;
  return Prisma.sql`(
        ${notConfidential}
     OR ${budget.tenantWide}
     OR ${p}.organization_id = ANY(${[...budget.organizationIds]}::uuid[])
     OR ${p}.current_responsible_id = ${budget.userId}::uuid
     OR (${p}.current_responsible_id IS NULL
         AND ${p}.current_department_id = ANY(${[...budget.custodyDepartmentIds]}::uuid[]))
     OR EXISTS (SELECT 1 FROM process_access ba
                 WHERE ba.tenant_id = ${p}.tenant_id AND ba.process_id = ${p}.id
                   AND ba.revoked_at IS NULL AND ba.principal_type = 'DEPARTMENT'
                   AND ba.department_id = ANY(${[...budget.departmentIds]}::uuid[])
                   AND ba.reason::text = ANY(${reasons}::text[])))`;
}

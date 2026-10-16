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
  const reasons =
    options.historicalDepartmentsCanView === false
      ? ['REQUESTING', 'CURRENT']
      : ['REQUESTING', 'CURRENT', 'HISTORICAL'];
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
                        OR (pa.principal_type = 'USER' AND pa.user_id = ${scope.userId}::uuid)))
  )`;
}

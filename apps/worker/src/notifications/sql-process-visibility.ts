import type { SqlClient } from '#shared/database/outbox-database.js';

import type { ProcessVisibility } from './recipient-resolver.js';

const HISTORICAL_KEY = 'access.historicalDepartmentsCanView';

/**
 * Visibilidade do processo para os destinatários (DEC-024 · permissions.md §5 · RN-NTF-06), no
 * PostgreSQL com o papel `cf_worker` e na `tenantTransaction` do job (RLS do tenant do evento). É o
 * mesmo predicado da API (`buildVisibilityPredicate`/`isProcessVisible`) avaliado para TERCEIROS:
 *
 * - concessão própria (`process_access` USER ativo; consultor vencido não conta — RN-PROC-135); ou
 * - atribuição de perfil vigente (perfil ativo, `PROCESS_VIEW`) com escopo `TENANT`, o órgão do
 *   processo, ou unidade (`DEPARTMENT`/`OWN_DEPARTMENTS`, com subárvore pelo `path`) que tenha
 *   `process_access` de unidade ativo — `REQUESTING`/`CURRENT`/`PARTICIPANT` e `HISTORICAL` se
 *   `access.historicalDepartmentsCanView` (padrão `true`).
 *
 * Só vínculos `ACTIVE` não vencidos. Sem atribuição gravada não há visibilidade por perfil (a ponte
 * por chave do registro do vínculo é só do modo fake da API): falha fechada.
 */
export class SqlProcessVisibility implements ProcessVisibility {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async visibleTo(
    client: SqlClient,
    processId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const { rows } = await client.query<{ user_id: string }>(
      `WITH process AS (
         SELECT p.id, p.organization_id FROM processes p WHERE p.id = $1 AND p.deleted_at IS NULL
       ),
       historical AS (
         SELECT coalesce(
                  (SELECT CASE WHEN jsonb_typeof(value) = 'boolean' THEN (value)::text::boolean END
                     FROM tenant_settings WHERE key = $4),
                  true) AS can_view
       ),
       unit_access AS (
         SELECT d.id, d.path
           FROM process_access pa
           JOIN departments d ON d.tenant_id = pa.tenant_id AND d.id = pa.department_id
           CROSS JOIN historical h
          WHERE pa.process_id = $1
            AND pa.revoked_at IS NULL
            AND pa.principal_type = 'DEPARTMENT'
            AND (pa.reason::text IN ('REQUESTING', 'CURRENT', 'PARTICIPANT')
                 OR (pa.reason::text = 'HISTORICAL' AND h.can_view))
       ),
       candidates AS (
         SELECT m.id AS membership_id, m.user_id
           FROM tenant_memberships m
          WHERE m.user_id = ANY($2::uuid[])
            AND m.status = 'ACTIVE'
            AND (m.expires_at IS NULL OR m.expires_at > $3)
       )
       SELECT c.user_id
         FROM candidates c
         CROSS JOIN process p
        WHERE EXISTS (
                SELECT 1 FROM process_access pa
                 WHERE pa.process_id = p.id
                   AND pa.revoked_at IS NULL
                   AND pa.principal_type = 'USER'
                   AND pa.user_id = c.user_id
                   AND NOT (pa.reason = 'PARTICIPANT' AND EXISTS (
                         SELECT 1 FROM process_participants pp
                          WHERE pp.tenant_id = pa.tenant_id AND pp.id = pa.source_id
                            AND pp.expires_at IS NOT NULL AND pp.expires_at <= $3)))
           OR EXISTS (
                SELECT 1
                  FROM role_assignments ra
                  JOIN roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id AND r.is_active
                  JOIN role_permissions rp
                    ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                   AND rp.permission_code = 'PROCESS_VIEW'
                 WHERE ra.membership_id = c.membership_id
                   AND ra.revoked_at IS NULL
                   AND ra.valid_from <= $3
                   AND (ra.valid_until IS NULL OR ra.valid_until > $3)
                   AND (   ra.scope_type = 'TENANT'
                        OR (ra.scope_type = 'ORGANIZATION'
                            AND ra.scope_organization_id = p.organization_id)
                        OR (ra.scope_type = 'DEPARTMENT' AND EXISTS (
                              SELECT 1 FROM departments root
                                JOIN unit_access ua
                                  ON ua.id = root.id
                                  OR (ra.include_subtree AND ua.path LIKE root.path || '%')
                               WHERE root.id = ra.scope_department_id))
                        OR (ra.scope_type = 'OWN_DEPARTMENTS' AND EXISTS (
                              SELECT 1 FROM membership_departments md
                                JOIN departments own ON own.tenant_id = md.tenant_id
                                 AND own.id = md.department_id
                                JOIN unit_access ua
                                  ON ua.id = own.id
                                  OR (ra.include_subtree AND ua.path LIKE own.path || '%')
                               WHERE md.membership_id = c.membership_id))))`,
      [processId, [...userIds], this.now(), HISTORICAL_KEY],
    );
    return new Set(rows.map((row) => row.user_id));
  }
}

import { NOTIFICATION_MAX_UNIT_RECIPIENTS } from '@contrataflow/types';
import type { DomainEventEnvelope } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RecipientLookupSource } from './recipient-resolver.js';

type Payload = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Perfis a avisar: os das linhas `ROLE` `PENDING` do `ApprovalRequested` (US-133 · RN-APV-27); sem
 * a lista, o perfil único do MVP 1 (`approverRoleId`) ou o novo do redirecionamento.
 */
function rolesOf(payload: Payload): string[] {
  if (Array.isArray(payload.approvers)) {
    const roles = payload.approvers
      .filter(
        (line): line is Payload =>
          typeof line === 'object' &&
          line !== null &&
          (line as Payload).approverType === 'ROLE' &&
          (line as Payload).status === 'PENDING',
      )
      .map((line) => text(line.approverRoleId))
      .filter((roleId): roleId is string => roleId !== null);
    return [...new Set(roles)];
  }
  const single = text(payload.approverRoleId) ?? text(payload.toApproverRoleId);
  return single === null ? [] : [single];
}

/**
 * Detentores do perfil aprovador (`ROLE_HOLDERS` — US-051 · DEC-022 · RN-TRAM-47), destinatários de
 * `APPROVAL_REQUESTED` (e de `APPROVAL_REASSIGNED` para um perfil): quem tem atribuição VIGENTE do
 * perfil ATIVO, com vínculo `ACTIVE` não vencido, cujo escopo cubra a unidade solicitante do
 * processo — `TENANT`, `ORGANIZATION` do processo, ou `DEPARTMENT`/`OWN_DEPARTMENTS` (subárvore pelo
 * `path`) contendo a secretaria ou o setor solicitante. As concessões `CURRENT`/`HISTORICAL` não
 * contam — é a mesma competência da API (`ApprovalCompetenceService`). Acima de 50 detentores, a
 * unidade atual do processo é avisada pelo titular e pelo substituto (events.md §6). Na
 * `tenantTransaction` do job: a RLS limita tudo ao tenant do evento.
 */
export class RoleHoldersLookup implements RecipientLookupSource {
  readonly lookup = 'ROLE_HOLDERS' as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async resolve(
    client: SqlClient,
    event: DomainEventEnvelope<Payload>,
  ): Promise<readonly string[]> {
    const roleIds = rolesOf(event.payload);
    if (roleIds.length === 0 || event.processId === null) return [];
    const { rows } = await client.query<{ user_id: string }>(
      `WITH target AS (
         SELECT p.tenant_id, p.organization_id,
                ARRAY[p.requesting_secretariat_id, p.requesting_department_id]::uuid[] AS units
           FROM processes p
          WHERE p.id = $1 AND p.deleted_at IS NULL
       )
       SELECT DISTINCT m.user_id
         FROM target t
         JOIN role_assignments ra ON ra.tenant_id = t.tenant_id AND ra.role_id = ANY($2::uuid[])
         JOIN roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id AND r.is_active
         JOIN tenant_memberships m ON m.tenant_id = ra.tenant_id AND m.id = ra.membership_id
         JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
        WHERE ra.revoked_at IS NULL
          AND ra.valid_from <= $3
          AND (ra.valid_until IS NULL OR ra.valid_until > $3)
          AND m.status = 'ACTIVE'
          AND (m.expires_at IS NULL OR m.expires_at > $3)
          AND (   ra.scope_type = 'TENANT'
               OR (ra.scope_type = 'ORGANIZATION' AND ra.scope_organization_id = t.organization_id)
               OR (ra.scope_type = 'DEPARTMENT' AND EXISTS (
                     SELECT 1 FROM departments root
                       JOIN departments unit ON unit.tenant_id = root.tenant_id
                      WHERE root.id = ra.scope_department_id
                        AND unit.id = ANY(t.units)
                        AND (unit.id = root.id
                             OR (ra.include_subtree AND unit.path LIKE root.path || '%'))))
               OR (ra.scope_type = 'OWN_DEPARTMENTS' AND EXISTS (
                     SELECT 1 FROM membership_departments md
                       JOIN departments root
                         ON root.tenant_id = md.tenant_id AND root.id = md.department_id
                       JOIN departments unit ON unit.tenant_id = root.tenant_id
                      WHERE md.membership_id = m.id
                        AND unit.id = ANY(t.units)
                        AND (unit.id = root.id
                             OR (ra.include_subtree AND unit.path LIKE root.path || '%')))))
        ORDER BY m.user_id
        LIMIT $4`,
      [event.processId, roleIds, this.now(), NOTIFICATION_MAX_UNIT_RECIPIENTS + 1],
    );
    if (rows.length <= NOTIFICATION_MAX_UNIT_RECIPIENTS) return rows.map((row) => row.user_id);
    const heads = await client.query<{
      head_user_id: string | null;
      deputy_user_id: string | null;
    }>(
      `SELECT d.head_user_id, d.deputy_user_id
         FROM processes p
         JOIN departments d ON d.tenant_id = p.tenant_id AND d.id = p.current_department_id
        WHERE p.id = $1 AND d.is_active`,
      [event.processId],
    );
    const unit = heads.rows[0];
    return [unit?.head_user_id ?? null, unit?.deputy_user_id ?? null].filter(
      (userId): userId is string => userId !== null,
    );
  }
}

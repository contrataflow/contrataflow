import type { PermissionCode } from '@contrataflow/types';
import { SETTING_DEFINITIONS } from '@contrataflow/validation';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { NotificationDirectory } from './recipient-resolver.js';

const EMAIL_ENABLED_KEY = 'notifications.emailEnabled';

/** Padrão do registro de configurações (US-103) quando o tenant não gravou a chave. */
const EMAIL_ENABLED_DEFAULT =
  SETTING_DEFINITIONS.find((definition) => definition.key === EMAIL_ENABLED_KEY)?.defaultValue !==
  false;

/**
 * Leituras do dispatcher no PostgreSQL com o papel `cf_worker` (GRANTs de SELECT em
 * `tenant_memberships`, `membership_departments`, `departments`, `users` e `tenant_settings`),
 * sempre na `tenantTransaction` do job — a RLS restringe tudo ao tenant do evento.
 */
export class SqlNotificationDirectory implements NotificationDirectory {
  async activeMembers(
    client: SqlClient,
    userIds: readonly string[],
    now: Date,
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT m.user_id
         FROM tenant_memberships m
         JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
        WHERE m.user_id = ANY($1::uuid[])
          AND m.status = 'ACTIVE'
          AND (m.expires_at IS NULL OR m.expires_at > $2)`,
      [userIds, now],
    );
    return new Set(rows.map((row) => row.user_id));
  }

  async departmentMembers(
    client: SqlClient,
    departmentId: string,
    limit: number,
    now: Date,
  ): Promise<string[]> {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM membership_departments md
         JOIN tenant_memberships m ON m.tenant_id = md.tenant_id AND m.id = md.membership_id
        WHERE md.department_id = $1
          AND m.status = 'ACTIVE'
          AND (m.expires_at IS NULL OR m.expires_at > $2)
        ORDER BY m.user_id
        LIMIT $3`,
      [departmentId, now, limit],
    );
    return rows.map((row) => row.user_id);
  }

  async departmentHeads(
    client: SqlClient,
    departmentId: string,
  ): Promise<{ headUserId: string | null; deputyUserId: string | null } | null> {
    const { rows } = await client.query<{
      head_user_id: string | null;
      deputy_user_id: string | null;
    }>('SELECT head_user_id, deputy_user_id FROM departments WHERE id = $1 AND is_active', [
      departmentId,
    ]);
    const row = rows[0];
    return row ? { headUserId: row.head_user_id, deputyUserId: row.deputy_user_id } : null;
  }

  async tenantPermissionHolders(
    client: SqlClient,
    permission: PermissionCode,
    limit: number,
    now: Date,
  ): Promise<string[]> {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM role_assignments ra
         JOIN roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id AND r.is_active
         JOIN role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
         JOIN tenant_memberships m ON m.tenant_id = ra.tenant_id AND m.id = ra.membership_id
         JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
        WHERE rp.permission_code = $1
          AND ra.revoked_at IS NULL
          AND ra.valid_from <= $2
          AND (ra.valid_until IS NULL OR ra.valid_until > $2)
          AND m.status = 'ACTIVE'
          AND (m.expires_at IS NULL OR m.expires_at > $2)
        ORDER BY m.user_id
        LIMIT $3`,
      [permission, now, limit],
    );
    return rows.map((row) => row.user_id);
  }

  async membershipUser(client: SqlClient, membershipId: string): Promise<string | null> {
    const { rows } = await client.query<{ user_id: string }>(
      'SELECT user_id FROM tenant_memberships WHERE id = $1',
      [membershipId],
    );
    return rows[0]?.user_id ?? null;
  }

  async tenantEmailEnabled(client: SqlClient): Promise<boolean> {
    const { rows } = await client.query<{ value: unknown }>(
      'SELECT value FROM tenant_settings WHERE key = $1',
      [EMAIL_ENABLED_KEY],
    );
    const value = rows[0]?.value;
    return typeof value === 'boolean' ? value : EMAIL_ENABLED_DEFAULT;
  }
}

import 'server-only';

import type { ShellSession } from '@/lib/session/types';

import type { SessionRecord } from './types';

/** Projeção pública do registro de sessão (sem tokens nem chave). */
export function toShellSession(record: SessionRecord): ShellSession {
  const active = record.memberships.find(
    (membership) => membership.tenant.id === record.activeTenantId,
  );
  return {
    user: { id: record.userId, displayName: record.displayName },
    activeTenant: active ? { ...active.tenant } : null,
    memberships: record.memberships.map((membership) => ({
      membershipId: membership.membershipId,
      tenant: {
        id: membership.tenant.id,
        name: membership.tenant.name,
        status: membership.tenant.status,
      },
      type: membership.type,
      expiresAt: membership.expiresAt,
      usable: membership.usable,
    })),
    idleMinutes: record.idleMinutes,
    idleExpiresAt: new Date(record.idleExpiresAt).toISOString(),
    absoluteExpiresAt: new Date(record.absoluteExpiresAt).toISOString(),
    // Instituição em encerramento: faixa "somente leitura e exportação" (FA-08).
    readOnly: active?.readOnly === true || active?.tenant.status === 'OFFBOARDING',
  };
}

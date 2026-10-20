import { membershipAccess } from '#shared/auth/membership-policy.js';
import type { MembershipAccess } from '#shared/auth/membership-policy.js';
import type { MembershipStatus, TenantStatus } from '#shared/auth/ports.js';

export type MembershipType = 'INTERNAL' | 'EXTERNAL' | 'SERVICE';

/**
 * `TenantMembership` com o resumo da instituição, como lido pela função `cf_user_memberships`
 * (entities.md §4.2 · US-087): a visão de vínculos do próprio usuário em todos os tenants.
 */
export interface TenantMembership {
  readonly id: string;
  readonly tenant: {
    readonly id: string;
    readonly name: string;
    readonly status: TenantStatus;
    readonly timezone: string;
  };
  readonly type: MembershipType;
  readonly status: MembershipStatus;
  readonly expiresAt: Date | null;
  /** Perfis vigentes (`Role.key`); vazio até as atribuições de perfil existirem (US-096). */
  readonly roleKeys: readonly string[];
}

/** RN-IAM-08: utilizável (e se em modo somente leitura) neste instante. */
export function isUsable(membership: TenantMembership, now: Date): MembershipAccess {
  return membershipAccess(
    {
      status: membership.status,
      expiresAt: membership.expiresAt,
      tenantStatus: membership.tenant.status,
      roleKeys: membership.roleKeys,
    },
    now,
  );
}

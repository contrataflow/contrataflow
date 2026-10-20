import type { MembershipStatus, TenantStatus } from './ports.js';

/**
 * Política de acesso de um vínculo (DEC-132 · RN-IAM-08), compartilhada pelo pipeline de guards e
 * pelo módulo `identity` (lista de vínculos, início de sessão): função pura, sem I/O.
 */

/** Perfis que mantêm leitura e exportação numa instituição em encerramento (`OFFBOARDING`). */
export const OFFBOARDING_READER_ROLES: readonly string[] = ['ADMIN_ORGAO', 'AUDITOR'];

export interface MembershipAccessInput {
  readonly status: MembershipStatus;
  readonly expiresAt: Date | null;
  /** Status da instituição; `null` se ela não existir. */
  readonly tenantStatus: TenantStatus | null;
  readonly roleKeys: readonly string[];
}

export type MembershipAccess =
  | { readonly usable: true; readonly readOnly: boolean }
  | { readonly usable: false; readonly reason: 'MEMBERSHIP_INACTIVE' | 'TENANT_SUSPENDED' };

export function canReadOffboardingTenant(roleKeys: readonly string[]): boolean {
  return roleKeys.some((role) => OFFBOARDING_READER_ROLES.includes(role));
}

/**
 * Vínculo utilizável: `ACTIVE`, sem `expiresAt` vencido e instituição `ACTIVE` — ou `OFFBOARDING`
 * para quem tem `ADMIN_ORGAO`/`AUDITOR`, em modo somente leitura. `PROVISIONING`, `SUSPENDED` e
 * `DEACTIVATED` nunca são utilizáveis por usuários.
 */
export function membershipAccess(input: MembershipAccessInput, now: Date): MembershipAccess {
  if (input.status !== 'ACTIVE') return { usable: false, reason: 'MEMBERSHIP_INACTIVE' };
  if (input.expiresAt !== null && input.expiresAt.getTime() <= now.getTime()) {
    return { usable: false, reason: 'MEMBERSHIP_INACTIVE' };
  }
  if (input.tenantStatus === 'ACTIVE') return { usable: true, readOnly: false };
  if (input.tenantStatus === 'OFFBOARDING' && canReadOffboardingTenant(input.roleKeys)) {
    return { usable: true, readOnly: true };
  }
  return { usable: false, reason: 'TENANT_SUSPENDED' };
}

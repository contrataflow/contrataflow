/**
 * Portas do pipeline de autenticação/tenant (architecture.md §3.3 — declaradas no shared kernel,
 * implementadas pelos módulos donos). Nesta fase os adaptadores são em memória (`identity`,
 * `tenancy`); a US-081 troca por Prisma e a US-087 pelo verificador JWKS real sem mudar os guards.
 */

/** Token de acesso verificado (assinatura, `iss`, `aud`, `exp`, `nbf` — DEC-132). */
export interface VerifiedToken {
  /** `sub` do IdP = `User.externalSubject`. */
  readonly subject: string;
  readonly amr: readonly string[];
  readonly authTime: Date | null;
}

export type TokenRejection = 'EXPIRED' | 'INVALID';

/** Token recusado: `EXPIRED` → 401 `SESSION_EXPIRED`; demais → 401 `UNAUTHENTICATED`. */
export class TokenVerificationError extends Error {
  constructor(readonly reason: TokenRejection) {
    super(`Token recusado (${reason}).`);
    this.name = 'TokenVerificationError';
  }
}

export interface TokenVerifierPort {
  /** @throws TokenVerificationError */
  verify(token: string): Promise<VerifiedToken>;
}

export type UserStatus = 'ACTIVE' | 'BLOCKED' | 'DEACTIVATED';

export interface AuthenticatedUser {
  readonly id: string;
  readonly status: UserStatus;
}

export interface UserPort {
  findByExternalSubject(subject: string): Promise<AuthenticatedUser | null>;
}

export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';

export interface MembershipRecord {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly status: MembershipStatus;
  /** Fim do vínculo (`TenantMembership.expiresAt`); `null` = sem prazo. */
  readonly expiresAt: Date | null;
}

export interface MembershipPort {
  /** Vínculo do usuário no tenant, em qualquer status; `null` se não existir. */
  findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null>;
}

export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDING' | 'DEACTIVATED';

export interface TenantStatusPort {
  /** Status do tenant; `null` se não existir. */
  findStatus(tenantId: string): Promise<TenantStatus | null>;
}

export const TOKEN_VERIFIER = Symbol('TokenVerifierPort');
export const USER_PORT = Symbol('UserPort');
export const MEMBERSHIP_PORT = Symbol('MembershipPort');
export const TENANT_STATUS_PORT = Symbol('TenantStatusPort');

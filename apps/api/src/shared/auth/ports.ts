/**
 * Portas do pipeline de autenticação/tenant (architecture.md §3.3 — declaradas no shared kernel,
 * implementadas pelos módulos donos). Adaptadores reais (US-087): verificador JWKS do Authentik e
 * repositórios Prisma em `identity`/`tenancy`; os em memória ficam para testes e para o modo de
 * identidade fake (local/dev/test).
 */

/** Token de acesso verificado (assinatura, `iss`, `aud`, `exp`, `nbf` — DEC-132). */
export interface VerifiedToken {
  /** `sub` do IdP = `User.externalSubject`. */
  readonly subject: string;
  readonly amr: readonly string[];
  readonly authTime: Date | null;
  /** Claims de perfil do token (vínculo do `sub` por e-mail verificado — RN-IAM-06). */
  readonly email: string | null;
  readonly emailVerified: boolean;
}

export type TokenRejection = 'EXPIRED' | 'INVALID';

/** Token recusado: `EXPIRED` → 401 `SESSION_EXPIRED`; demais → 401 `UNAUTHENTICATED`. */
export class TokenVerificationError extends Error {
  constructor(readonly reason: TokenRejection) {
    super(`Token recusado (${reason}).`);
    this.name = 'TokenVerificationError';
  }
}

/**
 * Não foi possível verificar o token agora: chave (`kid`) desconhecida com o JWKS do IdP fora do
 * ar (RN-IAM-05) → 503 `DEPENDENCY_UNAVAILABLE`, nunca 401.
 */
export class TokenVerifierUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Chaves do provedor de identidade indisponíveis.', options);
    this.name = 'TokenVerifierUnavailableError';
  }
}

export interface TokenVerifierPort {
  /** @throws TokenVerificationError · TokenVerifierUnavailableError */
  verify(token: string): Promise<VerifiedToken>;
}

export type UserStatus = 'ACTIVE' | 'BLOCKED' | 'DEACTIVATED';

export interface AuthenticatedUser {
  readonly id: string;
  readonly status: UserStatus;
  /** Nome exibido (nome social, se houver), congelado em `AuditLog.actorName` (US-073). */
  readonly displayName: string;
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
  /**
   * Perfis vigentes do vínculo (`Role.key`) — decidem o acesso de leitura a instituição em
   * `OFFBOARDING` (DEC-132). Derivados das atribuições não revogadas, dentro da validade e de perfil
   * ativo (permissions.md §2 · spec-531); não editáveis.
   */
  readonly roleKeys: readonly string[];
}

export interface MembershipPort {
  /** Vínculo do usuário no tenant, em qualquer status; `null` se não existir. */
  findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null>;
  /**
   * `TenantMembership.lastAccessAt`, no máximo 1×/5 min por vínculo (RN-IAM-16). Chamado pelo
   * guard sem aguardar: falha aqui nunca afeta a requisição.
   */
  recordAccess?(membership: MembershipRecord, at: Date): Promise<void>;
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

/** Operador da plataforma (`User.isPlatformOperator` — permissions.md §8 · DEC-139). */
export interface PlatformOperator {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly isPlatformOperator: boolean;
}

export interface PlatformOperatorPort {
  /** Usuário autenticado (rotas `/platform/*`). */
  findOperatorById(userId: string): Promise<PlatformOperator | null>;
  /** `--operator <e-mail>` da CLI de operação (US-099). */
  findOperatorByEmail(email: string): Promise<PlatformOperator | null>;
}

export const PLATFORM_OPERATOR_PORT = Symbol('PlatformOperatorPort');

import type { TenantSelection } from '@contrataflow/validation';

import type { TenantMembership } from '../domain/tenant-membership.js';
import type { User } from '../domain/user.js';

/*
 * Portas da aplicação do módulo `identity` (US-087): implementadas em `infrastructure/` (Prisma,
 * API do Authentik, log de auditoria) e em memória nos testes.
 */

export type LoginRecord =
  /** `bound`: o `sub` foi vinculado nesta chamada (primeiro login). */
  | { readonly kind: 'recorded'; readonly bound: boolean }
  /** O `sub` já pertence a outro usuário, ou o usuário já tem outro `sub`. */
  | { readonly kind: 'subject_conflict' };

export interface IdentityRepository {
  findUserById(userId: string): Promise<User | null>;
  findUserBySubject(subject: string): Promise<User | null>;
  /** Usuário ainda sem `sub` com o `authentikUserId` informado (convite/provisionamento). */
  findUnboundUserByAuthentikId(authentikUserId: string): Promise<User | null>;
  /** Usuário ainda sem `sub` e sem `authentikUserId` com o e-mail informado. */
  findUnboundUserByEmail(email: string): Promise<User | null>;
  /**
   * Numa transação sobre `users`: vincula o `sub` (se `bindSubject`, só onde ainda é nulo —
   * concorrência resolvida pelo banco) e atualiza `lastLoginAt` (RN-IAM-06/16).
   */
  recordLogin(userId: string, at: Date, bindSubject: string | null): Promise<LoginRecord>;
  /** Vínculos do usuário em todos os tenants (`cf_user_memberships`), com os perfis vigentes. */
  listMemberships(userId: string): Promise<TenantMembership[]>;
  /** `TenantMembership.lastAccessAt`, no máximo 1×/5 min por vínculo (RN-IAM-16). */
  touchMembershipAccess(tenantId: string, membershipId: string, at: Date): Promise<void>;
}

export const IDENTITY_REPOSITORY = Symbol('IdentityRepository');

/** API administrativa do Authentik (`AuthentikAdminClient`). */
export interface AuthentikDirectoryPort {
  /** PK do usuário do Authentik cujo UUID é o `sub`; `null` se não houver (ou sem integração). */
  findUserPkBySubject(subject: string): Promise<string | null>;
}

export const AUTHENTIK_DIRECTORY = Symbol('AuthentikDirectoryPort');

export interface SessionAuditBase {
  readonly tenantId: string;
  readonly userId: string;
  readonly membershipId: string;
  /** SHA-256 do id da sessão do BFF (`AuditLog.sessionIdHash`). */
  readonly sessionIdHash: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** Trilha `auth.*` na instituição ativa, gravada pelo `AuditService` (US-073). */
export interface SessionAuditPort {
  sessionStarted(
    entry: SessionAuditBase & {
      readonly selection: TenantSelection;
      readonly firstLogin: boolean;
      readonly amr: readonly string[];
    },
  ): Promise<void>;
  tenantSwitched(entry: SessionAuditBase & { readonly fromTenantId: string | null }): Promise<void>;
}

export const SESSION_AUDIT = Symbol('SessionAuditPort');

/** Relógio injetável (testes de expiração de vínculo). */
export type Clock = () => Date;

export const IDENTITY_CLOCK = Symbol('IdentityClock');

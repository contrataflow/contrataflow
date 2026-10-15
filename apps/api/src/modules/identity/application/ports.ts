import type { SessionTombstone, TenantSelection } from '@contrataflow/validation';

import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import type { TenantTx } from '#shared/database/prisma.js';

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
  /**
   * "Usar como padrão" (FA-04 da US-093): grava só a chave `defaultTenantId` de
   * `User.preferences` (jsonb livre, sem migração), preservando as demais preferências.
   */
  setDefaultTenant(userId: string, tenantId: string): Promise<void>;
  /**
   * Nomes exibidos dos usuários com vínculo no tenant da transação (a RLS de
   * `tenant_memberships` filtra — usuário de outro tenant não é encontrado), lidos no `tx` do caso
   * de uso: os nomes congelados da timeline (US-059).
   */
  displayNamesInTenant(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, string>>;
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

/**
 * Trilha `auth.*` na instituição ativa, gravada pelo `AuditService` (US-073). Início e troca de
 * instituição vêm do BFF em tempo real (US-087); o encerramento vem da varredura de sessões
 * (US-088), depois do fato.
 */
export interface SessionAuditPort {
  sessionStarted(
    entry: SessionAuditBase & {
      readonly selection: TenantSelection;
      readonly firstLogin: boolean;
      readonly amr: readonly string[];
    },
  ): Promise<void>;
  tenantSwitched(
    entry: SessionAuditBase & {
      readonly fromTenantId: string | null;
      readonly selection: TenantSelection;
    },
  ): Promise<void>;
  /**
   * `auth.session_end` (logout, limite de sessões, vínculo encerrado) ou `auth.session_expired`
   * (ociosidade, fim absoluto, renovação recusada) na instituição da sessão, com o horário real do
   * fato (`occurredAt` do registro de encerramento — RN-IAM-24/28). Idempotente por sessão:
   * `'duplicate'` = nada novo a gravar (já gravado antes, ou sem como atribuir o vínculo); em
   * ambos os casos o registro de encerramento pode ser apagado. Falha de gravação propaga — o
   * registro de encerramento fica no Redis para a próxima varredura.
   */
  sessionEnded(tombstone: SessionTombstone): Promise<'recorded' | 'duplicate'>;
}

export const SESSION_AUDIT = Symbol('SessionAuditPort');

/**
 * `security.mfaPolicy` da instituição (DEC-133 · POL-14). A instituição de destino decide se a
 * troca exige segundo fator (RN-IAM-69 · US-093) — nunca a de origem.
 */
export interface TenantMfaPolicyPort {
  mfaPolicyOf(tenantId: string): Promise<MfaPolicy>;
}

export const TENANT_MFA_POLICY = Symbol('TenantMfaPolicyPort');

/** Relógio injetável (testes de expiração de vínculo). */
export type Clock = () => Date;

export const IDENTITY_CLOCK = Symbol('IdentityClock');

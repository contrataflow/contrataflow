import type { SessionTombstone, TenantSelection } from '@contrataflow/validation';

import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import type { MembershipStatus } from '#shared/auth/ports.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TenantMembership } from '../domain/tenant-membership.js';
import type { ProfileUpdate, User } from '../domain/user.js';

/*
 * Portas da aplicação do módulo `identity` (US-087): implementadas em `infrastructure/` (Prisma,
 * API do Authentik, log de auditoria) e em memória nos testes.
 */

export type LoginRecord =
  /** `bound`: o `sub` foi vinculado nesta chamada (primeiro login). */
  | { readonly kind: 'recorded'; readonly bound: boolean }
  /** O `sub` já pertence a outro usuário, ou o usuário já tem outro `sub`. */
  | { readonly kind: 'subject_conflict' };

/** Vínculo de um usuário no tenant da transação (qualquer situação), para validar designações. */
export interface TenantMember {
  readonly userId: string;
  readonly membershipId: string;
  readonly status: MembershipStatus;
  readonly expiresAt: Date | null;
  /** Perfis vigentes (`Role.key`); vazio até as atribuições de perfil existirem (US-096). */
  readonly roleKeys: readonly string[];
}

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
  /** Usuário lido no `tx` do caso de uso (ME-02: leitura e gravação na mesma transação). */
  findUserInTransaction(tx: TenantTx, userId: string): Promise<User | null>;
  /**
   * ME-02: grava o perfil só se `version` ainda for `expectedVersion` e a incrementa
   * (`UPDATE … WHERE version = @expected` — DEC-055); `false` = outra aba gravou antes.
   */
  saveProfile(
    tx: TenantTx,
    userId: string,
    expectedVersion: number,
    update: Omit<ProfileUpdate, 'changes'>,
  ): Promise<boolean>;
  /**
   * Nomes exibidos dos usuários com vínculo no tenant da transação (a RLS de
   * `tenant_memberships` filtra — usuário de outro tenant não é encontrado), lidos no `tx` do caso
   * de uso: os nomes congelados da timeline (US-059).
   */
  displayNamesInTenant(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * Vínculos dos usuários no tenant da transação (a RLS de `tenant_memberships` filtra — usuário
   * sem vínculo no tenant não é devolvido), para validar aprovadores designados (US-061).
   */
  membersInTenant(tx: TenantTx, userIds: readonly string[]): Promise<TenantMember[]>;
  /**
   * Quais dos usuários têm lotação (`membership_departments`) na unidade, no tenant da transação
   * (US-102 · RN-TEN-48: titular/substituto elegíveis).
   */
  usersAssignedToDepartment(
    tx: TenantTx,
    departmentId: string,
    userIds: readonly string[],
  ): Promise<Set<string>>;
  /** Lotações (de qualquer vínculo) na unidade — impedem a exclusão física (US-102 · RN-TEN-51). */
  countDepartmentAssignments(tx: TenantTx, departmentId: string): Promise<number>;
  /**
   * Unidades de lotação do vínculo ATIVO do usuário no tenant da transação (US-041: custódia —
   * POL-01/POL-04 — e visibilidade por unidade — DEC-024).
   */
  departmentsOfUser(tx: TenantTx, userId: string): Promise<string[]>;
}

export const IDENTITY_REPOSITORY = Symbol('IdentityRepository');

/** API administrativa do Authentik (`AuthentikAdminClient`). */
export interface AuthentikDirectoryPort {
  /** PK do usuário do Authentik cujo UUID é o `sub`; `null` se não houver (ou sem integração). */
  findUserPkBySubject(subject: string): Promise<string | null>;
}

export const AUTHENTIK_DIRECTORY = Symbol('AuthentikDirectoryPort');

/** Conta do usuário no Authentik: o PK do provisionamento ou, sem ele, o `sub` do primeiro login. */
export interface AuthentikAccountRef {
  readonly authentikUserId: string | null;
  readonly externalSubject: string | null;
}

/**
 * Redefinição do MFA pela API administrativa do Authentik (US-090 · RN-IAM-43/44): remove os
 * dispositivos de segundo fator (TOTP, WebAuthn, códigos estáticos…) da conta, forçando novo
 * *enrollment* no próximo desafio. Idempotente: conta sem dispositivo (ou sem conta) não é erro.
 * O ContrataFlow nunca lê nem guarda os segredos — só pede a remoção.
 */
export interface AuthentikMfaPort {
  /**
   * Devolve quantos dispositivos foram removidos agora.
   * @throws AuthentikUnavailableError
   */
  resetMfa(account: AuthentikAccountRef): Promise<{ readonly removedDevices: number }>;
}

export const AUTHENTIK_MFA = Symbol('AuthentikMfaPort');

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
  /** Descarta a política em cache do tenant do contexto (`security.mfaPolicy` alterada — RN-IAM-42). */
  invalidate(): Promise<void>;
}

export const TENANT_MFA_POLICY = Symbol('TenantMfaPolicyPort');

/** Relógio injetável (testes de expiração de vínculo). */
export type Clock = () => Date;

export const IDENTITY_CLOCK = Symbol('IdentityClock');

/** Vínculo `INTERNAL` do tenant da transação com o e-mail do usuário (primeiro administrador). */
export interface InternalMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly status: string;
  /** Último envio do convite (`invitedAt`); `null` = nunca enviado. */
  readonly invitedAt: Date | null;
}

/**
 * Primeiro administrador do provisionamento (US-099 · FA-10): `users` é de plataforma (identidade
 * global, reutilizada pelo e-mail) e `tenant_memberships` é do tenant (RLS).
 */
export interface FirstAdminStore {
  /** Usuário pelo e-mail (citext) ou criado agora — sem `sub`, que chega no primeiro login. */
  findOrCreateUser(input: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly now: Date;
  }): Promise<{ readonly id: string; readonly created: boolean }>;
  /** Vínculos `INTERNAL` do tenant da transação, mais antigos primeiro. */
  internalMembers(tx: TenantTx): Promise<InternalMember[]>;
  /** `INSERT … ON CONFLICT (tenant_id, user_id) DO NOTHING`; `true` se criou. */
  insertInvitedMembership(
    tx: TenantTx,
    membership: {
      readonly id: string;
      readonly tenantId: string;
      readonly userId: string;
      readonly now: Date;
    },
  ): Promise<boolean>;
  /**
   * Envio do convite (US-091 · RN-TEN-08): validade de 7 dias a partir de agora e hash zerado (o
   * `EmailSender` grava o do link novo). Condicional a `INVITED`; `false` se o vínculo mudou.
   */
  renewInvitation(
    tx: TenantTx,
    input: { readonly membershipId: string; readonly now: Date; readonly inviteExpiresAt: Date },
  ): Promise<boolean>;
}

export const FIRST_ADMIN_STORE = Symbol('FirstAdminStore');

/** Transações do tenant do contexto (Prisma: `TenantTransaction`; em memória: simulada). */
export interface IdentityTenantTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const IDENTITY_TENANT_TRANSACTIONS = Symbol('IdentityTenantTransactions');

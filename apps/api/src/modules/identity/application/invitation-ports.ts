import type { InvitationMembershipType } from '@contrataflow/validation';

import type { MembershipStatus } from '#shared/auth/ports.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { PendingInvitation } from '../domain/invitation.js';
import type { MembershipType } from '../domain/tenant-membership.js';

/*
 * Portas do convite e dos vínculos do tenant (US-091 · USR-01/03..06/14): implementadas em
 * `infrastructure/` (Prisma, Authentik, configuração do tenant) e em memória nos testes e no modo
 * de identidade fake.
 */

/** Usuário global (`users`) visto pelo convite. */
export interface InviteeUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly externalSubject: string | null;
  readonly authentikUserId: string | null;
}

/** Vínculo do tenant da transação, com o necessário às regras do convite. */
export interface MembershipRecordRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly type: MembershipType;
  readonly status: MembershipStatus;
  readonly invitedAt: Date | null;
  readonly inviteExpiresAt: Date | null;
  readonly inviteResendCount: number;
  readonly version: number;
}

/** Vínculo com os dados da pessoa e a lotação (resposta de USR-01/03/06). */
export interface MembershipView {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly name: string;
  readonly socialName: string | null;
  readonly email: string;
  readonly type: MembershipType;
  readonly status: MembershipStatus;
  readonly jobTitle: string | null;
  readonly registrationNumber: string | null;
  readonly expiresAt: Date | null;
  /** Principal primeiro. */
  readonly departmentIds: readonly string[];
  readonly invitedAt: Date | null;
  readonly inviteExpiresAt: Date | null;
  readonly activatedAt: Date | null;
  readonly version: number;
}

/** Dados gravados no convite (novo ou de vínculo `REVOKED`/`EXPIRED` reaproveitado). */
export interface InvitationDraft {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly type: InvitationMembershipType;
  readonly jobTitle: string | null;
  readonly expiresAt: Date | null;
  readonly invitedById: string | null;
  readonly now: Date;
  readonly inviteExpiresAt: Date;
}

export interface MembershipListFilter {
  readonly q?: string | undefined;
  readonly statuses?: readonly MembershipStatus[] | undefined;
  readonly type?: InvitationMembershipType | undefined;
  /** US-092: vínculos lotados na unidade. */
  readonly departmentId?: string | undefined;
  readonly offset: number;
  readonly limit: number;
}

/** Corrida do mesmo e-mail em `users` (`users_email_key`). */
export class UserEmailTakenError extends Error {
  constructor() {
    super('E-mail já usado por outro usuário.');
    this.name = 'UserEmailTakenError';
  }
}

/** Corrida do mesmo usuário no tenant (`tenant_memberships_tenant_id_user_id_key`). */
export class MembershipTakenError extends Error {
  constructor() {
    super('O usuário já tem vínculo no tenant.');
    this.name = 'MembershipTakenError';
  }
}

export interface InvitationRepository {
  // --- `users` (plataforma, sem RLS), no `tx` do convite --------------------------------------
  findUserByEmail(tx: TenantTx, email: string): Promise<InviteeUser | null>;
  /** @throws UserEmailTakenError */
  insertUser(
    tx: TenantTx,
    user: {
      readonly id: string;
      readonly email: string;
      readonly name: string;
      readonly authentikUserId: string | null;
      readonly now: Date;
    },
  ): Promise<void>;
  /** Grava o PK do Authentik só onde ainda é nulo (convite de usuário criado antes sem conta). */
  setAuthentikUserId(tx: TenantTx, userId: string, authentikUserId: string): Promise<boolean>;

  // --- `tenant_memberships`/`membership_departments` (RLS do tenant) --------------------------
  findMembershipByUser(tx: TenantTx, userId: string): Promise<MembershipRecordRow | null>;
  /** @throws MembershipTakenError */
  insertInvitation(tx: TenantTx, draft: InvitationDraft): Promise<void>;
  /**
   * Reaproveita o vínculo `REVOKED`/`EXPIRED` como convite novo (zera reenvios, ativação e
   * revogação). `false` se o vínculo mudou de situação no meio do caminho.
   */
  reinvite(tx: TenantTx, draft: InvitationDraft): Promise<boolean>;
  /** Substitui a lotação do vínculo (a primeira unidade é a principal). */
  replaceDepartments(
    tx: TenantTx,
    input: {
      readonly tenantId: string;
      readonly membershipId: string;
      readonly departmentIds: readonly string[];
      readonly createdById: string | null;
      readonly ids: readonly string[];
      readonly now: Date;
    },
  ): Promise<void>;
  /**
   * Novo envio do convite (USR-04 e o convite do primeiro administrador): nova validade, hash
   * zerado (o link anterior deixa de valer na hora; o `EmailSender` grava o novo) e o contador de
   * reenvios. Condicional a `INVITED` e ao contador lido (`expectedResendCount`) — dois reenvios
   * simultâneos não passam os dois.
   */
  renewInvitation(
    tx: TenantTx,
    input: {
      readonly membershipId: string;
      readonly now: Date;
      readonly inviteExpiresAt: Date;
      readonly expectedResendCount: number;
      readonly resendCount: number;
      readonly updatedById: string | null;
    },
  ): Promise<boolean>;
  /** USR-05: cancela o convite (revogação lógica, sem token). Condicional a `INVITED`. */
  cancelInvitation(
    tx: TenantTx,
    input: { readonly membershipId: string; readonly now: Date; readonly revokedById: string },
  ): Promise<boolean>;
  /**
   * USR-06: `INVITED` → `ACTIVE` só se o hash ainda é o do convite e a validade não passou — de um
   * aceite e de um reenvio simultâneos, só um vence (RN-IAM-48/49).
   */
  activate(
    tx: TenantTx,
    input: {
      readonly membershipId: string;
      readonly tokenHash: string;
      readonly now: Date;
      readonly userId: string;
    },
  ): Promise<boolean>;
  membershipView(tx: TenantTx, membershipId: string): Promise<MembershipView | null>;
  listTenantMemberships(
    tx: TenantTx,
    filter: MembershipListFilter,
  ): Promise<{ readonly items: MembershipView[]; readonly total: number }>;

  // --- Entre tenants ----------------------------------------------------------------------------
  /** Convite pelo hash do token (`cf_find_invitation` pelo `SystemDbService` — FA-05). */
  findInvitationByTokenHash(tokenHash: string): Promise<PendingInvitation | null>;
}

export const INVITATION_REPOSITORY = Symbol('InvitationRepository');

/** Falha da API administrativa do Authentik (rede, 5xx, credencial) → 503. */
export class AuthentikUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('API administrativa do Authentik indisponível.', options);
    this.name = 'AuthentikUnavailableError';
  }
}

/** Provisionamento da conta no Authentik (RN-IAM-46 · DEC-130): nunca com senha. */
export interface AuthentikProvisioningPort {
  /**
   * Cria a conta (ou devolve a já existente com o mesmo e-mail) sem senha e devolve o PK.
   * `created` informa se a conta é nova — só ela é removida na compensação.
   * @throws AuthentikUnavailableError
   */
  provisionUser(user: {
    readonly email: string;
    readonly name: string;
  }): Promise<{ readonly pk: string; readonly created: boolean }>;
  /** Compensação: remove a conta criada nesta chamada. Nunca lança. */
  removeUser(pk: string): Promise<void>;
}

export const AUTHENTIK_PROVISIONING = Symbol('AuthentikProvisioningPort');

/** `security.externalMembershipMaxDays` do tenant da transação (RN-IAM-52). */
export interface MembershipSettingsPort {
  externalMembershipMaxDays(tx: TenantTx): Promise<number>;
}

export const MEMBERSHIP_SETTINGS = Symbol('MembershipSettingsPort');

import type {
  AuthenticatedUser,
  MembershipPort,
  MembershipRecord,
  MembershipStatus,
  UserPort,
} from '#shared/auth/ports.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';
import type { FakeMembership, FakeUser } from '#shared/testing/fake-directory.js';

import {
  AuthentikUnavailableError,
  MembershipTakenError,
  UserEmailTakenError,
} from '../application/invitation-ports.js';
import type {
  AuthentikProvisioningPort,
  InvitationDraft,
  InvitationRepository,
  InviteeUser,
  MembershipListFilter,
  MembershipRecordRow,
  MembershipView,
} from '../application/invitation-ports.js';
import type {
  MembershipDetailView,
  MembershipRepository,
  MembershipState,
} from '../application/membership-ports.js';
import type {
  AuthentikAccountRef,
  AuthentikDirectoryPort,
  ActiveMemberMatch,
  AuthentikMfaPort,
  IdentityRepository,
  LoginRecord,
  TenantMember,
} from '../application/ports.js';
import { generateInvitationToken, hashInvitationToken } from '../domain/invitation.js';
import type { PendingInvitation } from '../domain/invitation.js';
import type { TenantMembership } from '../domain/tenant-membership.js';
import { displayName } from '../domain/user.js';
import type { ProfileUpdate, User } from '../domain/user.js';

interface StoredUser extends FakeUser {
  readonly phone: string | null;
  readonly lastLoginAt: Date | null;
  readonly version: number;
  readonly preferences: Readonly<Record<string, unknown>>;
}

interface StoredMembership extends FakeMembership {
  readonly lastAccessAt: Date | null;
  readonly jobTitle: string | null;
  readonly registrationNumber: string | null;
  readonly invitedAt: Date | null;
  readonly inviteExpiresAt: Date | null;
  readonly inviteTokenHash: string | null;
  readonly inviteResendCount: number;
  readonly activatedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly suspensionReason: string | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly version: number;
}

type TenantData = (typeof FAKE_TENANTS)[keyof typeof FAKE_TENANTS];

/** Minúsculas e sem acento (o `lower(cf_unaccent(...))` do adaptador Prisma). */
const foldText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Vínculo `ACTIVE` não vencido. */
const isActiveAt = (membership: { status: string; expiresAt: Date | null }, now: Date) =>
  membership.status === 'ACTIVE' &&
  (membership.expiresAt === null || membership.expiresAt.getTime() > now.getTime());

/** Vínculo sem suspensão nem revogação registradas. */
const NO_STATUS_DETAILS = {
  suspendedAt: null,
  suspensionReason: null,
  revokedAt: null,
  revocationReason: null,
} as const;

/**
 * Identidade em memória (testes e modo de identidade fake de local/dev/test): implementa as portas
 * do pipeline (`UserPort`, `MembershipPort`) e a `IdentityRepository` dos casos de uso sobre o
 * diretório fixo (`fake-directory.ts`). Mutável: registra vínculos de `sub`, logins e acessos.
 */
export class InMemoryIdentityRepository
  implements
    IdentityRepository,
    InvitationRepository,
    MembershipRepository,
    UserPort,
    MembershipPort
{
  private readonly users: Map<string, StoredUser>;
  private readonly memberships: StoredMembership[];
  private readonly tenants: Map<string, TenantData>;
  /** Lotações (`membership_departments`): carregadas pelos testes com `assignDepartment`. */
  private readonly assignments: { membershipId: string; departmentId: string }[] = [];

  constructor(
    users: readonly FakeUser[] = Object.values(FAKE_USERS),
    memberships: readonly FakeMembership[] = FAKE_MEMBERSHIPS,
    tenants: readonly TenantData[] = Object.values(FAKE_TENANTS),
  ) {
    this.users = new Map(
      users.map((user) => [
        user.id,
        { ...user, phone: null, lastLoginAt: null, version: 1, preferences: {} },
      ]),
    );
    this.memberships = memberships.map((membership) => ({
      ...membership,
      lastAccessAt: null,
      jobTitle: null,
      registrationNumber: null,
      invitedAt: null,
      inviteExpiresAt: null,
      inviteTokenHash: null,
      inviteResendCount: 0,
      activatedAt: null,
      ...NO_STATUS_DETAILS,
      version: 1,
    }));
    this.tenants = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  }

  // --- UserPort / MembershipPort (pipeline de guards) -----------------------------------------

  findByExternalSubject(subject: string): Promise<AuthenticatedUser | null> {
    const user = this.bySubject(subject);
    return Promise.resolve(
      user ? { id: user.id, status: user.status, displayName: displayName(user) } : null,
    );
  }

  findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = this.memberships.find(
      (candidate) => candidate.userId === userId && candidate.tenantId === tenantId,
    );
    return Promise.resolve(
      membership
        ? {
            id: membership.id,
            userId: membership.userId,
            tenantId: membership.tenantId,
            status: membership.status,
            expiresAt: membership.expiresAt,
            roleKeys: membership.roleKeys,
          }
        : null,
    );
  }

  recordAccess(membership: MembershipRecord, at: Date): Promise<void> {
    return this.touchMembershipAccess(membership.tenantId, membership.id, at);
  }

  // --- IdentityRepository (casos de uso) ------------------------------------------------------

  findUserById(userId: string): Promise<User | null> {
    const user = this.users.get(userId);
    return Promise.resolve(user ? toUser(user) : null);
  }

  findUserInTransaction(_tx: TenantTx, userId: string): Promise<User | null> {
    return this.findUserById(userId);
  }

  saveProfile(
    _tx: TenantTx,
    userId: string,
    expectedVersion: number,
    update: Omit<ProfileUpdate, 'changes'>,
  ): Promise<boolean> {
    const user = this.users.get(userId);
    if (user?.version !== expectedVersion) return Promise.resolve(false);
    this.users.set(userId, {
      ...user,
      name: update.name,
      socialName: update.socialName,
      phone: update.phone,
      preferences: update.preferences,
      version: user.version + 1,
    });
    return Promise.resolve(true);
  }

  findUserBySubject(subject: string): Promise<User | null> {
    const user = this.bySubject(subject);
    return Promise.resolve(user ? toUser(user) : null);
  }

  findUnboundUserByAuthentikId(authentikUserId: string): Promise<User | null> {
    const user = [...this.users.values()].find(
      (candidate) => candidate.subject === null && candidate.authentikUserId === authentikUserId,
    );
    return Promise.resolve(user ? toUser(user) : null);
  }

  findUnboundUserByEmail(email: string): Promise<User | null> {
    const user = [...this.users.values()].find(
      (candidate) =>
        candidate.subject === null &&
        candidate.authentikUserId === null &&
        candidate.email.toLowerCase() === email.toLowerCase(),
    );
    return Promise.resolve(user ? toUser(user) : null);
  }

  recordLogin(userId: string, at: Date, bindSubject: string | null): Promise<LoginRecord> {
    const user = this.users.get(userId);
    if (!user) return Promise.resolve({ kind: 'subject_conflict' });
    let bound = false;
    if (bindSubject !== null) {
      const taken = this.bySubject(bindSubject);
      if (taken && taken.id !== userId) return Promise.resolve({ kind: 'subject_conflict' });
      if (user.subject !== null && user.subject !== bindSubject) {
        return Promise.resolve({ kind: 'subject_conflict' });
      }
      bound = user.subject === null;
    }
    this.users.set(userId, { ...user, subject: bindSubject ?? user.subject, lastLoginAt: at });
    return Promise.resolve({ kind: 'recorded', bound });
  }

  listMemberships(userId: string): Promise<TenantMembership[]> {
    const result = this.memberships
      .filter((membership) => membership.userId === userId)
      .flatMap((membership) => {
        const tenant = this.tenants.get(membership.tenantId);
        return tenant ? [toTenantMembership(membership, tenant)] : [];
      })
      .sort((left, right) => left.tenant.name.localeCompare(right.tenant.name, 'pt-BR'));
    return Promise.resolve(result);
  }

  touchMembershipAccess(tenantId: string, membershipId: string, at: Date): Promise<void> {
    const index = this.memberships.findIndex(
      (membership) => membership.id === membershipId && membership.tenantId === tenantId,
    );
    const current = this.memberships[index];
    if (current) this.memberships[index] = { ...current, lastAccessAt: at };
    return Promise.resolve();
  }

  setDefaultTenant(userId: string, tenantId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      this.users.set(userId, {
        ...user,
        preferences: { ...user.preferences, defaultTenantId: tenantId },
      });
    }
    return Promise.resolve();
  }

  displayNamesInTenant(_tx: TenantTx, userIds: readonly string[]): Promise<Map<string, string>> {
    // Sem RLS em memória: o tenant vem do contexto, como o `app.tenant_id` da transação.
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const names = new Map<string, string>();
    for (const userId of userIds) {
      const user = this.users.get(userId);
      const member = this.memberships.some(
        (membership) => membership.userId === userId && membership.tenantId === tenantId,
      );
      if (user && member) names.set(userId, displayName(user));
    }
    return Promise.resolve(names);
  }

  membersInTenant(_tx: TenantTx, userIds: readonly string[]): Promise<TenantMember[]> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return Promise.resolve(
      this.memberships
        .filter(
          (membership) => membership.tenantId === tenantId && userIds.includes(membership.userId),
        )
        .map((membership) => ({
          userId: membership.userId,
          membershipId: membership.id,
          type: membership.type,
          status: membership.status,
          expiresAt: membership.expiresAt,
          roleKeys: membership.roleKeys,
        })),
    );
  }

  usersAssignedToDepartment(
    _tx: TenantTx,
    departmentId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const assigned = new Set<string>();
    for (const membership of this.memberships) {
      if (membership.tenantId !== tenantId || !userIds.includes(membership.userId)) continue;
      const lotado = this.assignments.some(
        (item) => item.membershipId === membership.id && item.departmentId === departmentId,
      );
      if (lotado) assigned.add(membership.userId);
    }
    return Promise.resolve(assigned);
  }

  countDepartmentAssignments(_tx: TenantTx, departmentId: string): Promise<number> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const inTenant = new Set(
      this.memberships.filter((m) => m.tenantId === tenantId).map((m) => m.id),
    );
    return Promise.resolve(
      this.assignments.filter(
        (item) => item.departmentId === departmentId && inTenant.has(item.membershipId),
      ).length,
    );
  }

  departmentsOfUser(_tx: TenantTx, userId: string): Promise<string[]> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const memberships = new Set(
      this.memberships
        .filter(
          (membership) =>
            membership.tenantId === tenantId &&
            membership.userId === userId &&
            membership.status === 'ACTIVE',
        )
        .map((membership) => membership.id),
    );
    return Promise.resolve([
      ...new Set(
        this.assignments
          .filter((item) => memberships.has(item.membershipId))
          .map((item) => item.departmentId),
      ),
    ]);
  }

  searchActiveMembers(
    _tx: TenantTx,
    q: string,
    limit: number,
    now: Date,
  ): Promise<ActiveMemberMatch[]> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const needle = foldText(q.trim());
    const matches: ActiveMemberMatch[] = [];
    for (const membership of this.memberships) {
      if (membership.tenantId !== tenantId || !isActiveAt(membership, now)) continue;
      const user = this.users.get(membership.userId);
      if (user?.status !== 'ACTIVE') continue;
      const found = [user.name, user.socialName, user.email].some(
        (text) => text !== null && foldText(text).includes(needle),
      );
      if (!found) continue;
      matches.push({
        userId: user.id,
        membershipId: membership.id,
        name: displayName(user),
        roleKeys: membership.roleKeys,
      });
    }
    return Promise.resolve(
      matches
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.userId.localeCompare(b.userId))
        .slice(0, limit),
    );
  }

  activeMemberCounts(
    _tx: TenantTx,
    departmentIds: readonly string[],
    now: Date,
  ): Promise<Map<string, number>> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const active = new Map(
      this.memberships
        .filter((membership) => membership.tenantId === tenantId && isActiveAt(membership, now))
        .map((membership) => [membership.id, membership.userId]),
    );
    const counts = new Map<string, number>();
    for (const departmentId of new Set(departmentIds)) {
      const users = new Set(
        this.assignments
          .filter((item) => item.departmentId === departmentId && active.has(item.membershipId))
          .map((item) => active.get(item.membershipId)),
      );
      if (users.size > 0) counts.set(departmentId, users.size);
    }
    return Promise.resolve(counts);
  }

  // --- InvitationRepository (US-091) -----------------------------------------------------------

  findUserByEmail(_tx: TenantTx, email: string): Promise<InviteeUser | null> {
    const user = this.byEmail(email);
    return Promise.resolve(
      user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            externalSubject: user.subject,
            authentikUserId: user.authentikUserId,
          }
        : null,
    );
  }

  insertUser(
    _tx: TenantTx,
    user: { id: string; email: string; name: string; authentikUserId: string | null },
  ): Promise<void> {
    if (this.byEmail(user.email)) return Promise.reject(new UserEmailTakenError());
    this.users.set(user.id, {
      id: user.id,
      subject: null,
      authentikUserId: user.authentikUserId,
      email: user.email,
      name: user.name,
      socialName: null,
      phone: null,
      status: 'ACTIVE',
      lastLoginAt: null,
      version: 1,
      preferences: {},
    });
    return Promise.resolve();
  }

  setAuthentikUserId(_tx: TenantTx, userId: string, authentikUserId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (user?.authentikUserId !== null) return Promise.resolve(false);
    this.users.set(userId, { ...user, authentikUserId });
    return Promise.resolve(true);
  }

  findMembershipByUser(_tx: TenantTx, userId: string): Promise<MembershipRecordRow | null> {
    const membership = this.inContext((candidate) => candidate.userId === userId);
    return Promise.resolve(membership ? toRecordRow(membership) : null);
  }

  insertInvitation(_tx: TenantTx, draft: InvitationDraft): Promise<void> {
    if (draft.tenantId !== contextTenant()) {
      return Promise.reject(new Error('Vínculo de outro tenant.'));
    }
    if (this.inContext((candidate) => candidate.userId === draft.userId)) {
      return Promise.reject(new MembershipTakenError());
    }
    this.memberships.push({
      id: draft.membershipId,
      userId: draft.userId,
      tenantId: draft.tenantId,
      type: draft.type,
      status: 'INVITED',
      expiresAt: draft.expiresAt,
      roleKeys: [],
      lastAccessAt: null,
      jobTitle: draft.jobTitle,
      registrationNumber: null,
      invitedAt: draft.now,
      inviteExpiresAt: draft.inviteExpiresAt,
      inviteTokenHash: null,
      inviteResendCount: 0,
      activatedAt: null,
      ...NO_STATUS_DETAILS,
      version: 1,
    });
    return Promise.resolve();
  }

  reinvite(_tx: TenantTx, draft: InvitationDraft): Promise<boolean> {
    return Promise.resolve(
      this.transition(
        draft.membershipId,
        (current) => current.status === 'REVOKED' || current.status === 'EXPIRED',
        (current) => ({
          ...current,
          status: 'INVITED',
          type: draft.type,
          jobTitle: draft.jobTitle,
          expiresAt: draft.expiresAt,
          invitedAt: draft.now,
          inviteExpiresAt: draft.inviteExpiresAt,
          inviteTokenHash: null,
          inviteResendCount: 0,
          activatedAt: null,
          ...NO_STATUS_DETAILS,
        }),
      ),
    );
  }

  replaceDepartments(
    _tx: TenantTx,
    input: { membershipId: string; departmentIds: readonly string[] },
  ): Promise<void> {
    for (let index = this.assignments.length - 1; index >= 0; index -= 1) {
      if (this.assignments[index]?.membershipId === input.membershipId) {
        this.assignments.splice(index, 1);
      }
    }
    for (const departmentId of input.departmentIds) {
      this.assignments.push({ membershipId: input.membershipId, departmentId });
    }
    return Promise.resolve();
  }

  renewInvitation(
    _tx: TenantTx,
    input: {
      membershipId: string;
      now: Date;
      inviteExpiresAt: Date;
      expectedResendCount: number;
      resendCount: number;
    },
  ): Promise<boolean> {
    return Promise.resolve(
      this.transition(
        input.membershipId,
        (current) =>
          current.status === 'INVITED' && current.inviteResendCount === input.expectedResendCount,
        (current) => ({
          ...current,
          invitedAt: input.now,
          inviteExpiresAt: input.inviteExpiresAt,
          inviteTokenHash: null,
          inviteResendCount: input.resendCount,
        }),
      ),
    );
  }

  cancelInvitation(_tx: TenantTx, input: { membershipId: string }): Promise<boolean> {
    return Promise.resolve(
      this.transition(
        input.membershipId,
        (current) => current.status === 'INVITED',
        (current) => ({
          ...current,
          status: 'REVOKED',
          inviteTokenHash: null,
          inviteExpiresAt: null,
        }),
      ),
    );
  }

  activate(
    _tx: TenantTx,
    input: { membershipId: string; tokenHash: string; now: Date; userId: string },
  ): Promise<boolean> {
    return Promise.resolve(
      this.transition(
        input.membershipId,
        (current) =>
          current.userId === input.userId &&
          current.status === 'INVITED' &&
          current.inviteTokenHash === input.tokenHash &&
          current.inviteExpiresAt !== null &&
          current.inviteExpiresAt.getTime() > input.now.getTime(),
        (current) => ({
          ...current,
          status: 'ACTIVE',
          activatedAt: input.now,
          inviteTokenHash: null,
        }),
      ),
    );
  }

  membershipView(_tx: TenantTx, membershipId: string): Promise<MembershipView | null> {
    const membership = this.inContext((candidate) => candidate.id === membershipId);
    return Promise.resolve(membership ? this.toView(membership) : null);
  }

  listTenantMemberships(
    _tx: TenantTx,
    filter: MembershipListFilter,
  ): Promise<{ items: MembershipView[]; total: number }> {
    const tenantId = contextTenant();
    const q = filter.q?.toLowerCase();
    const matching = this.memberships
      .filter((membership) => membership.tenantId === tenantId)
      .map((membership) => this.toView(membership))
      .filter(
        (view) =>
          (!filter.statuses || filter.statuses.includes(view.status)) &&
          (!filter.type || view.type === filter.type) &&
          (!filter.departmentId || view.departmentIds.includes(filter.departmentId)) &&
          (!q || view.name.toLowerCase().includes(q) || view.email.toLowerCase().includes(q)),
      )
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, 'pt-BR') || left.id.localeCompare(right.id),
      );
    return Promise.resolve({
      items: matching.slice(filter.offset, filter.offset + filter.limit),
      total: matching.length,
    });
  }

  findInvitationByTokenHash(tokenHash: string): Promise<PendingInvitation | null> {
    const membership = this.memberships.find(
      (candidate) => candidate.inviteTokenHash !== null && candidate.inviteTokenHash === tokenHash,
    );
    const tenant = membership ? this.tenants.get(membership.tenantId) : undefined;
    if (!membership || !tenant) return Promise.resolve(null);
    return Promise.resolve({
      membershipId: membership.id,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantStatus: tenant.status,
      userId: membership.userId,
      status: membership.status,
      inviteExpiresAt: membership.inviteExpiresAt,
    });
  }

  // --- MembershipRepository (US-092) -----------------------------------------------------------

  findStateByUser(_tx: TenantTx, userId: string): Promise<MembershipState | null> {
    const membership = this.inContext((candidate) => candidate.userId === userId);
    if (!membership) return Promise.resolve(null);
    const view = this.toView(membership);
    return Promise.resolve({
      id: membership.id,
      tenantId: membership.tenantId,
      userId: membership.userId,
      type: membership.type,
      status: membership.status,
      jobTitle: membership.jobTitle,
      registrationNumber: membership.registrationNumber,
      expiresAt: membership.expiresAt,
      departmentIds: view.departmentIds,
      version: membership.version,
    });
  }

  detail(_tx: TenantTx, membershipId: string): Promise<MembershipDetailView | null> {
    const membership = this.inContext((candidate) => candidate.id === membershipId);
    return Promise.resolve(
      membership
        ? {
            ...this.toView(membership),
            suspendedAt: membership.suspendedAt,
            suspensionReason: membership.suspensionReason,
            revokedAt: membership.revokedAt,
            revocationReason: membership.revocationReason,
          }
        : null,
    );
  }

  updateProfile(
    _tx: TenantTx,
    input: {
      membershipId: string;
      expectedVersion: number;
      jobTitle?: string | null;
      registrationNumber?: string | null;
      expiresAt?: Date;
    },
  ): Promise<boolean> {
    return Promise.resolve(
      this.transition(
        input.membershipId,
        (current) => current.version === input.expectedVersion,
        (current) => ({
          ...current,
          ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
          ...(input.registrationNumber === undefined
            ? {}
            : { registrationNumber: input.registrationNumber }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        }),
      ),
    );
  }

  bumpVersion(
    _tx: TenantTx,
    input: { membershipId: string; expectedVersion: number },
  ): Promise<boolean> {
    return Promise.resolve(
      this.transition(
        input.membershipId,
        (current) => current.version === input.expectedVersion,
        (current) => current,
      ),
    );
  }

  changeStatus(
    _tx: TenantTx,
    input: {
      membershipId: string;
      expectedVersion: number;
      now: Date;
      actorId: string | null;
      from: readonly MembershipStatus[];
      to: MembershipStatus;
      reason: string | null;
    },
  ): Promise<boolean> {
    return Promise.resolve(
      this.transition(
        input.membershipId,
        (current) =>
          current.version === input.expectedVersion && input.from.includes(current.status),
        (current) => {
          if (input.to === 'SUSPENDED') {
            return {
              ...current,
              status: 'SUSPENDED',
              suspendedAt: input.now,
              suspensionReason: input.reason,
            };
          }
          if (input.to === 'REVOKED') {
            return {
              ...current,
              status: 'REVOKED',
              revokedAt: input.now,
              revocationReason: input.reason,
              inviteTokenHash: null,
              inviteExpiresAt: null,
            };
          }
          return { ...current, status: input.to, suspendedAt: null, suspensionReason: null };
        },
      ),
    );
  }

  lockActiveMemberships(
    _tx: TenantTx,
    membershipIds: readonly string[],
    now: Date,
  ): Promise<string[]> {
    const tenantId = contextTenant();
    return Promise.resolve(
      this.memberships
        .filter(
          (membership) =>
            membership.tenantId === tenantId &&
            membershipIds.includes(membership.id) &&
            membership.status === 'ACTIVE' &&
            (membership.expiresAt === null || membership.expiresAt.getTime() > now.getTime()),
        )
        .map((membership) => membership.id)
        .sort(),
    );
  }

  userIdsOf(_tx: TenantTx, membershipIds: readonly string[]): Promise<Map<string, string>> {
    const tenantId = contextTenant();
    return Promise.resolve(
      new Map(
        this.memberships
          .filter(
            (membership) =>
              membership.tenantId === tenantId && membershipIds.includes(membership.id),
          )
          .map((membership) => [membership.id, membership.userId]),
      ),
    );
  }

  /**
   * Simula o `EmailSender` (worker): gera o token do convite pendente e grava só o hash, como o
   * envio do e-mail faz (queues.md §4.3). Devolve o token em claro — o "link do e-mail".
   */
  deliverInvitation(membershipId: string): string {
    const token = generateInvitationToken();
    const index = this.memberships.findIndex((candidate) => candidate.id === membershipId);
    const current = this.memberships[index];
    if (current?.status !== 'INVITED') throw new Error('Sem convite pendente.');
    this.memberships[index] = { ...current, inviteTokenHash: hashInvitationToken(token) };
    return token;
  }

  /** Testes: força a validade do link (convite expirado — FA-03). */
  setInviteExpiry(membershipId: string, inviteExpiresAt: Date): void {
    const index = this.memberships.findIndex((candidate) => candidate.id === membershipId);
    const current = this.memberships[index];
    if (current) this.memberships[index] = { ...current, inviteExpiresAt };
  }

  /** Testes: vínculo do usuário no tenant (sem filtro de contexto). */
  membershipOf(userId: string, tenantId: string): StoredMembership | undefined {
    return this.memberships.find(
      (candidate) => candidate.userId === userId && candidate.tenantId === tenantId,
    );
  }

  /** Testes: usuário pelo e-mail. */
  userByEmail(email: string): StoredUser | undefined {
    return this.byEmail(email);
  }

  private byEmail(email: string): StoredUser | undefined {
    return [...this.users.values()].find(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    );
  }

  /** Como a RLS: só vínculos do tenant do contexto. */
  private inContext(
    match: (membership: StoredMembership) => boolean,
  ): StoredMembership | undefined {
    const tenantId = contextTenant();
    return this.memberships.find(
      (candidate) => candidate.tenantId === tenantId && match(candidate),
    );
  }

  /** `UPDATE … WHERE <estado esperado>` em memória, no tenant do contexto: `true` se aplicou. */
  private transition(
    membershipId: string,
    expected: (membership: StoredMembership) => boolean,
    next: (membership: StoredMembership) => StoredMembership,
  ): boolean {
    const tenantId = contextTenant();
    const index = this.memberships.findIndex(
      (candidate) => candidate.id === membershipId && candidate.tenantId === tenantId,
    );
    const current = this.memberships[index];
    if (!current || !expected(current)) return false;
    this.memberships[index] = { ...next(current), version: current.version + 1 };
    return true;
  }

  private toView(membership: StoredMembership): MembershipView {
    const user = this.users.get(membership.userId);
    return {
      id: membership.id,
      tenantId: membership.tenantId,
      userId: membership.userId,
      name: user?.name ?? '',
      socialName: user?.socialName ?? null,
      email: user?.email ?? '',
      type: membership.type,
      status: membership.status,
      jobTitle: membership.jobTitle,
      registrationNumber: membership.registrationNumber,
      expiresAt: membership.expiresAt,
      departmentIds: this.assignments
        .filter((item) => item.membershipId === membership.id)
        .map((item) => item.departmentId),
      invitedAt: membership.invitedAt,
      inviteExpiresAt: membership.inviteExpiresAt,
      activatedAt: membership.activatedAt,
      version: membership.version,
    };
  }

  // --- Inspeção (testes) -----------------------------------------------------------------------

  /** Carga de testes (US-072): usuário ativo com vínculo ATIVO no tenant, sem perfis. */
  seedActiveMember(
    user: { readonly id: string; readonly name: string; readonly email: string },
    membership: { readonly id: string; readonly tenantId: string },
  ): void {
    this.users.set(user.id, {
      ...user,
      subject: null,
      authentikUserId: null,
      socialName: null,
      status: 'ACTIVE',
      phone: null,
      lastLoginAt: null,
      version: 1,
      preferences: {},
    });
    this.memberships.push({
      id: membership.id,
      userId: user.id,
      tenantId: membership.tenantId,
      type: 'INTERNAL',
      status: 'ACTIVE',
      expiresAt: null,
      roleKeys: [],
      lastAccessAt: null,
      jobTitle: null,
      registrationNumber: null,
      invitedAt: null,
      inviteExpiresAt: null,
      inviteTokenHash: null,
      inviteResendCount: 0,
      activatedAt: null,
      ...NO_STATUS_DETAILS,
      version: 1,
    });
  }

  /** Carga de testes: lota o vínculo na unidade (no banco, `membership_departments`). */
  assignDepartment(membershipId: string, departmentId: string): void {
    this.assignments.push({ membershipId, departmentId });
  }

  snapshotUser(userId: string): StoredUser | undefined {
    return this.users.get(userId);
  }

  snapshotMembership(membershipId: string): StoredMembership | undefined {
    return this.memberships.find((membership) => membership.id === membershipId);
  }

  private bySubject(subject: string): StoredUser | undefined {
    return [...this.users.values()].find((user) => user.subject === subject);
  }
}

function contextTenant(): string | null {
  return currentRequestContext()?.tenantId ?? null;
}

function toRecordRow(membership: StoredMembership): MembershipRecordRow {
  return {
    id: membership.id,
    tenantId: membership.tenantId,
    userId: membership.userId,
    type: membership.type,
    status: membership.status,
    invitedAt: membership.invitedAt,
    inviteExpiresAt: membership.inviteExpiresAt,
    inviteResendCount: membership.inviteResendCount,
    version: membership.version,
  };
}

function toUser(user: StoredUser): User {
  return {
    id: user.id,
    externalSubject: user.subject,
    authentikUserId: user.authentikUserId,
    email: user.email,
    name: user.name,
    socialName: user.socialName,
    phone: user.phone,
    status: user.status,
    preferences: user.preferences,
    version: user.version,
  };
}

function toTenantMembership(membership: StoredMembership, tenant: TenantData): TenantMembership {
  return {
    id: membership.id,
    tenant: { id: tenant.id, name: tenant.name, status: tenant.status, timezone: tenant.timezone },
    type: membership.type,
    status: membership.status,
    expiresAt: membership.expiresAt,
    roleKeys: membership.roleKeys,
  };
}

/**
 * Diretório do Authentik em memória: o `sub` do modo fake é `sub-<nome>`; sem PK conhecida. Também
 * provisiona as contas do convite (US-091), com falha injetável (`unavailable`) e o registro das
 * contas criadas e das removidas pela compensação.
 */
export class InMemoryAuthentikDirectory
  implements AuthentikDirectoryPort, AuthentikProvisioningPort, AuthentikMfaPort
{
  /** Authentik fora do ar: `provisionUser` falha (Gherkin "Falha de integração"). */
  unavailable = false;
  readonly provisioned: { readonly pk: string; readonly email: string }[] = [];
  readonly removed: string[] = [];
  private nextPk = 5_000;

  constructor(private readonly pks: Readonly<Record<string, string>> = {}) {}

  findUserPkBySubject(subject: string): Promise<string | null> {
    return Promise.resolve(this.pks[subject] ?? null);
  }

  provisionUser(user: { email: string; name: string }): Promise<{ pk: string; created: boolean }> {
    if (this.unavailable) return Promise.reject(new AuthentikUnavailableError());
    this.nextPk += 1;
    const pk = String(this.nextPk);
    this.provisioned.push({ pk, email: user.email });
    return Promise.resolve({ pk, created: true });
  }

  removeUser(pk: string): Promise<void> {
    this.removed.push(pk);
    return Promise.resolve();
  }

  /** Dispositivos de MFA por conta (`authentikUserId` ou `sub`) — US-090. */
  readonly mfaDevices = new Map<string, number>();
  /** Redefinições pedidas (Gherkin "Duplicidade"). */
  readonly mfaResets: AuthentikAccountRef[] = [];

  resetMfa(account: AuthentikAccountRef): Promise<{ removedDevices: number }> {
    if (this.unavailable) return Promise.reject(new AuthentikUnavailableError());
    this.mfaResets.push(account);
    const key = account.authentikUserId ?? account.externalSubject;
    if (key === null) return Promise.resolve({ removedDevices: 0 });
    const removedDevices = this.mfaDevices.get(key) ?? 0;
    this.mfaDevices.set(key, 0);
    return Promise.resolve({ removedDevices });
  }
}

import type {
  AuthenticatedUser,
  MembershipPort,
  MembershipRecord,
  UserPort,
} from '#shared/auth/ports.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';
import type { FakeMembership, FakeUser } from '#shared/testing/fake-directory.js';

import type {
  AuthentikDirectoryPort,
  IdentityRepository,
  LoginRecord,
} from '../application/ports.js';
import type { TenantMembership } from '../domain/tenant-membership.js';
import { displayName } from '../domain/user.js';
import type { User } from '../domain/user.js';

interface StoredUser extends FakeUser {
  readonly lastLoginAt: Date | null;
  readonly version: number;
  readonly preferences: Readonly<Record<string, unknown>>;
}

interface StoredMembership extends FakeMembership {
  readonly lastAccessAt: Date | null;
}

type TenantData = (typeof FAKE_TENANTS)[keyof typeof FAKE_TENANTS];

/**
 * Identidade em memória (testes e modo de identidade fake de local/dev/test): implementa as portas
 * do pipeline (`UserPort`, `MembershipPort`) e a `IdentityRepository` dos casos de uso sobre o
 * diretório fixo (`fake-directory.ts`). Mutável: registra vínculos de `sub`, logins e acessos.
 */
export class InMemoryIdentityRepository implements IdentityRepository, UserPort, MembershipPort {
  private readonly users: Map<string, StoredUser>;
  private readonly memberships: StoredMembership[];
  private readonly tenants: Map<string, TenantData>;

  constructor(
    users: readonly FakeUser[] = Object.values(FAKE_USERS),
    memberships: readonly FakeMembership[] = FAKE_MEMBERSHIPS,
    tenants: readonly TenantData[] = Object.values(FAKE_TENANTS),
  ) {
    this.users = new Map(
      users.map((user) => [user.id, { ...user, lastLoginAt: null, version: 1, preferences: {} }]),
    );
    this.memberships = memberships.map((membership) => ({ ...membership, lastAccessAt: null }));
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

  // --- Inspeção (testes) -----------------------------------------------------------------------

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

function toUser(user: StoredUser): User {
  return {
    id: user.id,
    externalSubject: user.subject,
    authentikUserId: user.authentikUserId,
    email: user.email,
    name: user.name,
    socialName: user.socialName,
    phone: null,
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

/** Diretório do Authentik em memória: o `sub` do modo fake é `sub-<nome>`; sem PK conhecida. */
export class InMemoryAuthentikDirectory implements AuthentikDirectoryPort {
  constructor(private readonly pks: Readonly<Record<string, string>> = {}) {}

  findUserPkBySubject(subject: string): Promise<string | null> {
    return Promise.resolve(this.pks[subject] ?? null);
  }
}

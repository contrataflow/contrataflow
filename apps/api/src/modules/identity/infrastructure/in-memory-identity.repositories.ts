import type {
  AuthenticatedUser,
  MembershipPort,
  MembershipRecord,
  UserPort,
} from '#shared/auth/ports.js';
import { FAKE_MEMBERSHIPS, FAKE_USERS } from '#shared/testing/fake-directory.js';

/** `UserPort` em memória (FA-03) — substituído pelo repositório Prisma na US-081. */
export class InMemoryUserRepository implements UserPort {
  constructor(
    private readonly users: readonly (AuthenticatedUser & { subject: string })[] = Object.values(
      FAKE_USERS,
    ),
  ) {}

  findByExternalSubject(subject: string): Promise<AuthenticatedUser | null> {
    const user = this.users.find((candidate) => candidate.subject === subject);
    return Promise.resolve(user ? { id: user.id, status: user.status } : null);
  }
}

/** `MembershipPort` em memória (FA-03) — substituído pelo repositório Prisma na US-081. */
export class InMemoryMembershipRepository implements MembershipPort {
  constructor(private readonly memberships: readonly MembershipRecord[] = FAKE_MEMBERSHIPS) {}

  findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    return Promise.resolve(
      this.memberships.find(
        (membership) => membership.userId === userId && membership.tenantId === tenantId,
      ) ?? null,
    );
  }
}

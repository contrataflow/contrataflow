import { Injectable } from '@nestjs/common';

import type {
  AuthenticatedUser,
  MembershipPort,
  MembershipRecord,
  MembershipStatus,
  TenantStatus,
  UserPort,
} from '#shared/auth/ports.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  ActiveMemberMatch,
  IdentityRepository,
  LoginRecord,
  TenantMember,
} from '../application/ports.js';
import type { MembershipType, TenantMembership } from '../domain/tenant-membership.js';
import { displayName } from '../domain/user.js';
import type { ProfileUpdate, User } from '../domain/user.js';

/** Intervalo mínimo entre gravações de `lastAccessAt` do mesmo vínculo (RN-IAM-16). */
export const LAST_ACCESS_INTERVAL_MS = 5 * 60_000;

/** Colunas lidas de `users` (nunca CPF): o perfil de ME-01 e o necessário ao login. */
const USER_SELECT = {
  id: true,
  externalSubject: true,
  authentikUserId: true,
  email: true,
  name: true,
  socialName: true,
  phone: true,
  status: true,
  preferences: true,
  version: true,
} as const;

interface UserRow {
  readonly id: string;
  readonly externalSubject: string | null;
  readonly authentikUserId: string | null;
  readonly email: string;
  readonly name: string;
  readonly socialName: string | null;
  readonly phone: string | null;
  readonly status: User['status'];
  readonly preferences: unknown;
  readonly version: number;
}

/** Linha de `cf_user_memberships` (enums lidos como texto). */
interface MembershipRow {
  readonly membership_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly tenant_status: string;
  readonly tenant_timezone: string;
  readonly membership_type: string;
  readonly membership_status: string;
  readonly expires_at: Date | null;
  readonly role_keys: string[];
}

/**
 * Chaves dos perfis ATIVOS das atribuições vigentes do vínculo `m` — não revogadas e dentro da
 * validade —, sem repetição e em ordem: a mesma regra de `cf_user_memberships` (spec-531). No `tx`
 * do tenant, a RLS de `role_assignments` e `roles` confirma o isolamento.
 */
const ROLE_KEYS_OF_MEMBERSHIP = Prisma.sql`ARRAY(
  SELECT DISTINCT r.key
    FROM role_assignments a
    JOIN roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
   WHERE a.tenant_id = m.tenant_id
     AND a.membership_id = m.id
     AND a.revoked_at IS NULL
     AND a.valid_from <= now()
     AND (a.valid_until IS NULL OR a.valid_until > now())
     AND r.is_active
   ORDER BY r.key)`;

function toUser(row: UserRow): User {
  const preferences =
    typeof row.preferences === 'object' &&
    row.preferences !== null &&
    !Array.isArray(row.preferences)
      ? (row.preferences as Record<string, unknown>)
      : {};
  return { ...row, preferences };
}

function toMembership(row: MembershipRow): TenantMembership {
  return {
    id: row.membership_id,
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      status: row.tenant_status as TenantStatus,
      timezone: row.tenant_timezone,
    },
    type: row.membership_type as MembershipType,
    status: row.membership_status as MembershipStatus,
    expiresAt: row.expires_at,
    roleKeys: row.role_keys,
  };
}

function readMemberships(tx: TenantTx, userId: string): Promise<MembershipRow[]> {
  return tx.$queryRaw<MembershipRow[]>`
    SELECT membership_id, tenant_id, tenant_name, tenant_status::text AS tenant_status,
           tenant_timezone, membership_type::text AS membership_type,
           membership_status::text AS membership_status, expires_at, role_keys
      FROM cf_user_memberships(${userId}::uuid)`;
}

/**
 * Identidade sobre o PostgreSQL (US-087): `users` (tabela de plataforma) e os vínculos do próprio
 * usuário pela função `cf_user_memberships` — sempre pelo `PlatformTransaction`, sem
 * `app.tenant_id`; a escrita em `tenant_memberships` (`lastAccessAt`) usa a `TenantTransaction`
 * do tenant em contexto. Também serve as portas do pipeline de guards (`UserPort`,
 * `MembershipPort`).
 */
@Injectable()
export class PrismaIdentityRepository implements IdentityRepository, UserPort, MembershipPort {
  /** Último `lastAccessAt` gravado por vínculo neste processo (evita escrita a cada requisição). */
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly platform: PlatformTransaction,
    private readonly tenants: TenantTransaction,
  ) {}

  // --- Pipeline de guards ----------------------------------------------------------------------

  async findByExternalSubject(subject: string): Promise<AuthenticatedUser | null> {
    const user = await this.platform.read((tx) =>
      tx.user.findUnique({
        where: { externalSubject: subject },
        select: { id: true, status: true, name: true, socialName: true },
      }),
    );
    return user ? { id: user.id, status: user.status, displayName: displayName(user) } : null;
  }

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const rows = await this.platform.read(
      (tx) =>
        tx.$queryRaw<MembershipRow[]>`
          SELECT membership_id, tenant_id, tenant_name, tenant_status::text AS tenant_status,
                 tenant_timezone, membership_type::text AS membership_type,
                 membership_status::text AS membership_status, expires_at, role_keys
            FROM cf_user_memberships(${userId}::uuid)
           WHERE tenant_id = ${tenantId}::uuid`,
      { userId },
    );
    const [row] = rows;
    if (!row) return null;
    const membership = toMembership(row);
    return {
      id: membership.id,
      userId,
      tenantId: membership.tenant.id,
      status: membership.status,
      expiresAt: membership.expiresAt,
      roleKeys: membership.roleKeys,
    };
  }

  recordAccess(membership: MembershipRecord, at: Date): Promise<void> {
    return this.touchMembershipAccess(membership.tenantId, membership.id, at);
  }

  // --- Casos de uso ----------------------------------------------------------------------------

  async findUserById(userId: string): Promise<User | null> {
    const row = await this.platform.read((tx) =>
      tx.user.findUnique({ where: { id: userId }, select: USER_SELECT }),
    );
    return row ? toUser(row) : null;
  }

  async findUserInTransaction(tx: TenantTx, userId: string): Promise<User | null> {
    const row = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
    return row ? toUser(row) : null;
  }

  async saveProfile(
    tx: TenantTx,
    userId: string,
    expectedVersion: number,
    update: Omit<ProfileUpdate, 'changes'>,
  ): Promise<boolean> {
    // Só colunas editáveis por ME-02 (RN-IAM-109): e-mail, CPF, status e vínculos ficam de fora.
    const { count } = await tx.user.updateMany({
      where: { id: userId, version: expectedVersion },
      data: {
        name: update.name,
        socialName: update.socialName,
        phone: update.phone,
        preferences: update.preferences as Prisma.InputJsonObject,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  async findUserBySubject(subject: string): Promise<User | null> {
    const row = await this.platform.read((tx) =>
      tx.user.findUnique({ where: { externalSubject: subject }, select: USER_SELECT }),
    );
    return row ? toUser(row) : null;
  }

  async findUnboundUserByAuthentikId(authentikUserId: string): Promise<User | null> {
    const row = await this.platform.read((tx) =>
      tx.user.findFirst({
        where: { authentikUserId, externalSubject: null },
        select: USER_SELECT,
      }),
    );
    return row ? toUser(row) : null;
  }

  async findUnboundUserByEmail(email: string): Promise<User | null> {
    // `email` é citext: a comparação já ignora maiúsculas.
    const row = await this.platform.read((tx) =>
      tx.user.findFirst({
        where: { email, externalSubject: null, authentikUserId: null },
        select: USER_SELECT,
      }),
    );
    return row ? toUser(row) : null;
  }

  async recordLogin(userId: string, at: Date, bindSubject: string | null): Promise<LoginRecord> {
    try {
      return await this.platform.run(
        async (tx): Promise<LoginRecord> => {
          if (bindSubject !== null) {
            // Só onde ainda é nulo: de dois primeiros logins simultâneos, um vincula e o outro
            // relê (RN-IAM-06 · Concorrência).
            const bound = await tx.user.updateMany({
              where: { id: userId, externalSubject: null },
              data: { externalSubject: bindSubject, lastLoginAt: at },
            });
            if (bound.count === 1) return { kind: 'recorded', bound: true };
            const current = await tx.user.findUnique({
              where: { id: userId },
              select: { externalSubject: true },
            });
            if (current?.externalSubject !== bindSubject) return { kind: 'subject_conflict' };
          }
          await tx.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
          return { kind: 'recorded', bound: false };
        },
        { userId },
      );
    } catch (error) {
      // O mesmo `sub` gravado em outro usuário por uma transação concorrente.
      if (isUniqueViolation(error)) return { kind: 'subject_conflict' };
      throw error;
    }
  }

  async listMemberships(userId: string): Promise<TenantMembership[]> {
    const rows = await this.platform.read((tx) => readMemberships(tx, userId), { userId });
    return rows.map(toMembership);
  }

  async setDefaultTenant(userId: string, tenantId: string): Promise<void> {
    // Só a chave `defaultTenantId` do jsonb: as demais preferências (densidade, tema) ficam como
    // estão. Não incrementa `version` — a instituição padrão não aparece no perfil de ME-01/02.
    await this.platform.run(
      (tx) => tx.$executeRaw`
        UPDATE users
           SET preferences = preferences || jsonb_build_object('defaultTenantId', ${tenantId}::text)
         WHERE id = ${userId}::uuid`,
      { userId },
    );
  }

  async displayNamesInTenant(
    tx: TenantTx,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    // `users` é de plataforma (sem RLS): o vínculo, filtrado pela RLS, restringe ao tenant do tx.
    const rows = await tx.$queryRaw<{ id: string; name: string; social_name: string | null }[]>`
      SELECT u.id, u.name, u.social_name
        FROM users u
       WHERE u.id = ANY(${[...userIds]}::uuid[])
         AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = u.id)`;
    return new Map(
      rows.map((row) => [row.id, displayName({ name: row.name, socialName: row.social_name })]),
    );
  }

  async membersInTenant(tx: TenantTx, userIds: readonly string[]): Promise<TenantMember[]> {
    if (userIds.length === 0) return [];
    // A RLS restringe vínculos, atribuições e perfis ao tenant do tx.
    const rows = await tx.$queryRaw<
      {
        id: string;
        user_id: string;
        type: TenantMember['type'];
        status: MembershipStatus;
        expires_at: Date | null;
        role_keys: string[];
      }[]
    >`
      SELECT m.id, m.user_id, m.type::text AS type, m.status::text AS status, m.expires_at,
             ${ROLE_KEYS_OF_MEMBERSHIP} AS role_keys
        FROM tenant_memberships m
       WHERE m.user_id = ANY(${[...userIds]}::uuid[])`;
    return rows.map((row) => ({
      userId: row.user_id,
      membershipId: row.id,
      type: row.type,
      status: row.status,
      expiresAt: row.expires_at,
      roleKeys: row.role_keys,
    }));
  }

  async usersAssignedToDepartment(
    tx: TenantTx,
    departmentId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    // A extensão de isolamento injeta o tenant nas duas tabelas; a RLS confirma.
    const rows = await tx.membershipDepartment.findMany({
      where: { departmentId, membership: { userId: { in: [...userIds] } } },
      select: { membership: { select: { userId: true } } },
    });
    return new Set(rows.map((row) => row.membership.userId));
  }

  countDepartmentAssignments(tx: TenantTx, departmentId: string): Promise<number> {
    return tx.membershipDepartment.count({ where: { departmentId } });
  }

  async departmentsOfUser(tx: TenantTx, userId: string): Promise<string[]> {
    // A extensão de isolamento injeta o tenant nas duas tabelas; a RLS confirma.
    const rows = await tx.membershipDepartment.findMany({
      where: { membership: { userId, status: 'ACTIVE' } },
      select: { departmentId: true },
    });
    return [...new Set(rows.map((row) => row.departmentId))];
  }

  async searchActiveMembers(
    tx: TenantTx,
    q: string,
    limit: number,
    now: Date,
  ): Promise<ActiveMemberMatch[]> {
    // `users` é de plataforma (sem RLS): o vínculo, filtrado pela RLS, restringe ao tenant do tx.
    const needle = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await tx.$queryRaw<
      {
        user_id: string;
        membership_id: string;
        name: string;
        social_name: string | null;
        role_keys: string[];
      }[]
    >`
      SELECT m.user_id, m.id AS membership_id, u.name, u.social_name,
             ${ROLE_KEYS_OF_MEMBERSHIP} AS role_keys
        FROM tenant_memberships m
        JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
       WHERE m.status = 'ACTIVE'
         AND (m.expires_at IS NULL OR m.expires_at > ${now})
         AND (   lower(cf_unaccent(u.name)) LIKE lower(cf_unaccent(${needle}))
              OR lower(cf_unaccent(coalesce(u.social_name, ''))) LIKE lower(cf_unaccent(${needle}))
              OR lower(u.email::text) LIKE lower(${needle}))
       ORDER BY lower(cf_unaccent(coalesce(u.social_name, u.name))), u.id
       LIMIT ${limit}`;
    return rows.map((row) => ({
      userId: row.user_id,
      membershipId: row.membership_id,
      name: displayName({ name: row.name, socialName: row.social_name }),
      roleKeys: row.role_keys,
    }));
  }

  async activeMemberCounts(
    tx: TenantTx,
    departmentIds: readonly string[],
    now: Date,
  ): Promise<Map<string, number>> {
    const rows = await tx.$queryRaw<{ department_id: string; members: number }[]>`
      SELECT md.department_id, count(DISTINCT m.user_id)::int AS members
        FROM membership_departments md
        JOIN tenant_memberships m ON m.tenant_id = md.tenant_id AND m.id = md.membership_id
       WHERE md.department_id = ANY(${[...departmentIds]}::uuid[])
         AND m.status = 'ACTIVE'
         AND (m.expires_at IS NULL OR m.expires_at > ${now})
       GROUP BY md.department_id`;
    return new Map(rows.map((row) => [row.department_id, row.members]));
  }

  async touchMembershipAccess(tenantId: string, membershipId: string, at: Date): Promise<void> {
    const last = this.lastTouched.get(membershipId);
    if (last !== undefined && at.getTime() - last < LAST_ACCESS_INTERVAL_MS) return;
    this.lastTouched.set(membershipId, at.getTime());
    const threshold = new Date(at.getTime() - LAST_ACCESS_INTERVAL_MS);
    // Só `last_access_at`: acesso não é alteração do vínculo (sem `version`/`updated_at`).
    await this.tenants.run(
      (tx) => tx.$executeRaw`
        UPDATE tenant_memberships
           SET last_access_at = ${at}
         WHERE tenant_id = ${tenantId}::uuid
           AND id = ${membershipId}::uuid
           AND (last_access_at IS NULL OR last_access_at < ${threshold})`,
    );
  }
}

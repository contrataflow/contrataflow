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
import type { TenantTx } from '#shared/database/prisma.js';

import type { IdentityRepository, LoginRecord } from '../application/ports.js';
import type { MembershipType, TenantMembership } from '../domain/tenant-membership.js';
import { displayName } from '../domain/user.js';
import type { User } from '../domain/user.js';

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
}

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
    // Atribuições de perfil chegam com a US-096 (`role_assignments`).
    roleKeys: [],
  };
}

function readMemberships(tx: TenantTx, userId: string): Promise<MembershipRow[]> {
  return tx.$queryRaw<MembershipRow[]>`
    SELECT membership_id, tenant_id, tenant_name, tenant_status::text AS tenant_status,
           tenant_timezone, membership_type::text AS membership_type,
           membership_status::text AS membership_status, expires_at
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
                 membership_status::text AS membership_status, expires_at
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

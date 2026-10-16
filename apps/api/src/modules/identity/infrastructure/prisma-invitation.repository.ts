import { EXTERNAL_MEMBERSHIP_MAX_DAYS_DEFAULT } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { MembershipStatus } from '#shared/auth/ports.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { SystemDbService } from '#shared/database/system-db.service.js';

import { MembershipTakenError, UserEmailTakenError } from '../application/invitation-ports.js';
import type {
  InvitationDraft,
  InvitationRepository,
  InviteeUser,
  MembershipListFilter,
  MembershipRecordRow,
  MembershipSettingsPort,
  MembershipView,
} from '../application/invitation-ports.js';
import type { PendingInvitation } from '../domain/invitation.js';

const MEMBERSHIP_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  type: true,
  status: true,
  invitedAt: true,
  inviteExpiresAt: true,
  inviteResendCount: true,
  version: true,
} as const;

export const VIEW_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  type: true,
  status: true,
  jobTitle: true,
  registrationNumber: true,
  expiresAt: true,
  invitedAt: true,
  inviteExpiresAt: true,
  activatedAt: true,
  version: true,
  user: { select: { name: true, socialName: true, email: true } },
  departments: { select: { departmentId: true, isPrimary: true, id: true } },
} as const;

export interface ViewRow {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly type: MembershipView['type'];
  readonly status: MembershipStatus;
  readonly jobTitle: string | null;
  readonly registrationNumber: string | null;
  readonly expiresAt: Date | null;
  readonly invitedAt: Date | null;
  readonly inviteExpiresAt: Date | null;
  readonly activatedAt: Date | null;
  readonly version: number;
  readonly user: {
    readonly name: string;
    readonly socialName: string | null;
    readonly email: string;
  };
  readonly departments: readonly {
    readonly departmentId: string;
    readonly isPrimary: boolean;
    readonly id: string;
  }[];
}

export function toView(row: ViewRow): MembershipView {
  const departments = [...row.departments].sort(
    (left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary) || left.id.localeCompare(right.id),
  );
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    name: row.user.name,
    socialName: row.user.socialName,
    email: row.user.email,
    type: row.type,
    status: row.status,
    jobTitle: row.jobTitle,
    registrationNumber: row.registrationNumber,
    expiresAt: row.expiresAt,
    departmentIds: departments.map((item) => item.departmentId),
    invitedAt: row.invitedAt,
    inviteExpiresAt: row.inviteExpiresAt,
    activatedAt: row.activatedAt,
    version: row.version,
  };
}

/** Linha de `cf_find_invitation` (enums lidos como texto). */
interface InvitationRow {
  readonly membership_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly tenant_status: string;
  readonly user_id: string;
  readonly membership_status: string;
  readonly invite_expires_at: Date | null;
}

/**
 * Convite e vínculos no PostgreSQL (US-091): `users` (plataforma, sem RLS) e
 * `tenant_memberships`/`membership_departments` (RLS) no `tx` do caso de uso — uma transação só
 * para o convite inteiro. O aceite acha o convite entre tenants pela função `cf_find_invitation`
 * (`SECURITY DEFINER`, colunas mínimas) no `SystemDbService` (`INVITATION_LOOKUP`) e grava no
 * tenant do convite. Transições condicionais (`updateMany` com o estado esperado) resolvem as
 * corridas de aceite, reenvio e cancelamento sem trava explícita.
 */
@Injectable()
export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly systemDb: SystemDbService) {}

  async findUserByEmail(tx: TenantTx, email: string): Promise<InviteeUser | null> {
    // `email` é citext: a comparação ignora maiúsculas.
    return tx.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, externalSubject: true, authentikUserId: true },
    });
  }

  async insertUser(
    tx: TenantTx,
    user: { id: string; email: string; name: string; authentikUserId: string | null; now: Date },
  ): Promise<void> {
    try {
      await tx.user.create({
        data: {
          id: user.id,
          email: user.email,
          name: user.name,
          authentikUserId: user.authentikUserId,
          createdAt: user.now,
          updatedAt: user.now,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new UserEmailTakenError();
      throw error;
    }
  }

  async setAuthentikUserId(
    tx: TenantTx,
    userId: string,
    authentikUserId: string,
  ): Promise<boolean> {
    const updated = await tx.user.updateMany({
      where: { id: userId, authentikUserId: null },
      data: { authentikUserId },
    });
    return updated.count === 1;
  }

  findMembershipByUser(tx: TenantTx, userId: string): Promise<MembershipRecordRow | null> {
    return tx.tenantMembership.findFirst({ where: { userId }, select: MEMBERSHIP_SELECT });
  }

  async insertInvitation(tx: TenantTx, draft: InvitationDraft): Promise<void> {
    try {
      await tx.tenantMembership.create({
        data: {
          id: draft.membershipId,
          tenantId: draft.tenantId,
          userId: draft.userId,
          type: draft.type,
          status: 'INVITED',
          jobTitle: draft.jobTitle,
          expiresAt: draft.expiresAt,
          invitedById: draft.invitedById,
          invitedAt: draft.now,
          inviteExpiresAt: draft.inviteExpiresAt,
          inviteTokenHash: null,
          inviteResendCount: 0,
          createdAt: draft.now,
          updatedAt: draft.now,
          createdById: draft.invitedById,
          updatedById: draft.invitedById,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new MembershipTakenError();
      throw error;
    }
  }

  async reinvite(tx: TenantTx, draft: InvitationDraft): Promise<boolean> {
    const updated = await tx.tenantMembership.updateMany({
      where: { id: draft.membershipId, status: { in: ['REVOKED', 'EXPIRED'] } },
      data: {
        status: 'INVITED',
        type: draft.type,
        jobTitle: draft.jobTitle,
        expiresAt: draft.expiresAt,
        invitedById: draft.invitedById,
        invitedAt: draft.now,
        inviteExpiresAt: draft.inviteExpiresAt,
        inviteTokenHash: null,
        inviteResendCount: 0,
        activatedAt: null,
        suspendedAt: null,
        suspensionReason: null,
        revokedAt: null,
        revokedById: null,
        revocationReason: null,
        updatedAt: draft.now,
        updatedById: draft.invitedById,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async replaceDepartments(
    tx: TenantTx,
    input: {
      tenantId: string;
      membershipId: string;
      departmentIds: readonly string[];
      createdById: string | null;
      ids: readonly string[];
      now: Date;
    },
  ): Promise<void> {
    await tx.membershipDepartment.deleteMany({ where: { membershipId: input.membershipId } });
    if (input.departmentIds.length === 0) return;
    await tx.membershipDepartment.createMany({
      data: input.departmentIds.map((departmentId, index) => ({
        id: input.ids[index] ?? '',
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        departmentId,
        isPrimary: index === 0,
        createdAt: input.now,
        createdById: input.createdById,
      })),
    });
  }

  async renewInvitation(
    tx: TenantTx,
    input: {
      membershipId: string;
      now: Date;
      inviteExpiresAt: Date;
      expectedResendCount: number;
      resendCount: number;
      updatedById: string | null;
    },
  ): Promise<boolean> {
    const updated = await tx.tenantMembership.updateMany({
      where: {
        id: input.membershipId,
        status: 'INVITED',
        inviteResendCount: input.expectedResendCount,
      },
      data: {
        invitedAt: input.now,
        inviteExpiresAt: input.inviteExpiresAt,
        inviteTokenHash: null,
        inviteResendCount: input.resendCount,
        updatedAt: input.now,
        updatedById: input.updatedById,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async cancelInvitation(
    tx: TenantTx,
    input: { membershipId: string; now: Date; revokedById: string },
  ): Promise<boolean> {
    const updated = await tx.tenantMembership.updateMany({
      where: { id: input.membershipId, status: 'INVITED' },
      data: {
        status: 'REVOKED',
        revokedAt: input.now,
        revokedById: input.revokedById,
        revocationReason: 'Convite cancelado',
        inviteTokenHash: null,
        inviteExpiresAt: null,
        updatedAt: input.now,
        updatedById: input.revokedById,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async activate(
    tx: TenantTx,
    input: { membershipId: string; tokenHash: string; now: Date; userId: string },
  ): Promise<boolean> {
    const updated = await tx.tenantMembership.updateMany({
      where: {
        id: input.membershipId,
        userId: input.userId,
        status: 'INVITED',
        inviteTokenHash: input.tokenHash,
        inviteExpiresAt: { gt: input.now },
      },
      data: {
        status: 'ACTIVE',
        activatedAt: input.now,
        // Uso único: o mesmo link não ativa de novo (RN-IAM-50).
        inviteTokenHash: null,
        updatedAt: input.now,
        updatedById: input.userId,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async membershipView(tx: TenantTx, membershipId: string): Promise<MembershipView | null> {
    const row = await tx.tenantMembership.findFirst({
      where: { id: membershipId },
      select: VIEW_SELECT,
    });
    return row ? toView(row) : null;
  }

  async listTenantMemberships(
    tx: TenantTx,
    filter: MembershipListFilter,
  ): Promise<{ items: MembershipView[]; total: number }> {
    const where = {
      ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.departmentId
        ? { departments: { some: { departmentId: filter.departmentId } } }
        : {}),
      ...(filter.q
        ? {
            OR: [
              { user: { name: { contains: filter.q, mode: 'insensitive' as const } } },
              { user: { email: { contains: filter.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      tx.tenantMembership.findMany({
        where,
        select: VIEW_SELECT,
        orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
        skip: filter.offset,
        take: filter.limit,
      }),
      tx.tenantMembership.count({ where }),
    ]);
    return { items: rows.map(toView), total };
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<PendingInvitation | null> {
    const rows = await this.systemDb.run(
      'INVITATION_LOOKUP',
      (tx) =>
        tx.$queryRaw<InvitationRow[]>`
          SELECT membership_id, tenant_id, tenant_name, tenant_status::text AS tenant_status,
                 user_id, membership_status::text AS membership_status, invite_expires_at
            FROM cf_find_invitation(${tokenHash})`,
      { caller: 'AcceptInvitationCommand', readOnly: true },
    );
    const [row] = rows;
    if (!row) return null;
    return {
      membershipId: row.membership_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      tenantStatus: row.tenant_status,
      userId: row.user_id,
      status: row.membership_status as MembershipStatus,
      inviteExpiresAt: row.invite_expires_at,
    };
  }
}

const EXTERNAL_MAX_DAYS_KEY = 'security.externalMembershipMaxDays';

/** `security.externalMembershipMaxDays` em `tenant_settings` (sob a RLS), ou o padrão (180). */
@Injectable()
export class PrismaMembershipSettings implements MembershipSettingsPort {
  async externalMembershipMaxDays(tx: TenantTx): Promise<number> {
    const setting = await tx.tenantSetting.findFirst({
      where: { key: EXTERNAL_MAX_DAYS_KEY },
      select: { value: true },
    });
    const value = setting?.value;
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : EXTERNAL_MEMBERSHIP_MAX_DAYS_DEFAULT;
  }
}

/** Padrão do registro (testes e modo de identidade fake); `set` muda por teste. */
export class InMemoryMembershipSettings implements MembershipSettingsPort {
  private maxDays = EXTERNAL_MEMBERSHIP_MAX_DAYS_DEFAULT;

  externalMembershipMaxDays(): Promise<number> {
    return Promise.resolve(this.maxDays);
  }

  set(maxDays: number): void {
    this.maxDays = maxDays;
  }
}

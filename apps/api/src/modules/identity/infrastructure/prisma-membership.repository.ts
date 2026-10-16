import { Injectable } from '@nestjs/common';

import type { MembershipStatus } from '#shared/auth/ports.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { VIEW_SELECT, toView } from './prisma-invitation.repository.js';
import type {
  MembershipDetailView,
  MembershipRepository,
  MembershipState,
} from '../application/membership-ports.js';

const DETAIL_SELECT = {
  ...VIEW_SELECT,
  suspendedAt: true,
  suspensionReason: true,
  revokedAt: true,
  revocationReason: true,
} as const;

/**
 * Gestão de vínculos no PostgreSQL (US-092 · USR-07..12): `tenant_memberships` e
 * `membership_departments` pela `TenantTransaction` (a extensão de isolamento injeta o tenant e a
 * RLS confirma — vínculo de outro tenant não existe). Toda gravação é condicional à `version` lida
 * (If-Match — RN-IAM-63) e a incrementa.
 */
@Injectable()
export class PrismaMembershipRepository implements MembershipRepository {
  async findStateByUser(tx: TenantTx, userId: string): Promise<MembershipState | null> {
    const row = await tx.tenantMembership.findFirst({
      where: { userId },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        type: true,
        status: true,
        jobTitle: true,
        registrationNumber: true,
        expiresAt: true,
        version: true,
        departments: { select: { id: true, departmentId: true, isPrimary: true } },
      },
    });
    if (!row) return null;
    const departments = [...row.departments].sort(
      (left, right) =>
        Number(right.isPrimary) - Number(left.isPrimary) || left.id.localeCompare(right.id),
    );
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      type: row.type,
      status: row.status,
      jobTitle: row.jobTitle,
      registrationNumber: row.registrationNumber,
      expiresAt: row.expiresAt,
      departmentIds: departments.map((item) => item.departmentId),
      version: row.version,
    };
  }

  async detail(tx: TenantTx, membershipId: string): Promise<MembershipDetailView | null> {
    const row = await tx.tenantMembership.findFirst({
      where: { id: membershipId },
      select: DETAIL_SELECT,
    });
    return row
      ? {
          ...toView(row),
          suspendedAt: row.suspendedAt,
          suspensionReason: row.suspensionReason,
          revokedAt: row.revokedAt,
          revocationReason: row.revocationReason,
        }
      : null;
  }

  async updateProfile(
    tx: TenantTx,
    input: {
      membershipId: string;
      expectedVersion: number;
      now: Date;
      actorId: string | null;
      jobTitle?: string | null;
      registrationNumber?: string | null;
      expiresAt?: Date;
    },
  ): Promise<boolean> {
    const updated = await tx.tenantMembership.updateMany({
      where: { id: input.membershipId, version: input.expectedVersion },
      data: {
        ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
        ...(input.registrationNumber === undefined
          ? {}
          : { registrationNumber: input.registrationNumber }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        updatedAt: input.now,
        updatedById: input.actorId,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async bumpVersion(
    tx: TenantTx,
    input: { membershipId: string; expectedVersion: number; now: Date; actorId: string | null },
  ): Promise<boolean> {
    const updated = await tx.tenantMembership.updateMany({
      where: { id: input.membershipId, version: input.expectedVersion },
      data: { updatedAt: input.now, updatedById: input.actorId, version: { increment: 1 } },
    });
    return updated.count === 1;
  }

  async changeStatus(
    tx: TenantTx,
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
    const updated = await tx.tenantMembership.updateMany({
      where: {
        id: input.membershipId,
        version: input.expectedVersion,
        status: { in: [...input.from] },
      },
      data: {
        status: input.to,
        ...statusColumns(input.to, input.now, input.actorId, input.reason),
        updatedAt: input.now,
        updatedById: input.actorId,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async lockActiveMemberships(
    tx: TenantTx,
    membershipIds: readonly string[],
    now: Date,
  ): Promise<string[]> {
    if (membershipIds.length === 0) return [];
    // `FOR UPDATE` em ordem de id: a remoção concorrente espera e, ao retomar, o PostgreSQL
    // reavalia o `WHERE` na versão nova da linha (READ COMMITTED) — o administrador já suspenso
    // não conta. O `tenant_id` explícito acompanha a RLS (consulta bruta não passa pela extensão).
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM tenant_memberships
       WHERE tenant_id = current_setting('app.tenant_id')::uuid
         AND id = ANY(${[...membershipIds]}::uuid[])
         AND status = 'ACTIVE'
         AND (expires_at IS NULL OR expires_at > ${now})
       ORDER BY id
         FOR UPDATE`;
    return rows.map((row) => row.id);
  }
}

/** Colunas de cada status de destino (RN-IAM-57..59). */
function statusColumns(
  to: MembershipStatus,
  now: Date,
  actorId: string | null,
  reason: string | null,
) {
  switch (to) {
    case 'SUSPENDED':
      return { suspendedAt: now, suspensionReason: reason };
    case 'ACTIVE':
      // RN-IAM-58: a reativação limpa a suspensão.
      return { suspendedAt: null, suspensionReason: null };
    case 'REVOKED':
      // Definitivo (RN-IAM-59): um convite pendente deixa de valer junto.
      return {
        revokedAt: now,
        revokedById: actorId,
        revocationReason: reason,
        inviteTokenHash: null,
        inviteExpiresAt: null,
      };
    default:
      return {};
  }
}

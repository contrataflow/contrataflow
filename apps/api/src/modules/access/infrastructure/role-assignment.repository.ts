import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { RoleAssignmentAlreadyExistsError } from '../application/ports.js';
import type { InitialRoleAssignment, RoleAssignmentRepository } from '../application/ports.js';
import { isEffective, sameAssignment } from '../domain/role-assignment.js';
import type { RoleAssignment } from '../domain/role-assignment.js';
import type { ScopeType } from '../domain/role.js';

type DuplicateKey = Pick<
  RoleAssignment,
  'membershipId' | 'roleId' | 'scopeType' | 'scopeOrganizationId' | 'scopeDepartmentId'
>;

const ASSIGNMENT_SELECT = {
  id: true,
  tenantId: true,
  membershipId: true,
  roleId: true,
  scopeType: true,
  scopeOrganizationId: true,
  scopeDepartmentId: true,
  includeSubtree: true,
  validFrom: true,
  validUntil: true,
  grantedById: true,
  reason: true,
  revokedAt: true,
  revokedById: true,
  revocationReason: true,
  createdAt: true,
  updatedAt: true,
  version: true,
} as const;

const effectiveWhere = (now: Date) => ({
  revokedAt: null,
  validFrom: { lte: now },
  OR: [{ validUntil: null }, { validUntil: { gt: now } }],
});

/**
 * `role_assignments` no PostgreSQL (US-091/096). A extensão de isolamento injeta o tenant em toda
 * consulta e a RLS confirma. A atribuição inicial do convite usa `skipDuplicates` (`ON CONFLICT DO
 * NOTHING`): novo convite de um vínculo que já tem a mesma atribuição vigente não duplica.
 */
@Injectable()
export class PrismaRoleAssignmentRepository implements RoleAssignmentRepository {
  async insertInitial(tx: TenantTx, assignment: InitialRoleAssignment): Promise<void> {
    await tx.roleAssignment.createMany({
      data: [
        {
          id: assignment.id,
          tenantId: assignment.tenantId,
          membershipId: assignment.membershipId,
          roleId: assignment.roleId,
          scopeType: assignment.scopeType,
          includeSubtree: true,
          validFrom: assignment.now,
          grantedById: assignment.grantedById,
          reason: 'Perfil inicial do convite',
          createdAt: assignment.now,
          updatedAt: assignment.now,
          createdById: assignment.grantedById,
          updatedById: assignment.grantedById,
        },
      ],
      skipDuplicates: true,
    });
  }

  async membershipIdsWithRole(
    tx: TenantTx,
    roleId: string,
    now: Date,
    scopeType?: ScopeType,
  ): Promise<string[]> {
    const rows = await tx.roleAssignment.findMany({
      where: { roleId, ...(scopeType ? { scopeType } : {}), ...effectiveWhere(now) },
      select: { membershipId: true },
    });
    return [...new Set(rows.map((row) => row.membershipId))];
  }

  async countActive(
    tx: TenantTx,
    roleIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (roleIds.length === 0) return new Map();
    const rows = await tx.roleAssignment.findMany({
      where: { roleId: { in: [...roleIds] }, ...effectiveWhere(new Date()) },
      select: { roleId: true, membershipId: true },
      distinct: ['roleId', 'membershipId'],
    });
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + 1);
    return counts;
  }

  async insert(tx: TenantTx, assignment: RoleAssignment): Promise<void> {
    try {
      await tx.roleAssignment.create({
        data: {
          ...assignment,
          createdById: assignment.grantedById,
          updatedById: assignment.grantedById,
        },
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new RoleAssignmentAlreadyExistsError() : error;
    }
  }

  findActiveDuplicate(tx: TenantTx, key: DuplicateKey): Promise<RoleAssignment | null> {
    return tx.roleAssignment.findFirst({
      where: {
        membershipId: key.membershipId,
        roleId: key.roleId,
        scopeType: key.scopeType,
        scopeOrganizationId: key.scopeOrganizationId,
        scopeDepartmentId: key.scopeDepartmentId,
        revokedAt: null,
      },
      select: ASSIGNMENT_SELECT,
    });
  }

  findById(tx: TenantTx, id: string): Promise<RoleAssignment | null> {
    return tx.roleAssignment.findFirst({ where: { id }, select: ASSIGNMENT_SELECT });
  }

  listByMembership(tx: TenantTx, membershipId: string): Promise<RoleAssignment[]> {
    return tx.roleAssignment.findMany({
      where: { membershipId, revokedAt: null },
      select: ASSIGNMENT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async hasAnyAssignment(tx: TenantTx, membershipId: string): Promise<boolean> {
    const found = await tx.roleAssignment.findFirst({
      where: { membershipId },
      select: { id: true },
    });
    return found !== null;
  }

  listByRole(tx: TenantTx, roleId: string): Promise<RoleAssignment[]> {
    return tx.roleAssignment.findMany({
      where: { roleId, revokedAt: null },
      select: ASSIGNMENT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async revoke(tx: TenantTx, revoked: RoleAssignment, expectedVersion: number): Promise<boolean> {
    const { count } = await tx.roleAssignment.updateMany({
      where: { id: revoked.id, version: expectedVersion, revokedAt: null },
      data: {
        revokedAt: revoked.revokedAt,
        revokedById: revoked.revokedById,
        revocationReason: revoked.revocationReason,
        updatedAt: revoked.updatedAt,
        updatedById: revoked.revokedById,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }
}

/**
 * Atribuições em memória (testes e modo de identidade fake), isoladas pelo tenant do contexto. A
 * unicidade da atribuição ativa é conferida e gravada no mesmo passo síncrono — duas requisições
 * simultâneas se comportam como o índice parcial do PostgreSQL.
 */
@Injectable()
export class InMemoryRoleAssignmentRepository implements RoleAssignmentRepository {
  readonly assignments: RoleAssignment[] = [];

  insertInitial(_tx: TenantTx, assignment: InitialRoleAssignment): Promise<void> {
    if (assignment.tenantId !== this.tenant()) {
      return Promise.reject(new Error('Atribuição de outro tenant.'));
    }
    const record: RoleAssignment = {
      id: assignment.id,
      tenantId: assignment.tenantId,
      membershipId: assignment.membershipId,
      roleId: assignment.roleId,
      scopeType: assignment.scopeType,
      scopeOrganizationId: null,
      scopeDepartmentId: null,
      includeSubtree: true,
      validFrom: assignment.now,
      validUntil: null,
      grantedById: assignment.grantedById,
      reason: 'Perfil inicial do convite',
      revokedAt: null,
      revokedById: null,
      revocationReason: null,
      createdAt: assignment.now,
      updatedAt: assignment.now,
      version: 1,
    };
    if (!this.activeOfTenant().some((item) => sameAssignment(item, record))) {
      this.assignments.push(record);
    }
    return Promise.resolve();
  }

  membershipIdsWithRole(
    _tx: TenantTx,
    roleId: string,
    now: Date,
    scopeType?: ScopeType,
  ): Promise<string[]> {
    return Promise.resolve([
      ...new Set(
        this.ofTenant()
          .filter(
            (item) =>
              item.roleId === roleId &&
              (scopeType === undefined || item.scopeType === scopeType) &&
              isEffective(item, now),
          )
          .map((item) => item.membershipId),
      ),
    ]);
  }

  countActive(_tx: TenantTx, roleIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const now = new Date();
    const counts = new Map<string, number>();
    for (const roleId of roleIds) {
      const memberships = new Set(
        this.ofTenant()
          .filter((item) => item.roleId === roleId && isEffective(item, now))
          .map((item) => item.membershipId),
      );
      if (memberships.size > 0) counts.set(roleId, memberships.size);
    }
    return Promise.resolve(counts);
  }

  insert(_tx: TenantTx, assignment: RoleAssignment): Promise<void> {
    if (assignment.tenantId !== this.tenant()) {
      return Promise.reject(new Error('Atribuição de outro tenant.'));
    }
    if (this.activeOfTenant().some((item) => sameAssignment(item, assignment))) {
      return Promise.reject(new RoleAssignmentAlreadyExistsError());
    }
    this.assignments.push(assignment);
    return Promise.resolve();
  }

  findActiveDuplicate(_tx: TenantTx, key: DuplicateKey): Promise<RoleAssignment | null> {
    return Promise.resolve(this.activeOfTenant().find((item) => sameAssignment(item, key)) ?? null);
  }

  findById(_tx: TenantTx, id: string): Promise<RoleAssignment | null> {
    return Promise.resolve(this.ofTenant().find((item) => item.id === id) ?? null);
  }

  listByMembership(_tx: TenantTx, membershipId: string): Promise<RoleAssignment[]> {
    return Promise.resolve(
      this.activeOfTenant().filter((item) => item.membershipId === membershipId),
    );
  }

  hasAnyAssignment(_tx: TenantTx, membershipId: string): Promise<boolean> {
    return Promise.resolve(this.ofTenant().some((item) => item.membershipId === membershipId));
  }

  listByRole(_tx: TenantTx, roleId: string): Promise<RoleAssignment[]> {
    return Promise.resolve(this.activeOfTenant().filter((item) => item.roleId === roleId));
  }

  revoke(_tx: TenantTx, revoked: RoleAssignment, expectedVersion: number): Promise<boolean> {
    const index = this.assignments.findIndex(
      (item) =>
        item.id === revoked.id &&
        item.tenantId === this.tenant() &&
        item.version === expectedVersion &&
        item.revokedAt === null,
    );
    if (index < 0) return Promise.resolve(false);
    this.assignments[index] = { ...revoked, version: expectedVersion + 1 };
    return Promise.resolve(true);
  }

  private tenant(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private ofTenant(): RoleAssignment[] {
    const tenantId = this.tenant();
    return this.assignments.filter((item) => item.tenantId === tenantId);
  }

  private activeOfTenant(): RoleAssignment[] {
    return this.ofTenant().filter((item) => item.revokedAt === null);
  }
}

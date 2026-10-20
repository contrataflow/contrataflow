import { isPermissionCode } from '@contrataflow/types';
import type { PermissionCode } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { RoleAlreadyExistsError } from '../application/ports.js';
import type { RoleGrants, RoleListFilter, RoleRepository } from '../application/ports.js';
import type { Role, RolePermission } from '../domain/role.js';

type Row = Prisma.RoleGetPayload<object>;

function toDomain(row: Row): Role {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    isProtected: row.isProtected,
    allowExternalAssignment: row.allowExternalAssignment,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function codes(values: readonly { permissionCode: string }[]): PermissionCode[] {
  return values
    .map((grant) => grant.permissionCode)
    .filter(isPermissionCode)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `roles`/`role_permissions` no PostgreSQL (US-094/US-095): no `tx` do caso de uso, sob a RLS do tenant e
 * a extensão de isolamento (que injeta e confere o `tenantId`).
 */
@Injectable()
export class PrismaRoleRepository implements RoleRepository {
  async insertMissing(tx: TenantTx, roles: readonly Role[]): Promise<Role[]> {
    if (roles.length === 0) return [];
    // `skipDuplicates` = ON CONFLICT DO NOTHING: perfil existente fica intacto (nem `updatedAt`
    // muda — FA-01) e a execução concorrente espera a outra e não cria nada.
    const created = await tx.role.createManyAndReturn({
      data: roles.map((role) => ({ ...role })),
      skipDuplicates: true,
    });
    return created.map(toDomain);
  }

  async findByKeys(tx: TenantTx, keys: readonly string[]): Promise<Role[]> {
    const rows = await tx.role.findMany({
      where: { key: { in: [...keys] } },
      orderBy: { key: 'asc' },
    });
    return rows.map(toDomain);
  }

  async insertMissingGrants(tx: TenantTx, grants: readonly RolePermission[]): Promise<number> {
    if (grants.length === 0) return 0;
    const result = await tx.rolePermission.createMany({
      data: grants.map((grant) => ({ ...grant })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async list(tx: TenantTx, filter: RoleListFilter): Promise<Role[]> {
    const search = filter.search?.trim();
    const rows = await tx.role.findMany({
      where: {
        ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { key: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<Role | null> {
    const row = await tx.role.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByName(tx: TenantTx, name: string, excludingId?: string): Promise<Role | null> {
    // `mode: insensitive` pré-filtra; a comparação final segue o índice `lower(name)`.
    const rows = await tx.role.findMany({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(excludingId === undefined ? {} : { id: { not: excludingId } }),
      },
    });
    const row = rows.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    return row === undefined ? null : toDomain(row);
  }

  async namesAndKeys(tx: TenantTx): Promise<{ names: string[]; keys: string[] }> {
    const rows = await tx.role.findMany({ select: { name: true, key: true } });
    return { names: rows.map((row) => row.name), keys: rows.map((row) => row.key) };
  }

  async insert(tx: TenantTx, role: Role): Promise<void> {
    try {
      await tx.role.create({ data: { ...role } });
    } catch (error) {
      throw isUniqueViolation(error) ? new RoleAlreadyExistsError() : error;
    }
  }

  async update(tx: TenantTx, role: Role, expectedVersion: number): Promise<void> {
    try {
      await updateVersioned({ aggregateType: 'Role', aggregateId: role.id, expectedVersion }, () =>
        tx.role.updateMany({
          where: { id: role.id, version: expectedVersion },
          data: {
            name: role.name,
            description: role.description,
            allowExternalAssignment: role.allowExternalAssignment,
            isActive: role.isActive,
            updatedAt: role.updatedAt,
            updatedById: role.updatedById,
            version: { increment: 1 },
          },
        }),
      );
    } catch (error) {
      throw isUniqueViolation(error) ? new RoleAlreadyExistsError() : error;
    }
  }

  async permissionsOf(tx: TenantTx, roleId: string): Promise<PermissionCode[]> {
    const rows = await tx.rolePermission.findMany({
      where: { roleId },
      select: { permissionCode: true },
    });
    return codes(rows);
  }

  async removeGrants(
    tx: TenantTx,
    roleId: string,
    removed: readonly PermissionCode[],
  ): Promise<void> {
    if (removed.length === 0) return;
    await tx.rolePermission.deleteMany({
      where: { roleId, permissionCode: { in: [...removed] } },
    });
  }

  async grantsByKeys(tx: TenantTx, keys: readonly string[]): Promise<RoleGrants[]> {
    if (keys.length === 0) return [];
    const rows = await tx.role.findMany({
      where: { key: { in: [...keys] } },
      select: { key: true, isActive: true, permissions: { select: { permissionCode: true } } },
    });
    return rows.map((row) => ({
      key: row.key,
      isActive: row.isActive,
      permissions: codes(row.permissions),
    }));
  }
}

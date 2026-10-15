import { Injectable } from '@nestjs/common';

import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type { RoleRepository } from '../application/ports.js';
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

/**
 * `roles`/`role_permissions` no PostgreSQL (US-094): no `tx` do caso de uso, sob a RLS do tenant e
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
}

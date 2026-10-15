import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { RoleRepository } from '../application/ports.js';
import type { Role, RolePermission } from '../domain/role.js';

/**
 * Perfis em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`), unicidade de
 * `key` por tenant e de concessão por `(tenant, perfil, permissão)`.
 */
@Injectable()
export class InMemoryRoleRepository implements RoleRepository {
  private readonly roles = new Map<string, Role>();
  private readonly grants = new Map<string, RolePermission>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  insertMissing(_tx: TenantTx, roles: readonly Role[]): Promise<Role[]> {
    const tenantId = this.tenantId();
    const created: Role[] = [];
    for (const role of roles) {
      if (role.tenantId !== tenantId) throw new Error('Perfil de outro tenant.');
      const taken = [...this.roles.values()].some(
        (row) => row.tenantId === tenantId && row.key === role.key,
      );
      if (taken) continue;
      this.roles.set(role.id, role);
      created.push(role);
    }
    return Promise.resolve(created);
  }

  findByKeys(_tx: TenantTx, keys: readonly string[]): Promise<Role[]> {
    const tenantId = this.tenantId();
    return Promise.resolve(
      [...this.roles.values()]
        .filter((role) => role.tenantId === tenantId && keys.includes(role.key))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  }

  insertMissingGrants(_tx: TenantTx, grants: readonly RolePermission[]): Promise<number> {
    const tenantId = this.tenantId();
    let count = 0;
    for (const grant of grants) {
      if (grant.tenantId !== tenantId) throw new Error('Concessão de outro tenant.');
      const key = `${grant.tenantId}|${grant.roleId}|${grant.permissionCode}`;
      if (this.grants.has(key)) continue;
      this.grants.set(key, grant);
      count += 1;
    }
    return Promise.resolve(count);
  }

  /** Concessões do tenant do contexto (asserções dos testes). */
  grantsOfTenant(tenantId: string): RolePermission[] {
    return [...this.grants.values()].filter((grant) => grant.tenantId === tenantId);
  }

  /** Perfis do tenant (asserções dos testes). */
  rolesOfTenant(tenantId: string): Role[] {
    return [...this.roles.values()].filter((role) => role.tenantId === tenantId);
  }
}

import type { PermissionCode } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { RoleAlreadyExistsError } from '../application/ports.js';
import type {
  RoleAssignmentCounter,
  RoleGrants,
  RoleListFilter,
  RoleRepository,
} from '../application/ports.js';
import type { Role, RolePermission } from '../domain/role.js';

/**
 * Perfis em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`), unicidade de
 * `key` e de `lower(name)` por tenant, de concessão por `(tenant, perfil, permissão)` e versão
 * otimista no `update`.
 */
@Injectable()
export class InMemoryRoleRepository implements RoleRepository {
  private readonly roles = new Map<string, Role>();
  private readonly grants = new Map<string, RolePermission>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private ofTenant(): Role[] {
    const tenantId = this.tenantId();
    return [...this.roles.values()].filter((role) => role.tenantId === tenantId);
  }

  private conflicts(role: Role): boolean {
    return [...this.roles.values()].some(
      (row) =>
        row.tenantId === role.tenantId &&
        row.id !== role.id &&
        (row.key === role.key || row.name.toLowerCase() === role.name.toLowerCase()),
    );
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
    return Promise.resolve(
      this.ofTenant()
        .filter((role) => keys.includes(role.key))
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

  list(_tx: TenantTx, filter: RoleListFilter): Promise<Role[]> {
    const search = filter.search?.trim().toLowerCase();
    return Promise.resolve(
      this.ofTenant()
        .filter((role) => filter.isActive === undefined || role.isActive === filter.isActive)
        .filter(
          (role) =>
            !search ||
            role.name.toLowerCase().includes(search) ||
            role.key.toLowerCase().includes(search),
        )
        .sort(
          (a, b) =>
            Number(b.isSystem) - Number(a.isSystem) ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
        ),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<Role | null> {
    return Promise.resolve(this.ofTenant().find((role) => role.id === id) ?? null);
  }

  findByName(_tx: TenantTx, name: string, excludingId?: string): Promise<Role | null> {
    return Promise.resolve(
      this.ofTenant().find(
        (role) => role.id !== excludingId && role.name.toLowerCase() === name.toLowerCase(),
      ) ?? null,
    );
  }

  namesAndKeys(): Promise<{ names: string[]; keys: string[] }> {
    const roles = this.ofTenant();
    return Promise.resolve({
      names: roles.map((role) => role.name),
      keys: roles.map((role) => role.key),
    });
  }

  insert(_tx: TenantTx, role: Role): Promise<void> {
    if (role.tenantId !== this.tenantId()) throw new Error('Perfil de outro tenant.');
    if (this.conflicts(role)) return Promise.reject(new RoleAlreadyExistsError());
    this.roles.set(role.id, role);
    return Promise.resolve();
  }

  update(_tx: TenantTx, role: Role, expectedVersion: number): Promise<void> {
    const current = this.ofTenant().find((row) => row.id === role.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({ aggregateType: 'Role', aggregateId: role.id, expectedVersion }),
      );
    }
    if (this.conflicts(role)) return Promise.reject(new RoleAlreadyExistsError());
    this.roles.set(role.id, { ...role, key: current.key, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  permissionsOf(_tx: TenantTx, roleId: string): Promise<PermissionCode[]> {
    return Promise.resolve(this.codesOf(this.tenantId(), roleId));
  }

  removeGrants(_tx: TenantTx, roleId: string, codes: readonly PermissionCode[]): Promise<void> {
    const tenantId = this.tenantId();
    for (const code of codes) this.grants.delete(`${tenantId}|${roleId}|${code}`);
    return Promise.resolve();
  }

  grantsByKeys(_tx: TenantTx, keys: readonly string[]): Promise<RoleGrants[]> {
    const tenantId = this.tenantId();
    return Promise.resolve(
      this.ofTenant()
        .filter((role) => keys.includes(role.key))
        .map((role) => ({
          key: role.key,
          isActive: role.isActive,
          permissions: this.codesOf(tenantId, role.id),
        })),
    );
  }

  private codesOf(tenantId: string | null, roleId: string): PermissionCode[] {
    return [...this.grants.values()]
      .filter((grant) => grant.tenantId === tenantId && grant.roleId === roleId)
      .map((grant) => grant.permissionCode)
      .sort((a, b) => a.localeCompare(b));
  }

  /** Semeia perfis e concessões fora de requisição (Background dos testes). */
  seed(roles: readonly Role[], grants: readonly RolePermission[]): void {
    for (const role of roles) this.roles.set(role.id, role);
    for (const grant of grants) {
      this.grants.set(`${grant.tenantId}|${grant.roleId}|${grant.permissionCode}`, grant);
    }
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

/** Contagem de vínculos ativos configurável nos testes (FA-04); padrão 0. */
export class StubRoleAssignmentCounter implements RoleAssignmentCounter {
  constructor(private readonly counts: Readonly<Record<string, number>> = {}) {}

  countActive(_tx: TenantTx, roleIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return Promise.resolve(new Map(roleIds.map((id) => [id, this.counts[id] ?? 0])));
  }
}

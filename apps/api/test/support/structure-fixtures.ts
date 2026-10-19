// Carga de estrutura para os testes de rota em memória (US-102): órgãos (`tenancy`) e lotações
// (`identity`) dos adaptadores em memória da API de teste. Fica fora de `src/modules` porque os
// specs de um módulo não importam internos de outro (DEC-041 · dependency-cruiser).
import {
  DEFAULT_ROLES,
  defaultGrants,
  seedDefaultRoles,
} from '#modules/access/domain/default-roles.js';
import type { RoleAssignment } from '#modules/access/domain/role-assignment.js';
import { createRole } from '#modules/access/domain/role-management.js';
import { grantPermission } from '#modules/access/domain/role.js';
import type { Role } from '#modules/access/domain/role.js';
import { InMemoryRoleRepository } from '#modules/access/infrastructure/in-memory-role.repository.js';
import { InMemoryRoleAssignmentRepository } from '#modules/access/infrastructure/role-assignment.repository.js';
import { IDENTITY_REPOSITORY } from '#modules/identity/application/ports.js';
import type { InMemoryIdentityRepository } from '#modules/identity/infrastructure/in-memory-identity.repositories.js';
import { createDepartment } from '#modules/organization/domain/department.js';
import type { Department } from '#modules/organization/domain/department.js';
import { InMemoryDepartmentRepository } from '#modules/organization/infrastructure/in-memory-department.repository.js';
import { InMemoryProcessRuntimeStore } from '#modules/process/infrastructure/process-runtime.readers.js';
import { createOrganization } from '#modules/tenancy/domain/organization.js';
import { InMemoryOrganizationRepository } from '#modules/tenancy/infrastructure/in-memory-organization.repository.js';
import { newId } from '#shared/database/ids.js';

import type { TestApi } from './api-test-app.js';

export interface SeedOrganization {
  readonly tenantId: string;
  readonly id: string;
  readonly shortName: string;
  /** 14 dígitos, sem máscara. */
  readonly cnpj: string;
  readonly isActive?: boolean;
}

/** Órgãos no repositório em memória do `tenancy`. */
export function seedOrganizations(api: TestApi, ...organizations: readonly SeedOrganization[]) {
  const repository = api.app.get(InMemoryOrganizationRepository, { strict: false });
  const now = new Date('2026-10-15T12:00:00.000Z');
  repository.seed(
    ...organizations.map((organization) => ({
      ...createOrganization(
        {
          name: `Órgão ${organization.shortName}`,
          shortName: organization.shortName,
          cnpj: organization.cnpj,
          type: 'DIRECT_ADMINISTRATION',
        },
        { id: organization.id, tenantId: organization.tenantId, now, userId: null },
      ),
      isActive: organization.isActive ?? true,
    })),
  );
}

/** Lota o vínculo na unidade (no banco, `membership_departments`). */
export function assignDepartment(api: TestApi, membershipId: string, departmentId: string): void {
  const identity = api.app.get<InMemoryIdentityRepository>(IDENTITY_REPOSITORY, { strict: false });
  identity.assignDepartment(membershipId, departmentId);
}

/** Usuário ativo com vínculo ATIVO no tenant, sem perfis (US-072: membros de unidade nos testes). */
export function seedActiveMember(
  api: TestApi,
  user: { readonly id: string; readonly name: string; readonly email: string },
  membership: { readonly id: string; readonly tenantId: string },
): void {
  const identity = api.app.get<InMemoryIdentityRepository>(IDENTITY_REPOSITORY, { strict: false });
  identity.seedActiveMember(user, membership);
}

/** Repositório em memória de perfis e concessões do `access` (specs de outros módulos não o importam). */
export function roleRepositoryOf(api: TestApi): InMemoryRoleRepository {
  return api.app.get(InMemoryRoleRepository, { strict: false });
}

/** Perfil customizado com as permissões dadas no repositório em memória do `access` (US-011). */
export function seedCustomRole(
  api: TestApi,
  tenantId: string,
  name: string,
  permissionCodes: readonly string[],
): Role {
  const now = new Date('2026-10-15T12:00:00.000Z');
  const role = createRole({ name }, { id: newId(), tenantId, now, userId: null });
  roleRepositoryOf(api).seed(
    [role],
    permissionCodes.map((code) => grantPermission(role, code, { id: newId(), now, userId: null })),
  );
  return role;
}

/** Perfis padrão do tenant no repositório em memória do `access` (US-091: perfil inicial). */
export function seedDefaultRolesOf(api: TestApi, tenantId: string): Map<string, Role> {
  const repository = api.app.get(InMemoryRoleRepository, { strict: false });
  const now = new Date('2026-10-15T12:00:00.000Z');
  const roles = seedDefaultRoles(tenantId, now, newId).map((seeded) => seeded.role);
  repository.seed(roles, defaultGrants(roles, DEFAULT_ROLES, now, newId));
  return new Map(roles.map((role) => [role.key, role]));
}

/** Unidade no repositório em memória do `organization` (US-091: lotação do convite). */
export function seedDepartment(
  api: TestApi,
  department: {
    readonly tenantId: string;
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly isActive?: boolean;
    /** Unidade-mãe já semeada (US-097: escopos com subárvore); padrão = raiz do órgão. */
    readonly parent?: Pick<Department, 'id' | 'path' | 'depth'>;
    /** Titular e substituto (US-056: fila da unidade e aprovações `DEPARTMENT_HEAD`). */
    readonly headUserId?: string | null;
    readonly deputyUserId?: string | null;
  },
): Department {
  const repository = api.app.get(InMemoryDepartmentRepository, { strict: false });
  const seeded: Department = {
    ...createDepartment(
      { organizationId: department.organizationId, type: 'SECTOR', name: department.name },
      {
        id: department.id,
        tenantId: department.tenantId,
        parent: department.parent ?? null,
        now: new Date('2026-10-15T12:00:00.000Z'),
        userId: null,
      },
    ),
    isActive: department.isActive ?? true,
    ...(department.headUserId === undefined ? {} : { headUserId: department.headUserId }),
    ...(department.deputyUserId === undefined ? {} : { deputyUserId: department.deputyUserId }),
  };
  repository.seed(seeded);
  return seeded;
}

/** Atribuições gravadas (`role_assignments` em memória): a inicial do convite e as da US-096. */
export function roleAssignmentsOf(api: TestApi): readonly RoleAssignment[] {
  return api.app.get(InMemoryRoleAssignmentRepository, { strict: false }).assignments;
}

/**
 * Atribuição vigente de perfil (`role_assignments` em memória) — US-092: POL-12 conta os vínculos
 * com o `ADMIN_ORGAO` atribuído; US-096: escopo e vigência informáveis.
 */
export function assignRole(
  api: TestApi,
  assignment: {
    readonly tenantId: string;
    readonly membershipId: string;
    readonly roleId: string;
  } & Partial<RoleAssignment>,
): RoleAssignment {
  const repository = api.app.get(InMemoryRoleAssignmentRepository, { strict: false });
  const at = new Date('2026-01-01T00:00:00.000Z');
  const record: RoleAssignment = {
    id: newId(),
    scopeType: 'TENANT',
    scopeOrganizationId: null,
    scopeDepartmentId: null,
    includeSubtree: true,
    validFrom: at,
    validUntil: null,
    grantedById: '0192a000-0000-7000-8000-0000000000a4',
    reason: null,
    revokedAt: null,
    revokedById: null,
    revocationReason: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...assignment,
  };
  repository.assignments.push(record);
  return record;
}

/** Runtime de processos em memória (US-041/US-097): o agregado real chega com a US-001. */
export function processRuntimeStore(api: TestApi): InMemoryProcessRuntimeStore {
  return api.app.get(InMemoryProcessRuntimeStore, { strict: false });
}

// Carga de estrutura para os testes de rota em memória (US-102): órgãos (`tenancy`) e lotações
// (`identity`) dos adaptadores em memória da API de teste. Fica fora de `src/modules` porque os
// specs de um módulo não importam internos de outro (DEC-041 · dependency-cruiser).
import type { InitialRoleAssignment } from '#modules/access/application/ports.js';
import {
  DEFAULT_ROLES,
  defaultGrants,
  seedDefaultRoles,
} from '#modules/access/domain/default-roles.js';
import type { Role } from '#modules/access/domain/role.js';
import { InMemoryRoleRepository } from '#modules/access/infrastructure/in-memory-role.repository.js';
import { InMemoryRoleAssignmentWriter } from '#modules/access/infrastructure/role-assignment.writer.js';
import { IDENTITY_REPOSITORY } from '#modules/identity/application/ports.js';
import type { InMemoryIdentityRepository } from '#modules/identity/infrastructure/in-memory-identity.repositories.js';
import { createDepartment } from '#modules/organization/domain/department.js';
import { InMemoryDepartmentRepository } from '#modules/organization/infrastructure/in-memory-department.repository.js';
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
  },
): void {
  const repository = api.app.get(InMemoryDepartmentRepository, { strict: false });
  repository.seed({
    ...createDepartment(
      { organizationId: department.organizationId, type: 'SECTOR', name: department.name },
      {
        id: department.id,
        tenantId: department.tenantId,
        parent: null,
        now: new Date('2026-10-15T12:00:00.000Z'),
        userId: null,
      },
    ),
    isActive: department.isActive ?? true,
  });
}

/** Atribuições iniciais gravadas pelo convite (`role_assignments` em memória). */
export function roleAssignmentsOf(api: TestApi): readonly InitialRoleAssignment[] {
  return api.app.get(InMemoryRoleAssignmentWriter, { strict: false }).assignments;
}

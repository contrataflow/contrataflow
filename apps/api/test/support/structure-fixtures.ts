// Carga de estrutura para os testes de rota em memória (US-102): órgãos (`tenancy`) e lotações
// (`identity`) dos adaptadores em memória da API de teste. Fica fora de `src/modules` porque os
// specs de um módulo não importam internos de outro (DEC-041 · dependency-cruiser).
import { IDENTITY_REPOSITORY } from '#modules/identity/application/ports.js';
import type { InMemoryIdentityRepository } from '#modules/identity/infrastructure/in-memory-identity.repositories.js';
import { createOrganization } from '#modules/tenancy/domain/organization.js';
import { InMemoryOrganizationRepository } from '#modules/tenancy/infrastructure/in-memory-organization.repository.js';

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

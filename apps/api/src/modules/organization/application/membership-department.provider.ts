import { Inject, Injectable } from '@nestjs/common';

import type {
  DepartmentReference,
  DepartmentReferenceProvider,
  OrganizationReference,
} from '#shared/auth/membership-references.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DEPARTMENT_REPOSITORY } from './department-ports.js';
import type { DepartmentRepository } from './department-ports.js';
import { DepartmentReferences } from './department-references.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { pathIds } from '../domain/department-tree.js';

/**
 * Lado `organization` da porta `MembershipReferences` (US-091): as unidades da lotação do convite
 * e, na atribuição de perfis (US-096), as do escopo com órgão e caminho na árvore e os órgãos —
 * lidos no `tx` do caso de uso (RLS — unidade de outro tenant não volta). Ativa = a unidade e o
 * órgão dela ativos (pré-condição da story: órgão, secretaria e setor ativos). Nas permissões
 * efetivas (US-097), as subárvores dos escopos e as chefias do usuário.
 */
@Injectable()
export class MembershipDepartmentProvider implements DepartmentReferenceProvider {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository,
    private readonly references: DepartmentReferences,
    private readonly tenancy: TenancyFacade,
  ) {}

  async departmentsByIds(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, DepartmentReference>> {
    const found = new Map<string, DepartmentReference>();
    const organizations = new Map<string, boolean>();
    for (const id of new Set(ids)) {
      const department = await this.departments.findById(tx, id);
      if (!department) continue;
      let organizationActive = organizations.get(department.organizationId);
      if (organizationActive === undefined) {
        organizationActive =
          (await this.references.organizationError(tx, department.organizationId)) === null;
        organizations.set(department.organizationId, organizationActive);
      }
      found.set(id, {
        name: department.name,
        isActive: department.isActive && organizationActive,
        organizationId: department.organizationId,
        pathIds: pathIds(department.path),
      });
    }
    return found;
  }

  subtreeIds(
    tx: TenantTx,
    rootIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    return this.departments.subtreeIds(tx, rootIds);
  }

  departmentsHeadedBy(tx: TenantTx, userId: string): Promise<string[]> {
    return this.departments.idsHeadedBy(tx, userId);
  }

  async organizationsByIds(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, OrganizationReference>> {
    const found = new Map<string, OrganizationReference>();
    for (const id of new Set(ids)) {
      const organization = await this.tenancy.organizationReference(tx, id);
      if (organization) found.set(id, organization);
    }
    return found;
  }
}

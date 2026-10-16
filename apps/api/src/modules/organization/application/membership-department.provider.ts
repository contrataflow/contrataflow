import { Inject, Injectable } from '@nestjs/common';

import type {
  DepartmentReference,
  DepartmentReferenceProvider,
} from '#shared/auth/membership-references.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DEPARTMENT_REPOSITORY } from './department-ports.js';
import type { DepartmentRepository } from './department-ports.js';
import { DepartmentReferences } from './department-references.js';

/**
 * Lado `organization` da porta `MembershipReferences` (US-091): as unidades da lotação do convite,
 * lidas no `tx` do caso de uso (RLS — unidade de outro tenant não volta). Ativa = a unidade e o
 * órgão dela ativos (pré-condição da story: órgão, secretaria e setor ativos).
 */
@Injectable()
export class MembershipDepartmentProvider implements DepartmentReferenceProvider {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository,
    private readonly references: DepartmentReferences,
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
      found.set(id, { name: department.name, isActive: department.isActive && organizationActive });
    }
    return found;
  }
}

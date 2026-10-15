import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DEPARTMENT_REPOSITORY } from './department-ports.js';
import type { DepartmentRepository } from './department-ports.js';

/** Unidade vista por quem valida designações de aprovador (US-061 · RN-DOC-07). */
export interface DepartmentForApproval {
  readonly id: string;
  readonly isActive: boolean;
  /** Titular (`headUserId`); `null` = unidade sem titular cadastrado. */
  readonly headUserId: string | null;
}

/**
 * API pública do módulo `organization` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class OrganizationFacade {
  constructor(@Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository) {}

  /**
   * Unidade do tenant da transação (US-102), lida no `tx` do chamador, ou `null` se não existir
   * nele (outro tenant = inexistente).
   */
  async findDepartmentForApproval(
    tx: TenantTx,
    departmentId: string,
  ): Promise<DepartmentForApproval | null> {
    const department = await this.departments.findById(tx, departmentId);
    if (!department) return null;
    return {
      id: department.id,
      isActive: department.isActive,
      headUserId: department.headUserId,
    };
  }
}

import type { FieldError } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DEPARTMENT_REPOSITORY } from './department-ports.js';
import type { DepartmentRepository } from './department-ports.js';
import { organizationRejected, parentRejected } from './department.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { Department } from '../domain/department.js';

/** V-06: mensagem de titular/substituto sem lotação nem escopo na unidade. */
export const STAFF_NOT_ELIGIBLE = 'Esta pessoa não está lotada nem tem escopo sobre a unidade.';

export type StaffField = 'headUserId' | 'deputyUserId';

/** Resultado da conferência da unidade superior: a unidade, ou o erro do campo `parentId`. */
export type ParentCheck =
  | { readonly ok: true; readonly parent: Department | null }
  | { readonly ok: false; readonly error: FieldError };

/**
 * Referências externas da unidade (US-102), sempre lidas no `tx` do caso de uso — de outro tenant é
 * inexistente, sem revelar que existe lá (RN-TEN · api.md §1): órgão (`tenancy`, RN-TEN-44/50),
 * unidade superior do mesmo órgão (RN-TEN-44/46) e titular/substituto (`identity` + `access`,
 * RN-TEN-48).
 */
@Injectable()
export class DepartmentReferences {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepository,
    private readonly tenancy: TenancyFacade,
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
  ) {}

  /** Órgão do tenant e ativo; `null` = válido. */
  async organizationError(tx: TenantTx, organizationId: string): Promise<FieldError | null> {
    const status = await this.tenancy.organizationStatus(tx, organizationId);
    if (status === null) return organizationRejected('NOT_FOUND');
    return status === 'ACTIVE' ? null : organizationRejected('INACTIVE');
  }

  /**
   * Unidade superior (RN-TEN-44/46): `null` = raiz; senão existe no tenant, é do MESMO órgão e
   * está ativa (unidade inativa não recebe novas sub-unidades — RN-TEN-50).
   */
  async checkParent(
    tx: TenantTx,
    organizationId: string,
    parentId: string | null,
  ): Promise<ParentCheck> {
    if (parentId === null) return { ok: true, parent: null };
    const parent = await this.departments.findById(tx, parentId);
    if (parent?.organizationId !== organizationId) {
      return { ok: false, error: parentRejected('NOT_FOUND') };
    }
    if (!parent.isActive) return { ok: false, error: parentRejected('INACTIVE') };
    return { ok: true, parent };
  }

  /**
   * RN-TEN-48 (V-06): cada titular/substituto informado precisa de vínculo `ACTIVE` não expirado no
   * tenant com lotação na própria unidade OU perfil com escopo sobre ela. Sem vínculo no tenant,
   * sem lotação nem escopo → `REFERENCE_NOT_FOUND`; vínculo não ativo → `REFERENCE_INACTIVE`.
   */
  async staffErrors(
    tx: TenantTx,
    departmentId: string,
    staff: readonly { readonly field: StaffField; readonly userId: string }[],
    now: Date,
  ): Promise<FieldError[]> {
    if (staff.length === 0) return [];
    const userIds = [...new Set(staff.map((item) => item.userId))];
    const members = new Map(
      (await this.identity.membersInTenant(tx, userIds)).map((member) => [member.userId, member]),
    );
    const assigned = await this.identity.usersAssignedToDepartment(tx, departmentId, userIds);
    const errors: FieldError[] = [];
    for (const { field, userId } of staff) {
      const member = members.get(userId);
      if (!member) {
        errors.push({ field, code: 'REFERENCE_NOT_FOUND', message: STAFF_NOT_ELIGIBLE });
        continue;
      }
      const active =
        member.status === 'ACTIVE' && (member.expiresAt === null || member.expiresAt > now);
      if (!active) {
        errors.push({
          field,
          code: 'REFERENCE_INACTIVE',
          message: 'O vínculo desta pessoa com a instituição não está ativo.',
        });
        continue;
      }
      if (!assigned.has(userId) && !this.access.rolesCoverAllDepartments(member.roleKeys)) {
        errors.push({ field, code: 'REFERENCE_NOT_FOUND', message: STAFF_NOT_ELIGIBLE });
      }
    }
    return errors;
  }
}

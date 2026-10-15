import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

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
  /**
   * Unidade do tenant da transação, ou `null` se não existir nele. As unidades como registro
   * (`Department`) chegam com a US-102; até lá não há unidade por id e a consulta devolve `null`.
   */
  findDepartmentForApproval(
    _tx: TenantTx,
    _departmentId: string,
  ): Promise<DepartmentForApproval | null> {
    return Promise.resolve(null);
  }
}

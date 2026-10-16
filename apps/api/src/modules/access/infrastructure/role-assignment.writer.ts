import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { InitialRoleAssignment, RoleAssignmentWriter } from '../application/ports.js';

/**
 * `role_assignments` no PostgreSQL (US-091): a atribuição inicial do convite. `skipDuplicates`
 * (`ON CONFLICT DO NOTHING`) torna idempotente o novo convite de um vínculo que já tem a mesma
 * atribuição vigente (índice parcial `role_assignments_active_key`).
 */
@Injectable()
export class PrismaRoleAssignmentWriter implements RoleAssignmentWriter {
  async insertInitial(tx: TenantTx, assignment: InitialRoleAssignment): Promise<void> {
    await tx.roleAssignment.createMany({
      data: [
        {
          id: assignment.id,
          tenantId: assignment.tenantId,
          membershipId: assignment.membershipId,
          roleId: assignment.roleId,
          scopeType: assignment.scopeType,
          includeSubtree: true,
          validFrom: assignment.now,
          grantedById: assignment.grantedById,
          reason: 'Perfil inicial do convite',
          createdAt: assignment.now,
          updatedAt: assignment.now,
          createdById: assignment.grantedById,
          updatedById: assignment.grantedById,
        },
      ],
      skipDuplicates: true,
    });
  }
}

/** Atribuições em memória (testes e modo de identidade fake), isoladas pelo tenant do contexto. */
@Injectable()
export class InMemoryRoleAssignmentWriter implements RoleAssignmentWriter {
  readonly assignments: InitialRoleAssignment[] = [];

  insertInitial(_tx: TenantTx, assignment: InitialRoleAssignment): Promise<void> {
    if (assignment.tenantId !== currentRequestContext()?.tenantId) {
      return Promise.reject(new Error('Atribuição de outro tenant.'));
    }
    const duplicate = this.assignments.some(
      (item) =>
        item.tenantId === assignment.tenantId &&
        item.membershipId === assignment.membershipId &&
        item.roleId === assignment.roleId,
    );
    if (!duplicate) this.assignments.push(assignment);
    return Promise.resolve();
  }
}

import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { OrganizationFacade } from './organization.facade.js';
import { createDepartment } from '../domain/department.js';
import { InMemoryDepartmentRepository } from '../infrastructure/in-memory-department.repository.js';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';
const ORG = '0192a000-0000-7000-8000-0000000100a1';
const HEAD = '0192a000-0000-7000-8000-0000000000a4';
const UNIT = '0192a000-0000-7000-8000-0000000200a1';

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId });
    return fn();
  });
}

describe('OrganizationFacade (US-102)', () => {
  const repository = new InMemoryDepartmentRepository();
  repository.seed(
    createDepartment(
      { organizationId: ORG, type: 'SECRETARIAT', name: 'Secretaria de Obras', headUserId: HEAD },
      { id: UNIT, tenantId: A, parent: null, now: new Date(), userId: null },
    ),
  );
  const facade = new OrganizationFacade(repository);
  const tx = {} as TenantTx;

  it('findDepartmentForApproval: unidade do tenant com situação e titular', async () => {
    await expect(inTenant(A, () => facade.findDepartmentForApproval(tx, UNIT))).resolves.toEqual({
      id: UNIT,
      isActive: true,
      headUserId: HEAD,
    });
  });

  it('findDepartmentForApproval: inexistente ou de outro tenant → null', async () => {
    await expect(inTenant(B, () => facade.findDepartmentForApproval(tx, UNIT))).resolves.toBeNull();
    await expect(inTenant(A, () => facade.findDepartmentForApproval(tx, ORG))).resolves.toBeNull();
  });
});

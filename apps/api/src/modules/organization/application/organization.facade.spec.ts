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
      deputyUserId: null,
    });
  });

  it('findDepartmentForApproval: inexistente ou de outro tenant → null', async () => {
    await expect(inTenant(B, () => facade.findDepartmentForApproval(tx, UNIT))).resolves.toBeNull();
    await expect(inTenant(A, () => facade.findDepartmentForApproval(tx, ORG))).resolves.toBeNull();
  });

  it('departmentsHeadedBy: unidades ativas do tenant em que o usuário é titular (US-041)', async () => {
    await expect(inTenant(A, () => facade.departmentsHeadedBy(tx, HEAD))).resolves.toEqual([UNIT]);
    await expect(inTenant(B, () => facade.departmentsHeadedBy(tx, HEAD))).resolves.toEqual([]);
    await expect(inTenant(A, () => facade.departmentsHeadedBy(tx, ORG))).resolves.toEqual([]);
  });

  it('departmentReferences e departmentNames (US-001): só unidades do tenant da transação', async () => {
    const references = await inTenant(A, () => facade.departmentReferences(tx, [UNIT, ORG, UNIT]));
    expect([...references.values()]).toEqual([
      {
        id: UNIT,
        organizationId: ORG,
        parentId: null,
        type: 'SECRETARIAT',
        name: 'Secretaria de Obras',
        path: `/${UNIT}/`,
        isActive: true,
        headUserId: HEAD,
      },
    ]);
    await expect(inTenant(B, () => facade.departmentNames(tx, [UNIT]))).resolves.toEqual(new Map());
    await expect(inTenant(A, () => facade.departmentNames(tx, [UNIT]))).resolves.toEqual(
      new Map([[UNIT, 'Secretaria de Obras']]),
    );
  });
});

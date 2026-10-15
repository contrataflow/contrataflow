import { describe, expect, it, vi } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { TenancyFacade } from './tenancy.facade.js';
import { createOrganization } from '../domain/organization.js';
import { InMemoryOrganizationRepository } from '../infrastructure/in-memory-organization.repository.js';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';
const ACTIVE = '0192a000-0000-7000-8000-0000000100a1';
const INACTIVE = '0192a000-0000-7000-8000-0000000100a2';

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId });
    return fn();
  });
}

describe('TenancyFacade', () => {
  it('invalida o status do tenant em cache (US-100)', async () => {
    const invalidate = vi.fn(() => Promise.resolve());
    await new TenancyFacade({ invalidate }, {} as never).invalidateTenantStatus('t-1');
    expect(invalidate).toHaveBeenCalledWith('t-1');
  });

  it('organizationStatus (US-102): ativo, inativo ou inexistente no tenant da transação', async () => {
    const organizations = new InMemoryOrganizationRepository();
    const now = new Date();
    const org = (id: string, shortName: string, cnpj: string) =>
      createOrganization(
        { name: `Órgão ${shortName}`, shortName, cnpj, type: 'FUND' },
        { id, tenantId: A, now, userId: null },
      );
    organizations.seed(org(ACTIVE, 'FMS', '11444777000161'), {
      ...org(INACTIVE, 'FIB', '45997418000153'),
      isActive: false,
    });
    const facade = new TenancyFacade({ invalidate: () => Promise.resolve() }, organizations);
    const tx = {} as TenantTx;
    await expect(inTenant(A, () => facade.organizationStatus(tx, ACTIVE))).resolves.toBe('ACTIVE');
    await expect(inTenant(A, () => facade.organizationStatus(tx, INACTIVE))).resolves.toBe(
      'INACTIVE',
    );
    await expect(inTenant(B, () => facade.organizationStatus(tx, ACTIVE))).resolves.toBeNull();
  });
});

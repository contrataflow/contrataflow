import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import { OrganizationFacade } from './organization.facade.js';

describe('OrganizationFacade', () => {
  it('findDepartmentForApproval: sem unidades como registro (US-102), nada é encontrado', async () => {
    await expect(
      new OrganizationFacade().findDepartmentForApproval({} as TenantTx, 'qualquer'),
    ).resolves.toBeNull();
  });
});

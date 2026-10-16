import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import { describe, expect, it, vi } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { TenancyFacade } from './tenancy.facade.js';
import { createOrganization } from '../domain/organization.js';
import { SettingsRegistry } from '../domain/settings-registry.js';
import { InMemoryOrganizationRepository } from '../infrastructure/in-memory-organization.repository.js';
import { InMemoryTenantSettingsRepository } from '../infrastructure/in-memory-tenant-settings.repository.js';

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

const registry = new SettingsRegistry([SETTING_DEFINITIONS]);

describe('TenancyFacade', () => {
  it('invalida o status do tenant em cache (US-100)', async () => {
    const invalidate = vi.fn(() => Promise.resolve());
    await new TenancyFacade(
      { invalidate },
      {} as never,
      {} as never,
      registry,
    ).invalidateTenantStatus('t-1');
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
    const facade = new TenancyFacade(
      { invalidate: () => Promise.resolve() },
      organizations,
      {} as never,
      registry,
    );
    const tx = {} as TenantTx;
    await expect(inTenant(A, () => facade.organizationStatus(tx, ACTIVE))).resolves.toBe('ACTIVE');
    await expect(inTenant(A, () => facade.organizationStatus(tx, INACTIVE))).resolves.toBe(
      'INACTIVE',
    );
    await expect(inTenant(B, () => facade.organizationStatus(tx, ACTIVE))).resolves.toBeNull();
  });

  it('organizationSummary e primaryOrganizationId (US-001): órgão do processo no tenant da transação', async () => {
    const organizations = new InMemoryOrganizationRepository();
    organizations.seed(
      createOrganization(
        { name: 'Prefeitura Municipal', shortName: 'PMSJ', cnpj: '11444777000161', type: 'FUND' },
        { id: ACTIVE, tenantId: A, now: new Date(), userId: null },
      ),
    );
    organizations.setPrimary(A, ACTIVE);
    const facade = new TenancyFacade(
      { invalidate: () => Promise.resolve() },
      organizations,
      {} as never,
      registry,
    );
    const tx = {} as TenantTx;
    await expect(inTenant(A, () => facade.organizationSummary(tx, ACTIVE))).resolves.toEqual({
      id: ACTIVE,
      name: 'Prefeitura Municipal',
      shortName: 'PMSJ',
      isActive: true,
    });
    await expect(inTenant(B, () => facade.organizationSummary(tx, ACTIVE))).resolves.toBeNull();
    await expect(inTenant(A, () => facade.primaryOrganizationId(tx))).resolves.toBe(ACTIVE);
  });

  it('settingValues (US-001): valor gravado do tenant ou o padrão do registro', async () => {
    let tenant: string | null = A;
    const settings = new InMemoryTenantSettingsRepository(() => tenant);
    settings.seed(A, 'process.requireInternalCode', true);
    settings.seed(B, 'process.duplicateDetectionWindowMinutes', 0);
    const facade = new TenancyFacade(
      { invalidate: () => Promise.resolve() },
      {} as never,
      settings,
      registry,
    );
    const keys = ['process.requireInternalCode', 'process.duplicateDetectionWindowMinutes'];
    const tx = {} as TenantTx;
    expect(Object.fromEntries(await facade.settingValues(tx, keys))).toEqual({
      'process.requireInternalCode': true,
      'process.duplicateDetectionWindowMinutes': 10,
    });
    tenant = B;
    expect(
      Object.fromEntries(await facade.settingValues(tx, [...keys, 'chave.inexistente'])),
    ).toEqual({
      'process.requireInternalCode': false,
      'process.duplicateDetectionWindowMinutes': 0,
      'chave.inexistente': null,
    });
  });
});

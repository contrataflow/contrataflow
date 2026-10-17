import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import { SupplierUsageRegistry } from './supplier-usage.registry.js';
import { SupplierFacade } from './supplier.facade.js';

const TX = {} as TenantTx;

describe('SupplierFacade', () => {
  it('sem provedor registrado, nenhum fornecedor está em uso', async () => {
    const registry = new SupplierUsageRegistry();
    expect(new SupplierFacade(registry)).toBeInstanceOf(SupplierFacade);
    expect(await registry.isInUse(TX, 'qualquer')).toBe(false);
  });

  it('o uso informado por qualquer provedor registrado vale (RN-PRICE-19)', async () => {
    const registry = new SupplierUsageRegistry();
    const facade = new SupplierFacade(registry);
    const noUse = { isInUse: () => Promise.resolve(false) };
    const inUse = { isInUse: (_tx: TenantTx, id: string) => Promise.resolve(id === 'usado') };

    facade.registerUsageProvider(noUse);
    facade.registerUsageProvider(inUse);
    facade.registerUsageProvider(inUse);

    expect(await registry.isInUse(TX, 'usado')).toBe(true);
    expect(await registry.isInUse(TX, 'livre')).toBe(false);
  });
});

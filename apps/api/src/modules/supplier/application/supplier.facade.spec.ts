import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import type { SupplierRepository } from './supplier-ports.js';
import { SupplierUsageRegistry } from './supplier-usage.registry.js';
import { SupplierFacade } from './supplier.facade.js';
import type { Supplier } from '../domain/supplier.js';

const TX = {} as TenantTx;

/** Repositório com `findById` sobre um mapa (a RLS e a exclusão lógica já filtraram). */
function repositoryOf(
  ...suppliers: Pick<Supplier, 'id' | 'legalName' | 'documentNumber' | 'isActive'>[]
) {
  const rows = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  return {
    findById: (_tx: TenantTx, id: string) => Promise.resolve(rows.get(id) ?? null),
  } as unknown as SupplierRepository;
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('esperava ApiError');
}

describe('SupplierFacade', () => {
  it('sem provedor registrado, nenhum fornecedor está em uso', async () => {
    const registry = new SupplierUsageRegistry();
    expect(new SupplierFacade(registry, repositoryOf())).toBeInstanceOf(SupplierFacade);
    expect(await registry.isInUse(TX, 'qualquer')).toBe(false);
  });

  it('o uso informado por qualquer provedor registrado vale (RN-PRICE-19)', async () => {
    const registry = new SupplierUsageRegistry();
    const facade = new SupplierFacade(registry, repositoryOf());
    const noUse = { isInUse: () => Promise.resolve(false) };
    const inUse = { isInUse: (_tx: TenantTx, id: string) => Promise.resolve(id === 'usado') };

    facade.registerUsageProvider(noUse);
    facade.registerUsageProvider(inUse);
    facade.registerUsageProvider(inUse);

    expect(await registry.isInUse(TX, 'usado')).toBe(true);
    expect(await registry.isInUse(TX, 'livre')).toBe(false);
  });

  it('assertActive (RN-PRICE-22 · V-03): inexistente/de outro tenant → REFERENCE_NOT_FOUND; inativo → REFERENCE_INACTIVE', async () => {
    const facade = new SupplierFacade(
      new SupplierUsageRegistry(),
      repositoryOf(
        {
          id: 'ativo',
          legalName: 'Construtora XYZ',
          documentNumber: '11.222.333/0001-81',
          isActive: true,
        },
        { id: 'inativo', legalName: 'Antiga', documentNumber: '1', isActive: false },
      ),
    );
    expect(await facade.assertActive(TX, 'ativo', 'supplierId')).toEqual({
      id: 'ativo',
      legalName: 'Construtora XYZ',
      documentNumber: '11.222.333/0001-81',
      isActive: true,
    });
    const missing = await rejection(facade.assertActive(TX, 'outro', 'supplierId'));
    expect(missing.code).toBe('VALIDATION_ERROR');
    expect(missing.errors.map((error) => [error.field, error.code])).toEqual([
      ['supplierId', 'REFERENCE_NOT_FOUND'],
    ]);
    const inactive = await rejection(facade.assertActive(TX, 'inativo', 'supplierId'));
    expect(inactive.errors.map((error) => error.code)).toEqual(['REFERENCE_INACTIVE']);

    const summaries = await facade.summariesOf(TX, ['ativo', 'inativo', 'outro', 'ativo']);
    expect([...summaries.keys()]).toEqual(['ativo', 'inativo']);
  });
});

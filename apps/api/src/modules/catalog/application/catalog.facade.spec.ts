import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { ApiError } from '#shared/errors/api-error.js';

import { CatalogFacade } from './catalog.facade.js';
import type { CatalogItem } from '../domain/catalog-item.js';
import { InMemoryCatalogItemRepository } from '../infrastructure/in-memory-catalog-item.repository.js';

const A = '0192c000-0000-7000-8000-00000000a501';
const B = '0192c000-0000-7000-8000-00000000a502';
const NOW = new Date('2026-10-15T12:00:00.000Z');

function item(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    id: '0192c000-0000-7000-8000-000000a50101',
    tenantId: A,
    catalogType: 'MODALITY',
    code: 'PREGAO',
    label: 'Pregão',
    description: null,
    isSystem: true,
    isActive: true,
    sortOrder: 1,
    parentId: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

const ACTIVE = item({});
const INACTIVE = item({
  id: '0192c000-0000-7000-8000-000000a50102',
  code: 'LEILAO',
  isActive: false,
});
const FROM_B = item({ id: '0192c000-0000-7000-8000-000000a50103', tenantId: B, code: 'LEILAO' });
const RISK = item({
  id: '0192c000-0000-7000-8000-000000a50104',
  catalogType: 'RISK_CATEGORY',
  code: 'PRAZO',
});

function setup() {
  const repository = new InMemoryCatalogItemRepository();
  repository.seed(ACTIVE, INACTIVE, FROM_B, RISK);
  const facade = new CatalogFacade(repository);
  const inTenantA = <T>(work: (tx: Parameters<CatalogFacade['assertActive']>[0]) => Promise<T>) =>
    runWithRequestContext({ correlationId: 'corr-facade', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId: A,
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Teste' },
      });
      return runSimulatedTransaction(work);
    });
  return { facade, inTenantA };
}

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Esperava um ApiError.');
}

describe('CatalogFacade.assertActive (RN-TEN-61 · ponto único de validação de referência)', () => {
  it('aceita item ativo do catálogo e do tenant esperados', async () => {
    const { facade, inTenantA } = setup();
    const ref = await inTenantA((tx) =>
      facade.assertActive(tx, 'MODALITY', ACTIVE.id, 'modalityId'),
    );
    expect(ref).toEqual({
      id: ACTIVE.id,
      catalogType: 'MODALITY',
      code: 'PREGAO',
      label: 'Pregão',
      isActive: true,
    });
  });

  it('item inativo → REFERENCE_INACTIVE no campo informado', async () => {
    const { facade, inTenantA } = setup();
    const error = await errorOf(
      inTenantA((tx) => facade.assertActive(tx, 'MODALITY', INACTIVE.id, 'modalityId')),
    );
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.errors).toEqual([
      expect.objectContaining({ field: 'modalityId', code: 'REFERENCE_INACTIVE' }),
    ]);
  });

  it.each([
    ['inexistente', '0192c000-0000-7000-8000-000000a50199'],
    ['de outro tenant', FROM_B.id],
    ['de outro catálogo', RISK.id],
  ])('item %s → REFERENCE_NOT_FOUND (indistinguíveis)', async (_label, id) => {
    const { facade, inTenantA } = setup();
    const error = await errorOf(
      inTenantA((tx) => facade.assertActive(tx, 'MODALITY', id, 'modalityId')),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({ field: 'modalityId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
  });
});

describe('CatalogFacade.find', () => {
  it('devolve o item mesmo inativo (registro existente continua exibindo-o)', async () => {
    const { facade, inTenantA } = setup();
    expect(await inTenantA((tx) => facade.find(tx, INACTIVE.id))).toMatchObject({
      isActive: false,
    });
    expect(await inTenantA((tx) => facade.find(tx, FROM_B.id))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';
import type { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';

import type { PriceResearchRepository, PriceSourceRepository } from './ports.js';
import { PriceResearchFacade } from './price-research.facade.js';
import type { SupplierFacade } from '../../supplier/application/supplier.facade.js';

const tx = {} as TenantTx;

const RESEARCH = { id: 'r1', processId: 'p1' };
const ITEM = { id: 'i1', priceResearchId: 'r1', processItemId: 'pi1' };

function facade(options: { supplierName?: string | null } = {}) {
  const researches = {
    findItem: (_tx: TenantTx, id: string) => Promise.resolve(id === ITEM.id ? ITEM : null),
    findById: (_tx: TenantTx, id: string) => Promise.resolve(id === RESEARCH.id ? RESEARCH : null),
  } as unknown as PriceResearchRepository;
  const sources = {
    findQuotation: (_tx: TenantTx, id: string) =>
      Promise.resolve(id === 'q1' ? { id: 'q1', priceSourceId: 's1' } : null),
    findSource: (_tx: TenantTx, id: string) =>
      Promise.resolve(
        id === 's1'
          ? {
              id: 's1',
              description: 'Tabela SINAPI',
              supplierId:
                options.supplierName === undefined || options.supplierName === null ? null : 'f1',
            }
          : null,
      ),
  } as unknown as PriceSourceRepository;
  const processItems = {
    listActive: () => Promise.resolve([{ id: 'pi1', sequence: 4 }]),
  } as unknown as ProcessItemCatalogRegistry;
  const suppliers = {
    summariesOf: () =>
      Promise.resolve(new Map([['f1', { id: 'f1', legalName: options.supplierName ?? '' }]])),
  } as unknown as SupplierFacade;
  return new PriceResearchFacade(researches, sources, processItems, suppliers);
}

describe('PriceResearchFacade', () => {
  it('priceItemSequences: sequência do item do processo; linha desconhecida fica de fora', async () => {
    const result = await facade().priceItemSequences(tx, ['i1', 'x']);
    expect([...result]).toEqual([['i1', { sequence: 4 }]]);
  });

  it('quotationSourceLabels: razão social do fornecedor, senão a descrição da fonte', async () => {
    const withSupplier = await facade({ supplierName: 'Fornecedor XPTO' }).quotationSourceLabels(
      tx,
      ['q1', 'x'],
    );
    expect([...withSupplier]).toEqual([['q1', { sourceLabel: 'Fornecedor XPTO' }]]);
    const withoutSupplier = await facade().quotationSourceLabels(tx, ['q1']);
    expect([...withoutSupplier]).toEqual([['q1', { sourceLabel: 'Tabela SINAPI' }]]);
  });
});

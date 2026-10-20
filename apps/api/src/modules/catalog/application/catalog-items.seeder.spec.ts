import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantSeedContext } from '#shared/tenancy/tenant-seeding.js';

import { CatalogItemsSeeder } from './catalog-items.seeder.js';
import { CATALOG_SEED_TOTAL } from '../domain/catalog-seed.js';
import {
  InMemoryCatalogItemRepository,
  InMemoryCatalogTransactions,
} from '../infrastructure/in-memory-catalog-item.repository.js';

const TENANT = '0192c000-0000-7000-8000-00000000a401';
const OTHER = '0192c000-0000-7000-8000-00000000a402';
const NOW = new Date('2026-10-15T12:00:00.000Z');

function setup() {
  const repository = new InMemoryCatalogItemRepository();
  const seeder = new CatalogItemsSeeder(repository, new InMemoryCatalogTransactions(), () => NOW);
  const ctx: TenantSeedContext = { tenantId: TENANT, slug: 'sao-jose', now: NOW, request: null };
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    runWithRequestContext({ correlationId: 'corr-seed-catalog', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Provisionamento' },
      });
      return fn();
    });
  return { repository, seeder, ctx, inTenant };
}

describe('CatalogItemsSeeder (catalog.items — entities.md §7)', () => {
  it('copia os 84 itens de sistema, ativos e ordenados, e fecha a etapa como DONE', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    expect(await inTenant(TENANT, () => seeder.verify(ctx))).toEqual({
      status: 'PENDING',
      details: { items: 0 },
    });

    const result = await inTenant(TENANT, () => seeder.seed(ctx));

    expect(result).toEqual({ created: CATALOG_SEED_TOTAL, skipped: 0 });
    const rows = repository.snapshot();
    expect(rows).toHaveLength(84);
    expect(rows.every((row) => row.isSystem && row.isActive && row.tenantId === TENANT)).toBe(true);
    const modalities = rows
      .filter((row) => row.catalogType === 'MODALITY')
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(modalities.map((row) => [row.code, row.sortOrder]).slice(0, 2)).toEqual([
      ['PREGAO', 1],
      ['CONCORRENCIA', 2],
    ]);
    expect(await inTenant(TENANT, () => seeder.verify(ctx))).toEqual({
      status: 'DONE',
      details: { items: 84 },
    });
  });

  it('reexecução é idempotente e preserva o que o administrador editou', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    await inTenant(TENANT, () => seeder.seed(ctx));
    const pregao = repository.snapshot().find((row) => row.code === 'PREGAO');
    if (!pregao) throw new Error('PREGAO não semeado');
    repository.seed({ ...pregao, label: 'Pregão eletrônico', isActive: false });

    const again = await inTenant(TENANT, () => seeder.seed(ctx));

    expect(again).toEqual({ created: 0, skipped: CATALOG_SEED_TOTAL });
    expect(repository.snapshot()).toHaveLength(84);
    expect(repository.snapshot().find((row) => row.code === 'PREGAO')).toMatchObject({
      label: 'Pregão eletrônico',
      isActive: false,
    });
  });

  it('repõe só o item de sistema que faltar (tenant:seed) e não toca em outro tenant', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    await inTenant(OTHER, () => seeder.seed({ ...ctx, tenantId: OTHER }));
    await inTenant(TENANT, () => seeder.seed(ctx));
    const missing = repository
      .snapshot()
      .find((row) => row.tenantId === TENANT && row.code === 'OBRA');
    if (!missing) throw new Error('OBRA não semeada');
    // Simula catálogo-base novo: tenant sem um dos itens.
    const fresh = new InMemoryCatalogItemRepository();
    fresh.seed(...repository.snapshot().filter((row) => row.id !== missing.id));
    const reseeder = new CatalogItemsSeeder(fresh, new InMemoryCatalogTransactions(), () => NOW);

    expect(await inTenant(TENANT, () => reseeder.verify(ctx))).toMatchObject({ status: 'PENDING' });
    expect(await inTenant(TENANT, () => reseeder.seed(ctx))).toEqual({
      created: 1,
      skipped: CATALOG_SEED_TOTAL - 1,
    });
    expect(await inTenant(TENANT, () => reseeder.verify(ctx))).toMatchObject({ status: 'DONE' });
    expect(fresh.snapshot().filter((row) => row.tenantId === OTHER)).toHaveLength(84);
    expect(seeder.applyToExistingTenants).toBe(true);
    expect(seeder.key).toBe('catalog.items');
  });
});

import { CATALOG_TYPES } from '@contrataflow/types';
import { Inject, Injectable } from '@nestjs/common';

import { newId } from '#shared/database/ids.js';
import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { CATALOG_CLOCK, CATALOG_ITEM_REPOSITORY, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogClock, CatalogItemRepository, CatalogTransactions } from './catalog-ports.js';
import type { CatalogItem } from '../domain/catalog-item.js';
import { CATALOG_SEED, CATALOG_SEED_TOTAL } from '../domain/catalog-seed.js';

/**
 * Seeder `catalog.items` (US-104 · US-099 · entities.md §7): copia o catálogo-base (84 itens de
 * sistema, `isSystem = true`) para o tenant, na `TenantTransaction` do tenant novo. Grava só os
 * itens cujo `(catalogType, code)` ainda não existe, sem tocar no que o administrador editou — logo
 * é idempotente e serve a tenants existentes quando o catálogo-base ganha itens (`tenant:seed`).
 */
@Injectable()
export class CatalogItemsSeeder implements TenantSeeder {
  readonly key = 'catalog.items';
  readonly module = 'catalog';
  readonly version = '2026.10.1';
  readonly dependsOn: readonly string[] = [];
  readonly applyToExistingTenants = true;

  constructor(
    @Inject(CATALOG_ITEM_REPOSITORY) private readonly items: CatalogItemRepository,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) private readonly clock: CatalogClock,
  ) {}

  async seed(ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const now = this.clock();
    const created = await this.transactions.run(async (tx) => {
      const drafts: CatalogItem[] = [];
      for (const catalogType of CATALOG_TYPES) {
        CATALOG_SEED[catalogType].forEach((seed, index) => {
          drafts.push({
            id: newId(),
            tenantId: ctx.tenantId,
            catalogType,
            code: seed.code,
            label: seed.label,
            description: null,
            isSystem: true,
            isActive: true,
            sortOrder: index + 1,
            parentId: null,
            metadata: seed.metadata,
            createdAt: now,
            updatedAt: now,
            createdById: null,
            updatedById: null,
            version: 1,
          });
        });
      }
      return this.items.insertMissing(tx, drafts);
    });
    return { created, skipped: CATALOG_SEED_TOTAL - created };
  }

  async verify(_ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const present = await this.transactions.read((tx) => this.items.systemCodes(tx));
    let found = 0;
    for (const catalogType of CATALOG_TYPES) {
      const codes = present.get(catalogType);
      found += CATALOG_SEED[catalogType].filter((seed) => codes?.has(seed.code)).length;
    }
    return {
      status: found === CATALOG_SEED_TOTAL ? 'DONE' : 'PENDING',
      details: { items: found },
    };
  }
}

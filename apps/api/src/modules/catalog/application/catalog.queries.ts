import type { CatalogType } from '@contrataflow/types';
import type { CatalogItemDto, CatalogItemListQuery } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { CATALOG_ITEM_REPOSITORY, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogItemRepository, CatalogTransactions } from './catalog-ports.js';
import { toCatalogItemDto } from './catalog.view.js';

export interface CatalogItemListResult {
  readonly items: readonly CatalogItemDto[];
  readonly totalItems: number;
}

/**
 * `ListCatalogItemsQuery` — CAT-01 (US-104): capacidade implícita de qualquer vínculo ativo
 * (seletores dos formulários); ordenada por `sortOrder` e `code`, com filtros `isActive` e `q`.
 */
@Injectable()
export class ListCatalogItemsQuery {
  constructor(
    @Inject(CATALOG_ITEM_REPOSITORY) private readonly items: CatalogItemRepository,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
  ) {}

  execute(catalogType: CatalogType, query: CatalogItemListQuery): Promise<CatalogItemListResult> {
    return this.transactions.read(async (tx) => {
      const page = await this.items.list(tx, catalogType, {
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
        ...(query.q === undefined ? {} : { q: query.q }),
        page: query.page,
        pageSize: query.pageSize,
      });
      return { items: page.items.map(toCatalogItemDto), totalItems: page.totalItems };
    });
  }
}

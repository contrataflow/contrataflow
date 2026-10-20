import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PRICE_SOURCE_REPOSITORY } from './ports.js';
import type { PriceSourceRepository } from './ports.js';
import type { SupplierUsageProvider } from '../../supplier/application/supplier.facade.js';

/**
 * Uso do fornecedor pelas fontes de pesquisa (US-026 · RN-PRICE-19): registrado na `SupplierFacade`
 * no `onModuleInit` — enquanto alguma fonte referenciar o fornecedor, a exclusão (SUP-05) é recusada
 * com 409 `SUPPLIER_IN_USE`.
 */
@Injectable()
export class PriceSourceSupplierUsage implements SupplierUsageProvider {
  constructor(@Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository) {}

  isInUse(tx: TenantTx, supplierId: string): Promise<boolean> {
    return this.sources.isSupplierInUse(tx, supplierId);
  }
}

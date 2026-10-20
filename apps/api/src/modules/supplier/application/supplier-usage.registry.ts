import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { SupplierUsageProvider } from './supplier-ports.js';

/**
 * Soma o uso informado por todos os provedores registrados (RN-PRICE-19). Sem provedor — antes da
 * US-026, que cria `PriceSource` — nenhum fornecedor está em uso.
 */
@Injectable()
export class SupplierUsageRegistry {
  private readonly providers: SupplierUsageProvider[] = [];

  register(provider: SupplierUsageProvider): void {
    if (!this.providers.includes(provider)) this.providers.push(provider);
  }

  async isInUse(tx: TenantTx, supplierId: string): Promise<boolean> {
    const uses = await Promise.all(
      this.providers.map((provider) => provider.isInUse(tx, supplierId)),
    );
    return uses.some(Boolean);
  }
}

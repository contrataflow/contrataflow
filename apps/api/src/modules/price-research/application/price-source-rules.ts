import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { PriceSourceTypeRef } from '../../catalog/application/catalog.facade.js';
import type { PriceSourceTypeRules } from '../domain/price-source.js';

/*
 * Regras do tipo de fonte (`PRICE_SOURCE_TYPE`) lidas do catálogo: campos exigidos e validade
 * (US-026 · RN-PRICE-21/26) — usadas nas gravações de fontes/cotações e no recálculo (US-030 ·
 * RN-PRICE-49). Separadas do suporte das fontes para o `PriceCalculationService` usá-las sem ciclo.
 */

/** Regras do tipo para o domínio (sem o que é só exibição). */
export function rulesOf(type: PriceSourceTypeRef): PriceSourceTypeRules {
  return {
    id: type.id,
    code: type.code,
    requiredFields: type.requiredFields,
    maxAgeDays: type.maxAgeDays,
    ageReference: type.ageReference,
  };
}

@Injectable()
export class PriceSourceRulesReader {
  constructor(private readonly catalogs: CatalogFacade) {}

  /** V-02: o tipo ativo do tenant (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`). */
  active(tx: TenantTx, sourceTypeId: string): Promise<PriceSourceTypeRef> {
    return this.catalogs.assertActivePriceSourceType(tx, sourceTypeId, 'sourceTypeId');
  }

  /** Tipos das fontes gravadas (mesmo inativos). Tipo ausente = catálogo corrompido (500). */
  async of(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, PriceSourceTypeRef>> {
    const types = await this.catalogs.priceSourceTypesOf(tx, ids);
    for (const id of ids) {
      if (!types.has(id)) throw new Error(`Tipo de fonte ${id} ausente do catálogo.`);
    }
    return types;
  }
}

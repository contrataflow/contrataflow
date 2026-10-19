import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';

import { PRICE_RESEARCH_REPOSITORY, PRICE_SOURCE_REPOSITORY } from './ports.js';
import type { PriceResearchRepository, PriceSourceRepository } from './ports.js';
import { SupplierFacade } from '../../supplier/application/supplier.facade.js';

/**
 * API pública do módulo `price-research` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-024: nenhum consumidor ainda (o `RuleContext` de
 * `priceResearch.*` e o vínculo com o ETP chegam com US-029/US-032). US-027: os rótulos congelados
 * das entradas da timeline de cotação desconsiderada/restaurada (RN-TML-04).
 */
@Injectable()
export class PriceResearchFacade {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly processItems: ProcessItemCatalogRegistry,
    private readonly suppliers: SupplierFacade,
  ) {}

  /**
   * Fonte `PRICE_ITEM` da timeline: a sequência do item do processo que a linha da pesquisa
   * referencia. Linha inexistente ou de outro tenant (RLS) fica de fora.
   */
  async priceItemSequences(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly sequence: number }>> {
    const result = new Map<string, { readonly sequence: number }>();
    const byProcess = new Map<string, Map<string, number>>();
    for (const id of new Set(ids)) {
      const item = await this.researches.findItem(tx, id);
      if (item === null) continue;
      const research = await this.researches.findById(tx, item.priceResearchId);
      if (research === null) continue;
      let sequences = byProcess.get(research.processId);
      if (sequences === undefined) {
        sequences = new Map(
          (await this.processItems.listActive(tx, research.processId)).map((reference) => [
            reference.id,
            reference.sequence,
          ]),
        );
        byProcess.set(research.processId, sequences);
      }
      const sequence = sequences.get(item.processItemId);
      if (sequence !== undefined) result.set(id, { sequence });
    }
    return result;
  }

  /**
   * Fonte `QUOTATION` da timeline: o rótulo da fonte da cotação — a razão social do fornecedor
   * quando a fonte o tem, senão a descrição da fonte.
   */
  async quotationSourceLabels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly sourceLabel: string }>> {
    const result = new Map<string, { readonly sourceLabel: string }>();
    for (const id of new Set(ids)) {
      const quotation = await this.sources.findQuotation(tx, id);
      if (quotation === null) continue;
      const source = await this.sources.findSource(tx, quotation.priceSourceId);
      if (source === null) continue;
      const supplier =
        source.supplierId === null
          ? undefined
          : (await this.suppliers.summariesOf(tx, [source.supplierId])).get(source.supplierId);
      result.set(id, { sourceLabel: supplier?.legalName ?? source.description });
    }
    return result;
  }
}

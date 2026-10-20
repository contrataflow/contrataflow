import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type {
  ProcessItemUsage,
  ProcessItemUsageReader,
} from '#shared/process/process-item-usage.js';

import { PRICE_RESEARCH_REPOSITORY } from './ports.js';
import type { PriceResearchRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';

const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);

/**
 * Lado `price-research` da porta `ProcessItemUsageRegistry` (US-006/US-024): as pesquisas que
 * referenciam os itens do processo — o 409 `ITEM_IN_USE` da exclusão do item (PRC-16) e as
 * referências do PRC-13. Pesquisas canceladas também contam (o item faz parte do histórico).
 */
@Injectable()
export class PriceItemUsageReader implements ProcessItemUsageReader {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly documents: DocumentFacade,
  ) {}

  async findItemReferences(tx: TenantTx, itemIds: readonly string[]): Promise<ProcessItemUsage[]> {
    const items = await this.researches.itemsReferencing(tx, itemIds);
    if (items.length === 0) return [];
    // id da pesquisa = id do documento (CHECK `price_research_id_is_document`).
    const states = await this.documents.documentStatesIn(
      tx,
      items.map((item) => item.priceResearchId),
    );
    return items.flatMap((item) => {
      const state = states.get(item.priceResearchId);
      if (state === undefined) return [];
      return [
        {
          itemId: item.processItemId,
          documentId: state.id,
          code: state.code ?? 'Pesquisa de preços',
          typeCode: 'PRICE_RESEARCH',
          status: state.status,
          editable: EDITABLE_STATUSES.has(state.status),
        },
      ];
    });
  }
}

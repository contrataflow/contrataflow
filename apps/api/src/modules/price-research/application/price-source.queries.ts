import type { PageMeta, PageQuery, PriceSourceDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { PRICE_RESEARCH_TRANSACTIONS, PRICE_SOURCE_REPOSITORY } from './ports.js';
import type { PriceResearchTransactions, PriceSourceRepository } from './ports.js';
import { PriceResearchGate } from './price-research.support.js';
import { PriceSourcePresenter } from './price-source.support.js';

/*
 * PRS-09 (US-026): fontes da pesquisa com as cotações de cada uma, pela visibilidade do processo
 * (`PROCESS_VIEW` — DEC-024; não visível = 404 igual ao inexistente) e POL-09 nos preços (RN-PRICE-12).
 * Somente leitura: sem auditoria nem eventos.
 */

@Injectable()
export class ListPriceSourcesQuery {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceResearchGate,
    private readonly presenter: PriceSourcePresenter,
  ) {}

  execute(
    researchId: string,
    query: PageQuery,
  ): Promise<{ readonly items: PriceSourceDto[]; readonly meta: PageMeta }> {
    return this.transactions.read(async (tx) => {
      const { research, masked } = await this.gate.readable(tx, researchId);
      const all = await this.sources.listSources(tx, research.id);
      const skip = (query.page - 1) * query.pageSize;
      const page = all.slice(skip, skip + query.pageSize);
      const quotations =
        page.length === 0 ? [] : await this.sources.listQuotations(tx, research.id);
      return {
        items: await this.presenter.sources(tx, page, quotations, { masked }),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems: all.length,
          totalPages: Math.ceil(all.length / query.pageSize),
        },
      };
    });
  }
}

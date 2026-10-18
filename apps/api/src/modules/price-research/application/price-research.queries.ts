import type {
  PageMeta,
  PriceItemDto,
  PriceItemListQuery,
  PriceResearchDto,
  PriceResearchMeta,
  PriceResearchSummaryDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';

import { PRICE_RESEARCH_REPOSITORY, PRICE_RESEARCH_TRANSACTIONS } from './ports.js';
import type { PriceResearchRepository, PriceResearchTransactions } from './ports.js';
import { PriceResearchGate, PriceResearchPresenter } from './price-research.support.js';
import { DocumentFacade } from '../../document/application/document.facade.js';

/*
 * Consultas da pesquisa de preços (US-024 · PRS-01/03/05): `PROCESS_VIEW` pela visibilidade do
 * processo (DEC-024). Pesquisa inexistente, de outro tenant, com documento excluído ou de processo
 * não visível → 404 `NOT_FOUND` indistinguível. POL-09 nos valores (RN-PRICE-12). Somente leitura:
 * sem auditoria nem eventos.
 */

export interface PriceResearchView {
  readonly dto: PriceResearchDto;
  readonly meta: PriceResearchMeta;
}

@Injectable()
export class GetPriceResearchQuery {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    private readonly gate: PriceResearchGate,
    private readonly presenter: PriceResearchPresenter,
  ) {}

  /** PRS-03: cabeçalho, resumo do documento, snapshot e `meta.allowedActions`. */
  execute(researchId: string): Promise<PriceResearchView> {
    return this.transactions.read(async (tx) => {
      const { research, view, masked, lockReason } = await this.gate.readable(tx, researchId);
      return {
        dto: this.presenter.research(research, view.document, { masked }),
        meta: this.presenter.meta(view.template, view.allowedActions, lockReason),
      };
    });
  }
}

@Injectable()
export class ListProcessPriceResearchQuery {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly gate: PriceResearchGate,
    private readonly presenter: PriceResearchPresenter,
    private readonly documents: DocumentFacade,
  ) {}

  /** PRS-01: 0 ou 1 não cancelada + canceladas (excluídas logicamente ficam de fora). */
  execute(processId: string): Promise<PriceResearchSummaryDto[]> {
    return this.transactions.read(async (tx) => {
      // Processo inexistente, de outro tenant ou não visível → 404 `NOT_FOUND` (DEC-024).
      await this.gate.collection(tx, processId);
      const researches = await this.researches.listByProcess(tx, processId);
      const labels = await this.documents.documentLabels(
        tx,
        researches.map((research) => research.documentId),
      );
      const states = await this.documents.documentStatesIn(
        tx,
        researches.map((research) => research.documentId),
      );
      return researches.flatMap((research) => {
        const state = states.get(research.documentId);
        if (state === undefined) return [];
        return [
          this.presenter.summary(research, state, labels.get(research.documentId)?.title ?? ''),
        ];
      });
    });
  }
}

@Injectable()
export class ListPriceItemsQuery {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly gate: PriceResearchGate,
    private readonly presenter: PriceResearchPresenter,
    private readonly catalog: ProcessItemCatalogRegistry,
  ) {}

  /** PRS-05: itens por `sortOrder`, filtros `lot`/`hasAlerts`, POL-09 nos valores. */
  execute(
    researchId: string,
    query: PriceItemListQuery,
  ): Promise<{ readonly items: PriceItemDto[]; readonly meta: PageMeta }> {
    return this.transactions.read(async (tx) => {
      const { research, masked } = await this.gate.readable(tx, researchId);
      const processItemIds =
        query.lot === undefined
          ? undefined
          : (await this.catalog.listActive(tx, research.processId))
              .filter((item) => item.lotNumber === query.lot)
              .map((item) => item.id);
      const skip = (query.page - 1) * query.pageSize;
      const page = await this.researches.pageItems(
        tx,
        research.id,
        { hasAlerts: query.hasAlerts, processItemIds },
        { skip, take: query.pageSize },
      );
      return {
        items: await this.presenter.items(tx, research.processId, page.items, { masked }),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems: page.total,
          totalPages: Math.ceil(page.total / query.pageSize),
        },
      };
    });
  }
}

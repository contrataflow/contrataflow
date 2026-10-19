import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type {
  PriceResearchSummary,
  PriceResearchSummaryReader,
} from '#shared/price-research/price-research-summary.js';

import { PRICE_RESEARCH_REPOSITORY } from './ports.js';
import type { PriceResearchRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';

/**
 * Lado `price-research` da porta `PriceResearchSummaryRegistry` (US-036 · RN-TR-07): as pesquisas
 * do processo com o status do documento e o total — o valor estimado do TR. Canceladas e excluídas
 * (documento ausente) ficam de fora; a mais recente primeiro.
 */
@Injectable()
export class PriceResearchSummaryReaderImpl implements PriceResearchSummaryReader {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly documents: DocumentFacade,
  ) {}

  async listByProcess(tx: TenantTx, processId: string): Promise<PriceResearchSummary[]> {
    const researches = await this.researches.listByProcess(tx, processId);
    if (researches.length === 0) return [];
    const states = await this.documents.documentStatesIn(
      tx,
      researches.map((research) => research.documentId),
    );
    return researches
      .flatMap((research): PriceResearchSummary[] => {
        const state = states.get(research.documentId);
        if (state === undefined || state.status === 'CANCELED') return [];
        return [
          {
            id: research.id,
            processId: research.processId,
            documentId: research.documentId,
            code: state.code,
            status: state.status,
            totalEstimatedValue: research.totalEstimatedValue,
          },
        ];
      })
      .reverse();
  }
}

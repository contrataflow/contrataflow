import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';

import { currentRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { PRICE_RESEARCH_REPOSITORY, PRICE_SOURCE_REPOSITORY } from './ports.js';
import type { PriceResearchRepository, PriceSourceRepository } from './ports.js';
import { priceResearchVersionConflict } from './price-research.errors.js';
import { PriceResearchRecorder } from './price-research.support.js';
import { recalculate } from '../domain/price-research.js';
import type { PriceResearch } from '../domain/price-research.js';
import { validPricesByItem } from '../domain/price-source.js';

/*
 * `PriceCalculationService` (US-029 · RN-PRICE-45 · "Impacto técnico"): o motor de recálculo
 * reaproveitado por toda mutação da pesquisa (cotações, fontes, itens, método, parâmetros) e pelo
 * PRS-20. Sempre dentro de uma transação já aberta, com a linha da pesquisa travada por quem chama
 * (`PriceResearchGate.writable`) — nunca abre transação própria. Grava os itens que mudaram, o
 * cabeçalho (`version + 1`), `price_research.recalculate` e `PriceResearchRecalculated`. Logs e
 * métricas sem valores (DEC-030).
 */

/** O que disparou o recálculo (`metadata.trigger` da auditoria). */
export type RecalculationTrigger =
  'QUOTATION' | 'IMPORT' | 'ITEMS' | 'ITEM_UPDATE' | 'PARAMETERS' | 'REFERENCE_DATE' | 'MANUAL';

/** Recálculo em lote acima disto gera `price_research.recalculate_slow` ("Logs"). */
const SLOW_RECALCULATION_MS = 1000;

let durationHistogram: Histogram | undefined;

function recordDuration(durationMs: number, trigger: RecalculationTrigger): void {
  durationHistogram ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('price_research_recalculate_duration_ms', {
      description: 'Duração do recálculo da pesquisa de preços (US-029).',
      unit: 'ms',
    });
  durationHistogram.record(durationMs, { trigger });
}

@Injectable()
export class PriceCalculationService {
  private readonly logger = new Logger('price_research.recalculate');

  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly recorder: PriceResearchRecorder,
  ) {}

  /**
   * `recalculateResearch`: recalcula todos os itens a partir das cotações válidas gravadas e o
   * cabeçalho. `research` é o cabeçalho travado — com os parâmetros/data-base novos, quando o
   * PRS-04 os mudou —, gravado com a versão que traz (412 se outra transação a mudou). Idempotente:
   * só as linhas cujo resultado mudou são regravadas.
   */
  async recalculateResearch(
    tx: TenantTx,
    research: PriceResearch,
    input: {
      readonly stamp: { readonly now: Date; readonly userId: string | null };
      readonly trigger: RecalculationTrigger;
    },
  ): Promise<PriceResearch> {
    const startedAt = performance.now();
    try {
      const items = await this.researches.listItems(tx, research.id);
      const quotations = await this.sources.listQuotations(tx, research.id);
      const result = recalculate(research, items, input.stamp, validPricesByItem(quotations));
      await this.researches.updateItems(tx, result.changedItems);
      try {
        await this.researches.update(tx, result.research, research.version);
      } catch (error) {
        if (error instanceof VersionConflictError) {
          const latest = await this.researches.findById(tx, research.id);
          throw priceResearchVersionConflict(latest?.version ?? research.version + 1);
        }
        throw error;
      }
      const saved = { ...result.research, version: research.version + 1 };
      await this.recorder.recalculationAudited(tx, saved, input.trigger);
      await this.recorder.recalculated(tx, saved);
      this.logged(saved, input.trigger, performance.now() - startedAt);
      return saved;
    } catch (error) {
      this.logger.error(
        {
          event: 'price_research.recalculate_failed',
          priceResearchId: research.id,
          errorCode: errorCodeOf(error),
          correlationId: currentRequestContext()?.correlationId ?? null,
        },
        'price_research.recalculate_failed',
      );
      throw error;
    }
  }

  private logged(research: PriceResearch, trigger: RecalculationTrigger, durationMs: number) {
    const rounded = Math.round(durationMs);
    recordDuration(rounded, trigger);
    const entry = {
      priceResearchId: research.id,
      itemsCount: research.itemsCount,
      itemsWithAlertsCount: research.itemsWithAlertsCount,
      trigger,
      durationMs: rounded,
      correlationId: currentRequestContext()?.correlationId ?? null,
    };
    this.logger.log(
      { event: 'price_research.recalculated', ...entry },
      'price_research.recalculated',
    );
    if (rounded > SLOW_RECALCULATION_MS) {
      this.logger.warn(
        { event: 'price_research.recalculate_slow', ...entry },
        'price_research.recalculate_slow',
      );
    }
  }
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (typeof error.code === 'string') return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}

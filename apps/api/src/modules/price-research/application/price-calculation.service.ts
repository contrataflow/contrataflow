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
import { PriceSourceRulesReader, rulesOf } from './price-source-rules.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { recalculate } from '../domain/price-research.js';
import type { PriceItem, PriceResearch } from '../domain/price-research.js';
import { assessQuotations, isSourceExpired, quotationFactsByItem } from '../domain/price-source.js';
import type { Quotation } from '../domain/price-source.js';

/*
 * `PriceCalculationService` (US-029 · RN-PRICE-45 · "Impacto técnico"): o motor de recálculo
 * reaproveitado por toda mutação da pesquisa (cotações, fontes, itens, método, parâmetros) e pelo
 * PRS-20. Sempre dentro de uma transação já aberta, com a linha da pesquisa travada por quem chama
 * (`PriceResearchGate.writable`) — nunca abre transação própria. Avalia o destaque e a validade das
 * cotações (US-030 · RN-PRICE-48/49/52), grava os itens que mudaram (estatísticas e alertas —
 * RN-PRICE-50), o cabeçalho (`version + 1`, `itemsWithAlertsCount` — RN-PRICE-51),
 * `price_research.recalculate` e `PriceResearchRecalculated`: estatística e alerta mudam juntos, sem
 * estado intermediário. Logs e métricas sem valores (DEC-030).
 */

/** O que disparou o recálculo (`metadata.trigger` da auditoria). */
export type RecalculationTrigger =
  'QUOTATION' | 'IMPORT' | 'ITEMS' | 'ITEM_UPDATE' | 'PARAMETERS' | 'REFERENCE_DATE' | 'MANUAL';

/** Recálculo em lote acima disto gera `price_research.recalculate_slow` ("Logs"). */
const SLOW_RECALCULATION_MS = 1000;

/** Destaque/validade das cotações acima disto gera `price_research.outlier_calc_slow` (US-030). */
const SLOW_OUTLIER_MS = 300;

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
    private readonly rules: PriceSourceRulesReader,
    private readonly numbering: NumberingFacade,
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
      const quotations = await this.assessed(tx, research);
      const result = recalculate(research, items, input.stamp, quotationFactsByItem(quotations));
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
      const alertChanges = alertChangesOf(items, result.changedItems);
      await this.recorder.recalculationAudited(tx, saved, input.trigger, alertChanges.length > 0);
      await this.recorder.recalculated(tx, saved);
      this.alertsLogged(saved, alertChanges);
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

  /**
   * RN-PRICE-48/49/52: as cotações da pesquisa com o destaque (contra a mediana das demais `VALID`
   * do item — limiares do cabeçalho, já com o que o PRS-04 mudou) e a validade (data-base do
   * cabeçalho × regra ATUAL do tipo da fonte no catálogo) reavaliados; grava só as que mudaram.
   */
  private async assessed(tx: TenantTx, research: PriceResearch): Promise<readonly Quotation[]> {
    const stored = await this.sources.listQuotations(tx, research.id);
    if (stored.length === 0) return stored;
    const startedAt = performance.now();
    const sources = new Map(
      (await this.sources.listSources(tx, research.id)).map((source) => [source.id, source]),
    );
    const types = await this.rules.of(tx, [
      ...new Set([...sources.values()].map((source) => source.sourceTypeId)),
    ]);
    const { timezone } = await this.numbering.settingsOf(tx);
    const assessment = assessQuotations(stored, {
      thresholds: research.parameters,
      isExpiredOf: (quotation) => {
        const source = sources.get(quotation.priceSourceId);
        const type = source === undefined ? undefined : types.get(source.sourceTypeId);
        if (source === undefined || type === undefined) return quotation.isExpired;
        return isSourceExpired(source, rulesOf(type), research, timezone);
      },
    });
    await this.sources.updateAssessments(tx, assessment.changed);
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs > SLOW_OUTLIER_MS) {
      this.logger.warn(
        {
          event: 'price_research.outlier_calc_slow',
          priceResearchId: research.id,
          quotationsCount: stored.length,
          durationMs,
          correlationId: currentRequestContext()?.correlationId ?? null,
        },
        'price_research.outlier_calc_slow',
      );
    }
    return assessment.quotations;
  }

  /** `price_research.alerts_changed` por item — só os códigos, nunca preços nem percentuais. */
  private alertsLogged(research: PriceResearch, changes: readonly AlertChange[]) {
    for (const change of changes) {
      this.logger.log(
        {
          event: 'price_research.alerts_changed',
          priceResearchId: research.id,
          priceItemId: change.priceItemId,
          alertsBefore: change.before,
          alertsAfter: change.after,
          correlationId: currentRequestContext()?.correlationId ?? null,
        },
        'price_research.alerts_changed',
      );
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

interface AlertChange {
  readonly priceItemId: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** Os itens recalculados cujo conjunto de alertas mudou (antes × depois, só os códigos). */
function alertChangesOf(
  before: readonly PriceItem[],
  changed: readonly PriceItem[],
): AlertChange[] {
  const previous = new Map(before.map((item) => [item.id, item.alerts.map((alert) => alert.code)]));
  return changed.flatMap((item) => {
    const after = item.alerts.map((alert) => alert.code);
    const old = previous.get(item.id) ?? [];
    const same = old.length === after.length && old.every((code, index) => code === after[index]);
    return same ? [] : [{ priceItemId: item.id, before: old, after }];
  });
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (typeof error.code === 'string') return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}

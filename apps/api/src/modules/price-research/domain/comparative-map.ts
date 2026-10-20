import { PRICE_SUMMARY_COLLECTIONS } from '@contrataflow/validation';
import type {
  ComparativeMapCell,
  ComparativeMapDto,
  ComparativeMapItem,
  ComparativeMapSource,
} from '@contrataflow/validation';

import type { PriceItem, PriceResearch } from './price-research.js';
import type { PriceSource, Quotation } from './price-source.js';

/*
 * `ComparativeMapBuilder` (US-031 · RN-PRICE-53/56/57): o mapa comparativo como matriz itens ×
 * fontes, montado a partir das linhas vigentes de `PriceItem`/`PriceSource`/`Quotation` (nunca um
 * snapshot próprio). Linhas por `sortOrder` do item, colunas por `sortOrder` da fonte, células só
 * onde existe cotação (o cruzamento sem cotação fica vazio), e cada linha encerra com as estatísticas
 * e os alertas do item. O mascaramento POL-09 (`maskComparativeMap`) é um passo único sobre o mapa
 * montado — a tela (PRS-21) e o XLSX (PRS-22) saem do mesmo resultado; o PDF congela o mapa sem
 * máscara no snapshot e o `document` aplica a POL-09 na renderização (`comparativeMapSnapshot`).
 * Funções puras.
 */

/** O item do processo como o mapa o exibe. */
export interface ComparativeMapItemRef {
  readonly sequence: number;
  readonly lotNumber: number | null;
  readonly description: string;
  readonly unitLabel: string;
}

export interface ComparativeMapInput {
  readonly research: PriceResearch;
  readonly code: string | null;
  readonly title: string;
  readonly items: readonly PriceItem[];
  readonly sources: readonly PriceSource[];
  readonly quotations: readonly Quotation[];
  /** Por `processItemId`. */
  readonly itemRefs: ReadonlyMap<string, ComparativeMapItemRef>;
  /** Por `sourceTypeId`. */
  readonly sourceTypes: ReadonlyMap<string, { readonly code: string; readonly label: string }>;
  /** Razão social por `supplierId`. */
  readonly supplierNames: ReadonlyMap<string, string>;
}

const bySortOrder = <T extends { readonly sortOrder: number }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder;

/** A matriz completa, sem máscara (RN-PRICE-53). */
export function buildComparativeMap(input: ComparativeMapInput): ComparativeMapDto {
  const { research } = input;
  // `listSources` já ordena por `sortOrder` e criação; o `sort` estável preserva o desempate.
  const sources = [...input.sources].sort(bySortOrder);
  const items = [...input.items].sort(bySortOrder);
  const sourceIndex = new Map(sources.map((source, index) => [source.id, index]));
  const itemIndex = new Map(items.map((item, index) => [item.id, index]));
  const cells = input.quotations
    .filter((quotation) => sourceIndex.has(quotation.priceSourceId))
    .filter((quotation) => itemIndex.has(quotation.priceItemId))
    .sort(
      (a, b) =>
        (itemIndex.get(a.priceItemId) ?? 0) - (itemIndex.get(b.priceItemId) ?? 0) ||
        (sourceIndex.get(a.priceSourceId) ?? 0) - (sourceIndex.get(b.priceSourceId) ?? 0),
    )
    .map((quotation): ComparativeMapCell => ({
      priceItemId: quotation.priceItemId,
      priceSourceId: quotation.priceSourceId,
      quotationId: quotation.id,
      unitPrice: quotation.unitPrice,
      unitPriceMasked: false,
      status: quotation.status,
      exclusionReason: quotation.exclusionReason,
      outlierFlag: quotation.outlierFlag,
      isExpired: quotation.isExpired,
    }));
  return {
    priceResearchId: research.id,
    code: input.code,
    title: input.title,
    referenceDate: research.referenceDate,
    lastCalculatedAt: research.lastCalculatedAt?.toISOString() ?? null,
    unitPriceDecimals: research.parameters.unitPriceDecimals,
    totalEstimatedValue: research.totalEstimatedValue,
    masked: false,
    items: items.map((item): ComparativeMapItem => {
      const ref = input.itemRefs.get(item.processItemId);
      return {
        id: item.id,
        processItemId: item.processItemId,
        sequence: ref?.sequence ?? item.sortOrder,
        lotNumber: ref?.lotNumber ?? null,
        description: ref?.description ?? '',
        unitLabel: ref?.unitLabel ?? '',
        quantity: item.quantity,
        sortOrder: item.sortOrder,
        effectiveMethod: item.effectiveMethod,
        validQuotationsCount: item.validQuotationsCount,
        meanPrice: item.meanPrice,
        medianPrice: item.medianPrice,
        lowestPrice: item.lowestPrice,
        highestPrice: item.highestPrice,
        stdDeviation: item.stdDeviation,
        coefficientOfVariation: item.coefficientOfVariation,
        recommendedUnitPrice: item.recommendedUnitPrice,
        totalPrice: item.totalPrice,
        valuesMasked: false,
        alerts: item.alerts.map((alert) => ({ code: alert.code })),
      };
    }),
    sources: sources.map((source): ComparativeMapSource => {
      const type = input.sourceTypes.get(source.sourceTypeId);
      return {
        id: source.id,
        description: source.description,
        sourceType: { code: type?.code ?? '', label: type?.label ?? '' },
        supplierName:
          source.supplierId === null ? null : (input.supplierNames.get(source.supplierId) ?? null),
        quoteDate: source.quoteDate,
        sortOrder: source.sortOrder,
      };
    }),
    cells,
  };
}

/**
 * POL-09 (RN-PRICE-56): toda célula, estatística e total `null` com a marca de mascarado. Os selos
 * (status, destaque, vencida) e os códigos de alerta continuam visíveis — não revelam valores.
 */
export function maskComparativeMap(map: ComparativeMapDto): ComparativeMapDto {
  return {
    ...map,
    totalEstimatedValue: null,
    masked: true,
    items: map.items.map((item) => ({
      ...item,
      meanPrice: null,
      medianPrice: null,
      lowestPrice: null,
      highestPrice: null,
      stdDeviation: null,
      // O CV é adimensional, mas revela a dispersão dos preços sigilosos (igual ao PRS-05).
      coefficientOfVariation: null,
      recommendedUnitPrice: null,
      totalPrice: null,
      valuesMasked: true,
    })),
    cells: map.cells.map((cell) => ({ ...cell, unitPrice: null, unitPriceMasked: true })),
  };
}

/** O mapa como o usuário pode vê-lo (POL-09 decidido por quem chama). */
export function comparativeMapFor(map: ComparativeMapDto, masked: boolean): ComparativeMapDto {
  return masked ? maskComparativeMap(map) : map;
}

// --- Seção computada `PRICE_SUMMARY` do PDF (RN-PRICE-55) ---------------------------------------

/**
 * O mapa no snapshot do documento (entities.md §5.3.2), sem máscara: o `document` mascara na
 * renderização (`maskConfidentialSnapshot` — nomes de campo monetários reconhecidos, inclusive nas
 * células aninhadas). Células alinhadas às colunas (`null` = sem cotação).
 */
export function comparativeMapSnapshot(map: ComparativeMapDto): Record<string, unknown[]> {
  const cellsByItem = new Map<string, Map<string, ComparativeMapCell>>();
  for (const cell of map.cells) {
    const row = cellsByItem.get(cell.priceItemId) ?? new Map<string, ComparativeMapCell>();
    row.set(cell.priceSourceId, cell);
    cellsByItem.set(cell.priceItemId, row);
  }
  return {
    [PRICE_SUMMARY_COLLECTIONS.summary]: [
      {
        referenceDate: map.referenceDate,
        lastCalculatedAt: map.lastCalculatedAt,
        unitPriceDecimals: map.unitPriceDecimals,
        totalEstimatedValue: map.totalEstimatedValue,
      },
    ],
    [PRICE_SUMMARY_COLLECTIONS.sources]: map.sources.map((source) => ({
      id: source.id,
      description: source.description,
      sourceTypeLabel: source.sourceType.label,
      supplierName: source.supplierName,
      quoteDate: source.quoteDate,
    })),
    [PRICE_SUMMARY_COLLECTIONS.items]: map.items.map((item) => {
      const row = cellsByItem.get(item.id);
      return {
        id: item.id,
        sequence: item.sequence,
        description: item.description,
        unitLabel: item.unitLabel,
        quantity: item.quantity,
        effectiveMethod: item.effectiveMethod,
        validQuotationsCount: item.validQuotationsCount,
        meanPrice: item.meanPrice,
        medianPrice: item.medianPrice,
        lowestPrice: item.lowestPrice,
        highestPrice: item.highestPrice,
        stdDeviation: item.stdDeviation,
        coefficientOfVariation: item.coefficientOfVariation,
        recommendedUnitPrice: item.recommendedUnitPrice,
        totalPrice: item.totalPrice,
        alerts: item.alerts.map((alert) => alert.code),
        cells: map.sources.map((source) => {
          const cell = row?.get(source.id);
          return cell === undefined
            ? null
            : {
                unitPrice: cell.unitPrice,
                status: cell.status,
                outlierFlag: cell.outlierFlag,
                isExpired: cell.isExpired,
              };
        }),
      };
    }),
  };
}

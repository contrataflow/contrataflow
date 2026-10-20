import { z } from 'zod';

import { PRICE_CALCULATION_METHODS, priceItemAlertSchema } from './price-research.js';
import type { PriceItemAlertCode } from './price-research.js';
import { EXCLUSION_REASONS, OUTLIER_FLAGS, QUOTATION_STATUSES } from './price-sources.js';
import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';
import { quantitySchema } from '../common/decimal.js';

/*
 * Mapa comparativo da pesquisa de preços (US-031 · api/07 PRS-21/22 · RN-PRICE-53..57): matriz
 * itens × fontes — linhas = `PriceItem` por `sortOrder`, colunas = `PriceSource` por `sortOrder`,
 * células = a `Quotation` do cruzamento (só quando existe) — encerrando cada linha com as
 * estatísticas e os alertas do item (US-029/US-030). Somente leitura e nunca um snapshot: reflete o
 * último recálculo consolidado (`lastCalculatedAt`). POL-09 (RN-PRICE-56): sem
 * `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia atual, todo valor monetário vem `null` com a marca
 * de mascarado — na tela, no XLSX e no PDF. Os mesmos schemas servem à API, ao OpenAPI e à SCR-010.
 */

export const COMPARATIVE_MAP_EXPORT_FORMATS = ['xlsx'] as const;
export type ComparativeMapExportFormat = (typeof COMPARATIVE_MAP_EXPORT_FORMATS)[number];

export const COMPARATIVE_MAP_LIMITS = Object.freeze({
  /** RN-PRICE-54: teto da exportação síncrona (PRS-22). */
  maxExportItems: 500,
  maxExportSources: 50,
  /** Log `price_research.export_near_limit` acima de 80% do teto. */
  nearLimitItems: 400,
  nearLimitSources: 40,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

export const COMPARATIVE_MAP_MESSAGES = Object.freeze({
  title: 'Mapa comparativo',
  notFound: 'Pesquisa não encontrada.',
  tooLarge:
    'Esta pesquisa tem mais itens/fontes do que o exportável de uma vez. Gere o PDF ou reduza o recorte.',
  formatInvalid: 'Formato de exportação não suportado.',
  unavailable: 'Não foi possível exportar agora. Tente novamente em instantes.',
  noSources: 'Cadastre ao menos uma fonte para montar o mapa',
  pdfFailed: 'Não foi possível gerar o PDF agora.',
  pdfPending: 'O PDF ainda está sendo gerado. Aguarde.',
  masked: 'Sigiloso',
});

/** Rótulos dos arquivos exportados (XLSX e seção `PRICE_SUMMARY` do PDF) — iguais aos da SCR-009. */
export const COMPARATIVE_MAP_LABELS = Object.freeze({
  methods: {
    MEAN: 'Média',
    MEDIAN: 'Mediana',
    LOWEST: 'Menor preço',
    MANUAL: 'Manual',
  } satisfies Record<(typeof PRICE_CALCULATION_METHODS)[number], string>,
  alerts: {
    NO_VALID_QUOTES: 'Sem cotações válidas',
    BELOW_MINIMUM_QUOTES: 'Abaixo do mínimo de cotações',
    HIGH_CV: 'Preços muito dispersos',
    HAS_OUTLIERS: 'Valores atípicos',
    EXPIRED_QUOTES: 'Cotações vencidas',
  } satisfies Record<PriceItemAlertCode, string>,
  exclusionReasons: {
    UNFEASIBLE: 'Inexequível',
    EXCESSIVE: 'Excessivo',
    INCONSISTENT: 'Inconsistente',
    EXPIRED: 'Vencido',
    NON_COMPLIANT: 'Não conforme',
    OTHER: 'Outro motivo',
  } satisfies Record<(typeof EXCLUSION_REASONS)[number], string>,
  excluded: 'Desconsiderada',
  outlierLow: 'Abaixo da mediana',
  outlierHigh: 'Acima da mediana',
  expired: 'Vencida',
});

/** Query do PRS-22 (V-02): `format` obrigatório, somente `xlsx` no MVP 1. */
export const comparativeMapExportQuerySchema = z.strictObject({
  format: z.enum(COMPARATIVE_MAP_EXPORT_FORMATS, { error: COMPARATIVE_MAP_MESSAGES.formatInvalid }),
});
export type ComparativeMapExportQuery = z.infer<typeof comparativeMapExportQuerySchema>;

/** Linha do mapa: o item com as estatísticas e os alertas (RN-PRICE-53). */
export const comparativeMapItemSchema = z
  .object({
    id: z.uuid(),
    processItemId: z.uuid(),
    /** Nº do item no processo, lote, descrição e unidade — exibição. */
    sequence: z.int(),
    lotNumber: z.int().nullable(),
    description: z.string(),
    unitLabel: z.string(),
    quantity: quantitySchema,
    sortOrder: z.int(),
    effectiveMethod: z.enum(PRICE_CALCULATION_METHODS).nullable(),
    validQuotationsCount: z.int().min(0),
    /** Valores monetários (e o CV, que revela a dispersão): `null` se não calculados ou mascarados. */
    meanPrice: z.string().nullable(),
    medianPrice: z.string().nullable(),
    lowestPrice: z.string().nullable(),
    highestPrice: z.string().nullable(),
    stdDeviation: z.string().nullable(),
    coefficientOfVariation: z.string().nullable(),
    recommendedUnitPrice: z.string().nullable(),
    totalPrice: z.string().nullable(),
    /** POL-09: todos os valores monetários do item vêm `null`. */
    valuesMasked: z.boolean(),
    alerts: z.array(priceItemAlertSchema),
  })
  .meta({ id: 'ComparativeMapItem' });
export type ComparativeMapItem = z.infer<typeof comparativeMapItemSchema>;

/** Coluna do mapa: a fonte consultada. */
export const comparativeMapSourceSchema = z
  .object({
    id: z.uuid(),
    description: z.string(),
    sourceType: z.object({ code: z.string(), label: z.string() }),
    supplierName: z.string().nullable(),
    quoteDate: isoDateSchema.nullable(),
    sortOrder: z.int(),
  })
  .meta({ id: 'ComparativeMapSource' });
export type ComparativeMapSource = z.infer<typeof comparativeMapSourceSchema>;

/** Célula do mapa: a cotação do cruzamento item × fonte (ausente quando não há cotação). */
export const comparativeMapCellSchema = z
  .object({
    priceItemId: z.uuid(),
    priceSourceId: z.uuid(),
    quotationId: z.uuid(),
    /** Decimal(18,4); `null` se mascarado (`unitPriceMasked`). */
    unitPrice: z.string().nullable(),
    unitPriceMasked: z.boolean(),
    status: z.enum(QUOTATION_STATUSES),
    exclusionReason: z.enum(EXCLUSION_REASONS).nullable(),
    outlierFlag: z.enum(OUTLIER_FLAGS),
    isExpired: z.boolean(),
  })
  .meta({ id: 'ComparativeMapCell' });
export type ComparativeMapCell = z.infer<typeof comparativeMapCellSchema>;

/** PRS-21: o mapa comparativo completo. */
export const comparativeMapSchema = z
  .object({
    priceResearchId: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    referenceDate: isoDateSchema,
    /** RN-PRICE-57: referência de "calculado há" (último recálculo consolidado). */
    lastCalculatedAt: isoDateTimeSchema.nullable(),
    unitPriceDecimals: z.int(),
    totalEstimatedValue: z.string().nullable(),
    /** POL-09: células, estatísticas e totais mascarados para este usuário. */
    masked: z.boolean(),
    items: z.array(comparativeMapItemSchema),
    sources: z.array(comparativeMapSourceSchema),
    /** Por item (`sortOrder`) e, dentro dele, por fonte (`sortOrder`). */
    cells: z.array(comparativeMapCellSchema),
  })
  .meta({ id: 'ComparativeMap' });
export type ComparativeMapDto = z.infer<typeof comparativeMapSchema>;

/**
 * Coleções do snapshot do documento `PRICE_RESEARCH` que a seção computada `PRICE_SUMMARY` renderiza
 * no PDF (RN-PRICE-55): o resumo (data-base, cálculo, total), as colunas (fontes) e as linhas
 * (itens com as células alinhadas às colunas — `null` = sem cotação). Escritas pelo módulo
 * `price-research`, lidas pela renderização do `document`.
 */
export const PRICE_SUMMARY_COLLECTIONS = Object.freeze({
  summary: 'priceSummary',
  sources: 'priceSummarySources',
  items: 'priceSummaryItems',
});

/** Nome do arquivo do PRS-22 (`mapa-comparativo-<código>.xlsx`). */
export function comparativeMapFileName(code: string | null): string {
  const slug = (code ?? 'pesquisa')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `mapa-comparativo-${slug === '' ? 'pesquisa' : slug}.xlsx`;
}

/** RN-PRICE-54: a pesquisa cabe na exportação síncrona. */
export function exceedsComparativeMapExport(itemsCount: number, sourcesCount: number): boolean {
  return (
    itemsCount > COMPARATIVE_MAP_LIMITS.maxExportItems ||
    sourcesCount > COMPARATIVE_MAP_LIMITS.maxExportSources
  );
}

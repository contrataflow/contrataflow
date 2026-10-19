import {
  manualPriceIssues,
  normalizeQuantity,
  PRICE_RESEARCH_CALCULATION_FIELDS,
  PRICE_RESEARCH_MESSAGES,
  priceItemQuantityIssue,
  referenceDateIssue,
} from '@contrataflow/validation';
import type {
  FieldError,
  PriceCalculationMethod,
  PriceDefaultMethod,
  PriceItemAlert,
  PriceItemInput,
  PriceResearchCalculationField,
  PriceResearchCalculationPatch,
  PriceResearchParameters,
  PriceRoundingMode,
  UpdatePriceItem,
} from '@contrataflow/validation';
import { Decimal } from 'decimal.js';

import { calculatePriceItem, sameCalculation, totalEstimatedValueOf } from './price-calculation.js';

/*
 * Pesquisa de preços (US-024 · entities.md §4.8 · DEC-020). `PriceResearch` é o cabeçalho tipado
 * 1:1 do `Document` do tipo `PRICE_RESEARCH` (mesmo id), sem status próprio (DEC-018), com o
 * snapshot dos parâmetros `priceResearch.*` fixado na criação (RN-PRICE-05) — os de cálculo
 * editáveis depois pelo PRS-04 (RN-PRICE-47 · US-029). `PriceItem` é a linha
 * do item canônico do processo (`ProcessItem` — DEC-019). Puro: sem NestJS, Prisma nem outro módulo.
 */

export interface PriceResearch {
  /** = `documentId` (o identificador da SCR-009 e do painel de documentos). */
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string;
  /** Data-base `AAAA-MM-DD` (RN-PRICE-06). */
  readonly referenceDate: string;
  readonly parameters: PriceResearchParameters;
  /** Decimal(18,2) — calculado (US-029). */
  readonly totalEstimatedValue: string | null;
  readonly itemsCount: number;
  readonly itemsWithAlertsCount: number;
  readonly lastCalculatedAt: Date | null;
  readonly completedAt: Date | null;
  readonly completedById: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

export interface PriceItem {
  readonly id: string;
  readonly tenantId: string;
  readonly priceResearchId: string;
  readonly processItemId: string;
  /** Decimal(18,4) normalizado (`"100.0000"`). */
  readonly quantity: string;
  readonly methodOverride: PriceCalculationMethod | null;
  readonly effectiveMethod: PriceCalculationMethod | null;
  readonly validQuotationsCount: number;
  readonly meanPrice: string | null;
  readonly medianPrice: string | null;
  readonly lowestPrice: string | null;
  readonly highestPrice: string | null;
  readonly stdDeviation: string | null;
  readonly coefficientOfVariation: string | null;
  readonly recommendedUnitPrice: string | null;
  readonly manualUnitPrice: string | null;
  readonly manualJustification: string | null;
  readonly totalPrice: string | null;
  readonly belowMinimumJustification: string | null;
  readonly alerts: readonly PriceItemAlert[];
  readonly notes: string | null;
  readonly sortOrder: number;
  readonly calculatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

// --- Snapshot dos parâmetros (RN-PRICE-05) -------------------------------------------------------

/** Chaves de configuração copiadas na criação (DEC-020), na ordem do snapshot. */
export const PRICE_RESEARCH_SETTING_KEYS = [
  'priceResearch.defaultMethod',
  'priceResearch.cvThresholdPercent',
  'priceResearch.minQuotations',
  'priceResearch.directQuoteMaxAgeDays',
  'priceResearch.similarContractMaxAgeDays',
  'priceResearch.outlierLowerPercent',
  'priceResearch.outlierUpperPercent',
  'priceResearch.unitPriceDecimals',
  'priceResearch.roundingMode',
] as const;

/** Percentual `numeric(9,4)` como string (`25` → `"25.0000"`). */
export function percentOf(value: number): string {
  return value.toFixed(4);
}

/**
 * RN-PRICE-05: o snapshot a partir dos valores efetivos de `priceResearch.*` (o gravado ou o padrão
 * do registro — já validados pelo `PATCH /settings`). Valor fora do contrato = configuração
 * corrompida: falha explícita (500), nunca um snapshot parcial.
 */
export function parametersSnapshot(values: ReadonlyMap<string, unknown>): PriceResearchParameters {
  const read = (key: (typeof PRICE_RESEARCH_SETTING_KEYS)[number]) => values.get(key);
  const number = (key: (typeof PRICE_RESEARCH_SETTING_KEYS)[number]) => {
    const value = read(key);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Configuração ${key} inválida para o snapshot da pesquisa.`);
    }
    return value;
  };
  const unitPriceDecimals = number('priceResearch.unitPriceDecimals');
  if (unitPriceDecimals !== 2 && unitPriceDecimals !== 4) {
    throw new Error('Configuração priceResearch.unitPriceDecimals inválida.');
  }
  return {
    defaultMethod: read('priceResearch.defaultMethod') as PriceDefaultMethod,
    cvThresholdPercent: percentOf(number('priceResearch.cvThresholdPercent')),
    minQuotations: number('priceResearch.minQuotations'),
    directQuoteMaxAgeDays: number('priceResearch.directQuoteMaxAgeDays'),
    similarContractMaxAgeDays: number('priceResearch.similarContractMaxAgeDays'),
    outlierLowerPercent: percentOf(number('priceResearch.outlierLowerPercent')),
    outlierUpperPercent: percentOf(number('priceResearch.outlierUpperPercent')),
    unitPriceDecimals,
    roundingMode: read('priceResearch.roundingMode') as PriceRoundingMode,
  };
}

// --- Quantidade (RN-PRICE-04) --------------------------------------------------------------------

/**
 * Quantidade padrão do item na pesquisa: a de referência do processo; se nula, a do ETP não
 * cancelado; se ausente, a do DFD; senão `null` (obrigatória no envio).
 */
export function defaultQuantity(
  referenceQuantity: string | null,
  documentQuantity: string | undefined,
): string | null {
  return referenceQuantity ?? documentQuantity ?? null;
}

/** Item do processo disponível para a pesquisa, com a unidade e a quantidade padrão. */
export interface ResearchableItem {
  readonly id: string;
  readonly sequence: number;
  readonly allowsDecimal: boolean;
  /** RN-PRICE-04 já resolvida (processo → ETP → DFD); `null` = obrigatória no envio. */
  readonly defaultQuantity: string | null;
}

/** Linha aprovada: o item do processo e a quantidade normalizada. */
export interface PlannedPriceItem {
  readonly processItemId: string;
  readonly sequence: number;
  readonly quantity: string;
}

export interface PriceItemsPlan {
  readonly lines: readonly PlannedPriceItem[];
  readonly errors: readonly FieldError[];
}

/**
 * RN-PRICE-03/04/11 · V-02/V-04: as linhas da criação (PRS-02) ou da inclusão (PRS-06). Sem
 * `requested` (criação), entram todos os itens disponíveis na ordem de `sequence`. Item
 * inexistente, excluído, de outro processo ou de outro tenant → `REFERENCE_NOT_FOUND` em
 * `items[i].processItemId` (indistinguíveis); já presente na pesquisa → `DUPLICATE_IN_LIST`;
 * quantidade ausente sem padrão, ≤ 0, com mais de 4 casas ou fracionária em unidade inteira →
 * `REQUIRED`/`OUT_OF_RANGE`/`INVALID_DECIMAL` em `items[i].quantity`. A repetição dentro da lista
 * (V-03) já foi barrada pelo schema.
 */
export function planPriceItems(input: {
  readonly requested: readonly PriceItemInput[] | undefined;
  readonly available: readonly ResearchableItem[];
  readonly alreadyIncluded?: ReadonlySet<string>;
}): PriceItemsPlan {
  const byId = new Map(input.available.map((item) => [item.id, item]));
  const requested: readonly PriceItemInput[] =
    input.requested ??
    [...input.available]
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => ({ processItemId: item.id }));
  const lines: PlannedPriceItem[] = [];
  const errors: FieldError[] = [];
  requested.forEach((line, index) => {
    const item = byId.get(line.processItemId);
    if (item === undefined) {
      errors.push({
        field: `items[${String(index)}].processItemId`,
        code: 'REFERENCE_NOT_FOUND',
        message: PRICE_RESEARCH_MESSAGES.itemInvalid,
      });
      return;
    }
    if (input.alreadyIncluded?.has(item.id) === true) {
      errors.push({
        field: `items[${String(index)}].processItemId`,
        code: 'DUPLICATE_IN_LIST',
        message: PRICE_RESEARCH_MESSAGES.itemAlreadyIncluded,
      });
      return;
    }
    const quantity = line.quantity ?? item.defaultQuantity;
    const issue = priceItemQuantityIssue(quantity, item.allowsDecimal);
    if (issue !== null || quantity === null) {
      errors.push({
        field: `items[${String(index)}].quantity`,
        code: issue?.code ?? 'REQUIRED',
        message: issue?.message ?? PRICE_RESEARCH_MESSAGES.quantityInvalid,
      });
      return;
    }
    lines.push({
      processItemId: item.id,
      sequence: item.sequence,
      quantity: normalizeQuantity(quantity),
    });
  });
  return { lines, errors };
}

/** V-05 (RN-PRICE-06): erro de campo para a data-base futura, ou nenhum. */
export function referenceDateErrors(referenceDate: string, today: string): FieldError[] {
  const issue = referenceDateIssue(referenceDate, today);
  return issue === null ? [] : [{ field: 'referenceDate', ...issue }];
}

// --- Alertas, contadores e recálculo (US-024/US-026/US-029) --------------------------------------

/**
 * Alertas de cotação de um item: sem cotação válida → `NO_VALID_QUOTES`; menos que o mínimo do
 * snapshot → `BELOW_MINIMUM_QUOTES`. Os demais (`HIGH_CV`, `HAS_OUTLIERS`, `EXPIRED_QUOTES`) dependem
 * da estatística (US-029/US-030).
 */
export function quotationAlerts(
  validQuotationsCount: number,
  parameters: Pick<PriceResearchParameters, 'minQuotations'>,
): PriceItemAlert[] {
  const alerts: PriceItemAlert[] = [];
  if (validQuotationsCount === 0) alerts.push({ code: 'NO_VALID_QUOTES' });
  if (validQuotationsCount < parameters.minQuotations)
    alerts.push({ code: 'BELOW_MINIMUM_QUOTES' });
  return alerts;
}

/** `itemsCount`/`itemsWithAlertsCount` do cabeçalho a partir das linhas atuais. */
export function countersOf(items: readonly Pick<PriceItem, 'alerts'>[]): {
  readonly itemsCount: number;
  readonly itemsWithAlertsCount: number;
} {
  return {
    itemsCount: items.length,
    itemsWithAlertsCount: items.filter((item) => item.alerts.length > 0).length,
  };
}

/**
 * `PriceResearchRecalculator` (US-024 FA-07 · RN-PRICE-27 da US-026 · RN-PRICE-41..47 da US-029):
 * reavalia, por item, as cotações válidas (`validPrices` — preços das cotações `status = VALID`), as
 * estatísticas, o método efetivo, o preço recomendado e o total (`calculatePriceItem`), os alertas
 * (mínimo do snapshot) e o cabeçalho (contadores, valor estimado e `lastCalculatedAt`). Idempotente:
 * só as linhas cujo resultado mudou voltam em `changedItems`.
 */
export function recalculate(
  research: PriceResearch,
  items: readonly PriceItem[],
  stamp: { readonly now: Date; readonly userId: string | null },
  validPrices: ReadonlyMap<string, readonly string[]>,
): { readonly research: PriceResearch; readonly changedItems: readonly PriceItem[] } {
  const changedItems: PriceItem[] = [];
  const next = items.map((item) => {
    const changed = recalculateItem(
      item,
      validPrices.get(item.id) ?? [],
      research.parameters,
      stamp,
    );
    if (changed === item) return item;
    changedItems.push(changed);
    return changed;
  });
  return {
    research: {
      ...research,
      ...countersOf(next),
      totalEstimatedValue: totalEstimatedValueOf(next),
      lastCalculatedAt: stamp.now,
      updatedAt: stamp.now,
      updatedById: stamp.userId,
    },
    changedItems,
  };
}

/**
 * `PriceItem.recalculate`: o item com os campos calculados e os alertas atuais; devolve o próprio
 * item (mesma referência) quando nada mudou.
 */
export function recalculateItem(
  item: PriceItem,
  validPrices: readonly string[],
  parameters: PriceResearchParameters,
  stamp: { readonly now: Date; readonly userId: string | null },
): PriceItem {
  const calculation = calculatePriceItem(item, validPrices, parameters);
  const alerts = quotationAlerts(calculation.validQuotationsCount, parameters);
  if (sameCalculation(calculation, item) && sameAlerts(alerts, item.alerts)) return item;
  return {
    ...item,
    ...calculation,
    alerts,
    calculatedAt: stamp.now,
    updatedAt: stamp.now,
    updatedById: stamp.userId,
  };
}

const sameAlerts = (a: readonly PriceItemAlert[], b: readonly PriceItemAlert[]) =>
  a.length === b.length && a.every((alert, index) => alert.code === b[index]?.code);

// --- Fábricas ----------------------------------------------------------------------------------

export interface PriceResearchCreation {
  readonly documentId: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly referenceDate: string;
  readonly parameters: PriceResearchParameters;
  readonly creatorId: string;
  readonly now: Date;
}

/** `PriceResearch.create` (RN-PRICE-05/06): versão 1, contadores pelas linhas criadas. */
export function createPriceResearch(
  input: PriceResearchCreation,
  items: readonly Pick<PriceItem, 'alerts'>[],
): PriceResearch {
  return {
    id: input.documentId,
    tenantId: input.tenantId,
    processId: input.processId,
    documentId: input.documentId,
    referenceDate: input.referenceDate,
    parameters: input.parameters,
    totalEstimatedValue: null,
    ...countersOf(items),
    lastCalculatedAt: input.now,
    completedAt: null,
    completedById: null,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.creatorId,
    updatedById: input.creatorId,
    version: 1,
  };
}

/**
 * `PriceItem.create`: sem cotações, já calculado (método efetivo resolvido — US-029 — e alertas do
 * cálculo inicial) e `sortOrder = sequence`.
 */
export function createPriceItem(
  line: PlannedPriceItem,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly priceResearchId: string;
    readonly parameters: PriceResearchParameters;
    readonly userId: string | null;
    readonly now: Date;
  },
): PriceItem {
  return {
    id: input.id,
    tenantId: input.tenantId,
    priceResearchId: input.priceResearchId,
    processItemId: line.processItemId,
    quantity: line.quantity,
    methodOverride: null,
    ...calculatePriceItem(
      { quantity: line.quantity, methodOverride: null, manualUnitPrice: null },
      [],
      input.parameters,
    ),
    manualUnitPrice: null,
    manualJustification: null,
    belowMinimumJustification: null,
    alerts: quotationAlerts(0, input.parameters),
    notes: null,
    sortOrder: line.sequence,
    calculatedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.userId,
    updatedById: input.userId,
    version: 1,
  };
}

// --- PRS-07: quantidade e método do item (US-029) ----------------------------------------------

/** Campos editáveis do item (PRS-07). */
export type PriceItemEditable = Pick<
  PriceItem,
  'quantity' | 'methodOverride' | 'manualUnitPrice' | 'manualJustification'
>;

export interface PriceItemUpdatePlan {
  /** Os campos editáveis depois do patch (normalizados); `null` quando há erro. */
  readonly next: PriceItemEditable | null;
  readonly errors: readonly FieldError[];
  /** Algum campo mudou de fato (reenvio idêntico não grava — cenário [Duplicidade]). */
  readonly changed: boolean;
  /** `methodOverride` mudou (`price_research.method_change`). */
  readonly methodChanged: boolean;
}

/**
 * `PriceItem.setMethodOverride` (RN-PRICE-42/43 · V-01/V-02/V-05 · FA-01/FA-02): mescla o patch no
 * item. Com `MANUAL`, valor (> 0, até `unitPriceDecimals` casas) e justificativa (≥ 20) são
 * obrigatórios — os ausentes no corpo vêm do item. Fora de `MANUAL`, valor e justificativa manuais
 * são apagados. Quantidade pela mesma regra da criação (RN-PRICE-04).
 */
export function planPriceItemUpdate(
  item: PriceItemEditable,
  patch: UpdatePriceItem,
  rules: { readonly allowsDecimal: boolean; readonly unitPriceDecimals: 2 | 4 },
): PriceItemUpdatePlan {
  const errors: FieldError[] = [];
  let quantity = item.quantity;
  if (patch.quantity !== undefined) {
    const issue = priceItemQuantityIssue(patch.quantity, rules.allowsDecimal);
    if (issue === null) quantity = normalizeQuantity(patch.quantity);
    else {
      errors.push({
        field: 'quantity',
        code: issue.code,
        message:
          issue.code === 'OUT_OF_RANGE' ? PRICE_RESEARCH_MESSAGES.quantityPositive : issue.message,
      });
    }
  }
  const methodOverride =
    patch.methodOverride === undefined ? item.methodOverride : patch.methodOverride;
  let manualUnitPrice: string | null = null;
  let manualJustification: string | null = null;
  if (methodOverride === 'MANUAL') {
    const price =
      patch.manualUnitPrice === undefined ? item.manualUnitPrice : patch.manualUnitPrice;
    const justification =
      patch.manualJustification === undefined
        ? item.manualJustification
        : patch.manualJustification;
    // A escala vale para o valor enviado; o gravado já está na coluna (18,4).
    const issues = manualPriceIssues(
      { manualUnitPrice: price, manualJustification: justification },
      patch.manualUnitPrice === undefined ? 4 : rules.unitPriceDecimals,
    );
    errors.push(...issues);
    if (issues.length === 0 && price !== null && justification !== null) {
      manualUnitPrice = new Decimal(price.trim()).toFixed(4);
      manualJustification = justification.trim();
    }
  }
  if (errors.length > 0) {
    return { next: null, errors, changed: false, methodChanged: false };
  }
  const next = { quantity, methodOverride, manualUnitPrice, manualJustification };
  const methodChanged = methodOverride !== item.methodOverride;
  return {
    next,
    errors,
    methodChanged,
    changed:
      methodChanged ||
      quantity !== item.quantity ||
      manualUnitPrice !== item.manualUnitPrice ||
      manualJustification !== item.manualJustification,
  };
}

/** RN-PRICE-11 · V-10: a pesquisa precisa de ao menos um item (remover o último é proibido). */
export function canRemoveItem(itemsCount: number): boolean {
  return itemsCount > 1;
}

/** Cabeçalho com nova data-base (RN-PRICE-06) — o recálculo vem em seguida. */
export function withReferenceDate(research: PriceResearch, referenceDate: string): PriceResearch {
  return { ...research, referenceDate };
}

/**
 * RN-PRICE-47 (PRS-04): os parâmetros de cálculo alterados de fato (percentuais normalizados a 4
 * casas). Vazio = nada a recalcular por parâmetro.
 */
export function calculationParameterChanges(
  current: PriceResearchParameters,
  patch: PriceResearchCalculationPatch,
): {
  readonly parameters: PriceResearchParameters;
  readonly changed: readonly PriceResearchCalculationField[];
} {
  const normalized: PriceResearchCalculationPatch = {
    ...patch,
    ...(patch.cvThresholdPercent === undefined
      ? {}
      : { cvThresholdPercent: new Decimal(patch.cvThresholdPercent).toFixed(4) }),
    ...(patch.outlierLowerPercent === undefined
      ? {}
      : { outlierLowerPercent: new Decimal(patch.outlierLowerPercent).toFixed(4) }),
    ...(patch.outlierUpperPercent === undefined
      ? {}
      : { outlierUpperPercent: new Decimal(patch.outlierUpperPercent).toFixed(4) }),
  };
  const changed = PRICE_RESEARCH_CALCULATION_FIELDS.filter(
    (field) => normalized[field] !== undefined && normalized[field] !== current[field],
  );
  const parameters: PriceResearchParameters = { ...current };
  for (const field of changed) Object.assign(parameters, { [field]: normalized[field] });
  return { parameters, changed };
}

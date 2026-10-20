import { z } from 'zod';

import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';
import { percentageSchema, quantitySchema } from '../common/decimal.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { dfdTemplateSectionSchema } from '../dfd/dfd.js';
import { DOCUMENT_ITEM_LIMITS, documentItemQuantityIssue } from '../document/document-items.js';
import type { QuantityIssue } from '../document/document-items.js';
import { CONFIDENTIALITIES, DOCUMENT_STATUSES } from '../document/document-type.js';
import { DOCUMENT_ACTIONS } from '../document/document.js';
import { PRICE_DEFAULT_METHODS } from '../tenancy/settings.js';

/*
 * Pesquisa de preços (US-024 · entities.md §4.8 `PriceResearch`/`PriceItem` · api/07 PRS-01..08 ·
 * DEC-020). O cabeçalho tipado 1:1 do `Document` do tipo `PRICE_RESEARCH` (mesmo id — como o DFD),
 * com o snapshot dos parâmetros `priceResearch.*` fixado na criação (RN-PRICE-05), e uma linha
 * `PriceItem` por item do processo. Os mesmos schemas servem à API (corpo, resposta, OpenAPI), ao
 * diálogo de criação (SCR-006) e à SCR-009.
 */

/** `PriceCalculationMethod` (entities.md §2): método efetivo/forçado de um item. */
export const PRICE_CALCULATION_METHODS = ['MEAN', 'MEDIAN', 'LOWEST', 'MANUAL'] as const;
export type PriceCalculationMethod = (typeof PRICE_CALCULATION_METHODS)[number];

export type PriceDefaultMethod = (typeof PRICE_DEFAULT_METHODS)[number];

export const PRICE_ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN'] as const;
export type PriceRoundingMode = (typeof PRICE_ROUNDING_MODES)[number];

/** Alertas de um item (entities.md `PriceItem.alerts` · US-029/US-030). */
export const PRICE_ITEM_ALERT_CODES = [
  'NO_VALID_QUOTES',
  'BELOW_MINIMUM_QUOTES',
  'HIGH_CV',
  'HAS_OUTLIERS',
  'EXPIRED_QUOTES',
] as const;
export type PriceItemAlertCode = (typeof PRICE_ITEM_ALERT_CODES)[number];

/** Ações da pesquisa para o usuário (`meta.allowedActions` do PRS-03 — botões da SCR-009). */
export const PRICE_RESEARCH_ACTIONS = [
  'UPDATE',
  'ADD_ITEMS',
  'REMOVE_ITEMS',
  // US-027: `PRICE_RESEARCH_EXCLUDE_QUOTATION` cobrindo o processo + as mesmas travas de edição.
  'EXCLUDE_QUOTATION',
  // US-032: `PRICE_RESEARCH_COMPLETE` cobrindo o processo + as mesmas travas de edição (PRS-23).
  'COMPLETE',
] as const;
export type PriceResearchAction = (typeof PRICE_RESEARCH_ACTIONS)[number];

/** Por que a pesquisa não pode ser alterada pelo usuário agora (explicação dos botões). */
export const PRICE_RESEARCH_LOCK_REASONS = [
  'PERMISSION_DENIED',
  'NOT_CUSTODIAN',
  'INVALID_PROCESS_STATUS',
  'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
  'DOCUMENT_NOT_EDITABLE',
  'CONFIDENTIAL_BUDGET',
] as const;
export type PriceResearchLockReason = (typeof PRICE_RESEARCH_LOCK_REASONS)[number];

export const PRICE_RESEARCH_LIMITS = Object.freeze({
  titleMin: 5,
  titleMax: 250,
  /** Itens por criação/inclusão: o mesmo teto dos itens do processo (RN-PROC-83). */
  itemsMax: DOCUMENT_ITEM_LIMITS.itemsMax,
});

/** Mensagens (V-01..V-11, FA-01..FA-09) compartilhadas pela API e pelas telas. */
export const PRICE_RESEARCH_MESSAGES = Object.freeze({
  itemsRequired: 'Selecione ao menos um item.',
  itemInvalid: 'Selecione itens deste processo.',
  itemDuplicated: (sequence: number | null) =>
    sequence === null
      ? 'O item foi informado mais de uma vez.'
      : `O item ${String(sequence)} foi informado mais de uma vez.`,
  quantityInvalid: 'Informe uma quantidade maior que zero (até 4 casas decimais).',
  quantityInteger: 'Esta unidade aceita apenas números inteiros.',
  quantityMissing: 'Informe a quantidade',
  referenceDateRequired: 'Informe a data-base.',
  referenceDateFuture: 'A data-base não pode ser posterior a hoje.',
  titleLength: `O título deve ter entre ${String(PRICE_RESEARCH_LIMITS.titleMin)} e ${String(PRICE_RESEARCH_LIMITS.titleMax)} caracteres.`,
  templateInvalid: 'Selecione um modelo válido.',
  noProcessItems: 'Cadastre os itens da contratação antes de criar a pesquisa.',
  alreadyExists: 'Este processo já tem uma pesquisa de preços.',
  typeNotAllowedInStage: 'A etapa atual não permite criar pesquisa de preços.',
  notCustodian: 'Você não pode criar a pesquisa deste processo agora.',
  permissionDenied: 'Você não tem permissão para alterar esta pesquisa de preços.',
  confidentialDenied:
    'O orçamento deste processo é sigiloso. Você não pode alterar a pesquisa de preços.',
  locked: 'A pesquisa está concluída. Reabra-a para alterar.',
  lastItem: 'A pesquisa precisa de ao menos um item.',
  snapshotParameter: 'Este parâmetro foi fixado na criação da pesquisa.',
  itemAlreadyIncluded: 'Este item já está na pesquisa.',
  notFound: 'Pesquisa de preços não encontrada.',
  itemNotFound: 'Item da pesquisa não encontrado.',
  versionConflict: 'A pesquisa foi alterada por outra pessoa. Recarregue.',
  instructions: 'Registre as fontes consultadas e os preços de cada item',
  parametersNote: (date: string) =>
    `Definidos pelo órgão em ${date}. Alterações posteriores nas configurações não afetam esta pesquisa.`,
  // US-029 — cálculo (V-01..V-05 · "Casos de erro").
  manualRequired: 'Informe o valor manual e a justificativa (mín. 20 caracteres).',
  manualPriceInvalid: (decimals: number) =>
    `Informe um valor válido, com até ${String(decimals)} casas decimais.`,
  methodInvalid: 'Selecione um método válido.',
  calculatedField: 'Este campo é calculado pelo sistema e não pode ser alterado diretamente.',
  quantityPositive: 'Informe uma quantidade maior que zero.',
  itemVersionConflict:
    'Este item foi alterado por outra pessoa. Recarregue para ver a versão atual.',
  recalculateUnavailable: 'Não foi possível calcular agora. Tente novamente em instantes.',
  parameterInvalid: 'Informe um valor dentro da faixa permitida.',
  // US-030 — V-02.
  outlierRange: 'O limite inferior de destaque deve ser menor que o superior.',
});

/** Título sugerido (RN-PRICE-07): "Pesquisa de preços — {código do processo}". */
export function priceResearchDocumentTitle(processCode: string | null): string {
  return processCode === null || processCode === ''
    ? 'Pesquisa de preços'
    : `Pesquisa de preços — ${processCode}`;
}

// --- Regras compartilhadas (RN-PRICE-04/06 · V-04/V-05) ------------------------------------------

/**
 * V-04 (RN-PRICE-04): a MESMA regra da quantidade dos itens de documento (> 0, até 4 casas, inteira
 * quando a unidade não admite decimais), com as mensagens da pesquisa.
 */
export function priceItemQuantityIssue(
  quantity: string | null | undefined,
  allowsDecimal: boolean,
): QuantityIssue | null {
  const issue = documentItemQuantityIssue(quantity, allowsDecimal);
  if (issue === null) return null;
  const integerOnly =
    issue.code === 'INVALID_DECIMAL' && !allowsDecimal && quantityIsNumeric(quantity);
  return {
    code: issue.code,
    message: integerOnly
      ? PRICE_RESEARCH_MESSAGES.quantityInteger
      : PRICE_RESEARCH_MESSAGES.quantityInvalid,
  };
}

function quantityIsNumeric(quantity: string | null | undefined): boolean {
  const value = quantity?.trim() ?? '';
  const [, fraction = ''] = value.split('.');
  return (
    /^\d{1,14}(?:\.\d+)?$/.test(value) && fraction.length <= DOCUMENT_ITEM_LIMITS.quantityScale
  );
}

/** V-05 (RN-PRICE-06): data-base `AAAA-MM-DD` não posterior a hoje (fuso do tenant). */
export function referenceDateIssue(referenceDate: string, today: string): QuantityIssue | null {
  return referenceDate > today
    ? { code: 'OUT_OF_RANGE', message: PRICE_RESEARCH_MESSAGES.referenceDateFuture }
    : null;
}

/** RN-PRICE-43: justificativa mínima do valor manual (entities.md `PriceItem.manualJustification`). */
export const MANUAL_JUSTIFICATION_MIN = 20;

/** Erro de campo do método manual (V-01/V-02), com o código da API. */
export interface ManualPriceIssue {
  readonly field: 'manualUnitPrice' | 'manualJustification';
  readonly code: 'CONDITIONAL_REQUIRED' | 'INVALID_DECIMAL';
  readonly message: string;
}

/**
 * V-01/V-02 (RN-PRICE-43): com `MANUAL`, o valor (> 0, até `unitPriceDecimals` casas) e a
 * justificativa (≥ 20 caracteres sem os espaços das pontas) são obrigatórios. A MESMA regra no
 * formulário da SCR-009 e no PRS-07.
 */
export function manualPriceIssues(
  input: {
    readonly manualUnitPrice: string | null | undefined;
    readonly manualJustification: string | null | undefined;
  },
  unitPriceDecimals: 2 | 4,
): ManualPriceIssue[] {
  const issues: ManualPriceIssue[] = [];
  const price = input.manualUnitPrice?.trim() ?? '';
  if (price === '') {
    issues.push({
      field: 'manualUnitPrice',
      code: 'CONDITIONAL_REQUIRED',
      message: PRICE_RESEARCH_MESSAGES.manualRequired,
    });
  } else {
    const pattern = new RegExp(String.raw`^\d{1,14}(?:\.\d{1,${String(unitPriceDecimals)}})?$`);
    if (!pattern.test(price) || !/[1-9]/.test(price)) {
      issues.push({
        field: 'manualUnitPrice',
        code: 'INVALID_DECIMAL',
        message: PRICE_RESEARCH_MESSAGES.manualPriceInvalid(unitPriceDecimals),
      });
    }
  }
  if ((input.manualJustification?.trim() ?? '').length < MANUAL_JUSTIFICATION_MIN) {
    issues.push({
      field: 'manualJustification',
      code: 'CONDITIONAL_REQUIRED',
      message: PRICE_RESEARCH_MESSAGES.manualRequired,
    });
  }
  return issues;
}

// --- Contratos ---------------------------------------------------------------------------------

/** Linha do corpo do PRS-02/PRS-06: o item do processo e, opcionalmente, a quantidade. */
export const priceItemInputSchema = z.strictObject({
  processItemId: uuidV7Schema,
  /** Decimal como string (DEC-003); a regra da unidade (V-04) é conferida no caso de uso. */
  quantity: z.string().max(40).optional(),
});
export type PriceItemInput = z.infer<typeof priceItemInputSchema>;

/** V-01/V-03: lista não vazia e sem repetição (`items[i].processItemId`). */
function checkItemList(
  items: readonly PriceItemInput[] | undefined,
  context: z.core.$RefinementCtx,
): void {
  if (items === undefined) return;
  if (items.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['items'],
      params: { code: 'REQUIRED' },
      message: PRICE_RESEARCH_MESSAGES.itemsRequired,
    });
    return;
  }
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.processItemId)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'processItemId'],
        params: { code: 'DUPLICATE_IN_LIST' },
        message: PRICE_RESEARCH_MESSAGES.itemDuplicated(null),
      });
    }
    seen.add(item.processItemId);
  });
}

const titleSchema = z
  .string()
  .trim()
  .min(PRICE_RESEARCH_LIMITS.titleMin, { error: PRICE_RESEARCH_MESSAGES.titleLength })
  .max(PRICE_RESEARCH_LIMITS.titleMax, { error: PRICE_RESEARCH_MESSAGES.titleLength });

/** PRS-02 — `POST /processes/{id}/price-research` (`Idempotency-Key` obrigatório). */
export const createPriceResearchSchema = z
  .strictObject({
    /** 5–250; padrão "Pesquisa de preços — {código do processo}". */
    title: titleSchema.optional(),
    /** Ativo, publicado, do tipo; padrão: o template padrão do tipo (RN-PRICE-07). */
    templateId: uuidV7Schema.optional(),
    /** `AAAA-MM-DD`, ≤ hoje no fuso do tenant (conferido no caso de uso); padrão: hoje. */
    referenceDate: isoDateSchema.optional(),
    /** ≥ 1, sem repetição; padrão: todos os itens não excluídos do processo (RN-PRICE-03). */
    items: z.array(priceItemInputSchema).max(PRICE_RESEARCH_LIMITS.itemsMax).optional(),
  })
  .superRefine((value, context) => {
    checkItemList(value.items, context);
  })
  .meta({ id: 'PriceResearchCreateRequest' });
export type CreatePriceResearch = z.infer<typeof createPriceResearchSchema>;

/** Parâmetros do snapshot (RN-PRICE-05). */
export const PRICE_RESEARCH_SNAPSHOT_FIELDS = [
  'defaultMethod',
  'cvThresholdPercent',
  'minQuotations',
  'directQuoteMaxAgeDays',
  'similarContractMaxAgeDays',
  'outlierLowerPercent',
  'outlierUpperPercent',
  'unitPriceDecimals',
  'roundingMode',
] as const;

/**
 * RN-PRICE-47 (US-029): parâmetros de cálculo editáveis no PRS-04 — alterá-los recalcula todos os
 * itens. Os prazos de validade (`directQuoteMaxAgeDays`/`similarContractMaxAgeDays`) seguem fixados
 * na criação (422 `NOT_ALLOWED`).
 */
export const PRICE_RESEARCH_CALCULATION_FIELDS = [
  'defaultMethod',
  'cvThresholdPercent',
  'minQuotations',
  'outlierLowerPercent',
  'outlierUpperPercent',
  'unitPriceDecimals',
  'roundingMode',
] as const;
export type PriceResearchCalculationField = (typeof PRICE_RESEARCH_CALCULATION_FIELDS)[number];

const FIXED_SNAPSHOT_FIELDS = PRICE_RESEARCH_SNAPSHOT_FIELDS.filter(
  (field) => !(PRICE_RESEARCH_CALCULATION_FIELDS as readonly string[]).includes(field),
);

/** Percentual `numeric(9,4)` como string, numa faixa (mesmas faixas de `priceResearch.*`). */
const percentInRange = (check: (value: number) => boolean) =>
  percentageSchema.refine((value) => check(Number(value)), {
    error: PRICE_RESEARCH_MESSAGES.parameterInvalid,
    params: { code: 'OUT_OF_RANGE' },
  });

/**
 * PRS-04 — `PATCH /price-research/{id}` (`If-Match` obrigatório): data-base, título e (US-029) os
 * parâmetros de cálculo, nas faixas das configurações `priceResearch.*`. Os prazos de validade do
 * snapshot no corpo → 422 `NOT_ALLOWED` (V-10 da US-024).
 */
export const updatePriceResearchSchema = z
  .strictObject({
    referenceDate: isoDateSchema.optional(),
    title: titleSchema.optional(),
    defaultMethod: z.enum(PRICE_DEFAULT_METHODS).optional(),
    cvThresholdPercent: percentInRange((value) => value > 0 && value <= 1000).optional(),
    minQuotations: z.int().min(1).max(10).optional(),
    outlierLowerPercent: percentInRange((value) => value > 0 && value <= 100).optional(),
    outlierUpperPercent: percentInRange((value) => value >= 100 && value <= 1000).optional(),
    unitPriceDecimals: z.union([z.literal(2), z.literal(4)]).optional(),
    roundingMode: z.enum(PRICE_ROUNDING_MODES).optional(),
    ...Object.fromEntries(FIXED_SNAPSHOT_FIELDS.map((field) => [field, z.unknown().optional()])),
  })
  .superRefine((value, context) => {
    for (const field of FIXED_SNAPSHOT_FIELDS) {
      if ((value as Record<string, unknown>)[field] === undefined) continue;
      context.addIssue({
        code: 'custom',
        path: [field],
        params: { code: 'NOT_ALLOWED' },
        message: PRICE_RESEARCH_MESSAGES.snapshotParameter,
      });
    }
  })
  .meta({ id: 'PriceResearchUpdateRequest' });

/** Parâmetros de cálculo alterados no PRS-04 (US-029). */
export type PriceResearchCalculationPatch = Partial<
  Pick<PriceResearchParameters, PriceResearchCalculationField>
>;

export interface UpdatePriceResearch extends PriceResearchCalculationPatch {
  readonly referenceDate?: string | undefined;
  readonly title?: string | undefined;
}

/** Campos calculados do `PriceItem` — somente leitura no PRS-07 (V-04 · `NOT_ALLOWED`). */
export const PRICE_ITEM_CALCULATED_FIELDS = [
  'effectiveMethod',
  'validQuotationsCount',
  'meanPrice',
  'medianPrice',
  'lowestPrice',
  'highestPrice',
  'stdDeviation',
  'coefficientOfVariation',
  'recommendedUnitPrice',
  'totalPrice',
  'calculatedAt',
  'alerts',
] as const;

/**
 * PRS-07 — `PATCH /price-items/{itemId}` (`If-Match` = versão do item): quantidade e método do item
 * (US-029) e a justificativa de cotações abaixo do mínimo (US-032). `methodOverride: null` volta ao método padrão da pesquisa (FA-02); as regras do valor
 * manual (V-01/V-02) e da quantidade (unidade inteira) são conferidas no caso de uso.
 */
export const updatePriceItemSchema = z
  .strictObject({
    quantity: z.string().max(40).optional(),
    methodOverride: z
      .enum(PRICE_CALCULATION_METHODS, { error: PRICE_RESEARCH_MESSAGES.methodInvalid })
      .nullable()
      .optional(),
    manualUnitPrice: z.string().max(40).nullable().optional(),
    manualJustification: z.string().max(4000).nullable().optional(),
    // US-032 (RN-PRICE-58): justificativa de cotações abaixo do mínimo; `null`/vazio apaga.
    belowMinimumJustification: z.string().max(4000).nullable().optional(),
    ...Object.fromEntries(
      PRICE_ITEM_CALCULATED_FIELDS.map((field) => [field, z.unknown().optional()]),
    ),
  })
  .superRefine((value, context) => {
    for (const field of PRICE_ITEM_CALCULATED_FIELDS) {
      if ((value as Record<string, unknown>)[field] === undefined) continue;
      context.addIssue({
        code: 'custom',
        path: [field],
        params: { code: 'NOT_ALLOWED' },
        message: PRICE_RESEARCH_MESSAGES.calculatedField,
      });
    }
  })
  .meta({ id: 'PriceItemUpdateRequest' });

export interface UpdatePriceItem {
  readonly quantity?: string | undefined;
  readonly methodOverride?: PriceCalculationMethod | null | undefined;
  readonly manualUnitPrice?: string | null | undefined;
  readonly manualJustification?: string | null | undefined;
  readonly belowMinimumJustification?: string | null | undefined;
}

/** PRS-20 — `POST /price-research/{id}/recalculate` (corpo `{}`). */
export const recalculatePriceResearchSchema = z
  .strictObject({})
  .meta({ id: 'PriceResearchRecalculateRequest' });

/** Resposta do PRS-20 (RN-PRICE-45). */
export const priceResearchRecalculationSchema = z
  .object({
    itemsCount: z.int().min(0),
    itemsWithAlertsCount: z.int().min(0),
    lastCalculatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'PriceResearchRecalculation' });
export type PriceResearchRecalculationDto = z.infer<typeof priceResearchRecalculationSchema>;

/** PRS-06 — `POST /price-research/{id}/items`. */
export const addPriceItemsSchema = z
  .strictObject({
    items: z.array(priceItemInputSchema).max(PRICE_RESEARCH_LIMITS.itemsMax),
  })
  .superRefine((value, context) => {
    checkItemList(value.items, context);
  })
  .meta({ id: 'PriceItemsAddRequest' });
export type AddPriceItems = z.infer<typeof addPriceItemsSchema>;

/** PRS-05 — filtros da lista de itens (ordem fixa: `sortOrder`). */
export const priceItemListQuerySchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(100),
    lot: z.coerce.number().int().min(1).optional(),
    hasAlerts: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .meta({ id: 'PriceItemListQuery' });
export type PriceItemListQuery = z.infer<typeof priceItemListQuerySchema>;

export const priceResearchIdParamsSchema = z.strictObject({ id: uuidV7Schema });
export const priceItemIdParamsSchema = z.strictObject({ itemId: uuidV7Schema });

/** Snapshot dos parâmetros (RN-PRICE-05 · DEC-020), percentuais `numeric(9,4)` como string. */
export const priceResearchParametersSchema = z
  .object({
    defaultMethod: z.enum(PRICE_DEFAULT_METHODS),
    cvThresholdPercent: z.string(),
    minQuotations: z.int().min(1),
    directQuoteMaxAgeDays: z.int(),
    similarContractMaxAgeDays: z.int(),
    outlierLowerPercent: z.string(),
    outlierUpperPercent: z.string(),
    unitPriceDecimals: z.union([z.literal(2), z.literal(4)]),
    roundingMode: z.enum(PRICE_ROUNDING_MODES),
  })
  .meta({ id: 'PriceResearchParameters' });
export type PriceResearchParameters = z.infer<typeof priceResearchParametersSchema>;

/** `PriceResearch` (PRS-02/03/04): cabeçalho + resumo do documento (`ETag: "<version>"`). */
export const priceResearchSchema = z
  .object({
    /** = `documentId` (o identificador da SCR-009 e do painel de documentos). */
    id: z.uuid(),
    documentId: z.uuid(),
    processId: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(DOCUMENT_STATUSES),
    confidentiality: z.enum(CONFIDENTIALITIES),
    templateVersionId: z.uuid().nullable(),
    /** `Document.version` (o `If-Match` das seções do documento — DOC-05). */
    documentVersion: z.int(),
    draftRevision: z.int(),
    referenceDate: isoDateSchema,
    parameters: priceResearchParametersSchema,
    itemsCount: z.int().min(0),
    itemsWithAlertsCount: z.int().min(0),
    /** Decimal(18,2); `null` enquanto não calculado ou mascarado (POL-09 · RN-PRICE-12). */
    totalEstimatedValue: z.string().nullable(),
    totalEstimatedValueMasked: z.boolean(),
    lastCalculatedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    pendingApprovalId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    version: z.int(),
  })
  .meta({ id: 'PriceResearch' });
export type PriceResearchDto = z.infer<typeof priceResearchSchema>;

/**
 * `meta` do PRS-02/03/04: ações da pesquisa (SCR-009) e do documento (RN-DOC-18), o motivo do
 * bloqueio (explicação dos botões) e a versão do template fixada (seções `METHODOLOGY`/`CONCLUSION`).
 */
export const priceResearchMetaSchema = z
  .object({
    allowedActions: z.array(z.enum(PRICE_RESEARCH_ACTIONS)),
    documentActions: z.array(z.enum(DOCUMENT_ACTIONS)),
    lockReason: z.enum(PRICE_RESEARCH_LOCK_REASONS).nullable(),
    template: z
      .object({
        versionId: z.uuid(),
        versionNumber: z.int(),
        sections: z.array(dfdTemplateSectionSchema),
      })
      .nullable(),
  })
  .meta({ id: 'PriceResearchMeta' });
export type PriceResearchMeta = z.infer<typeof priceResearchMetaSchema>;

/** PRS-01: resumo (0 ou 1 não cancelada + canceladas). */
export const priceResearchSummarySchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(DOCUMENT_STATUSES),
    referenceDate: isoDateSchema,
    itemsCount: z.int().min(0),
    itemsWithAlertsCount: z.int().min(0),
    version: z.int(),
  })
  .meta({ id: 'PriceResearchSummary' });
export type PriceResearchSummaryDto = z.infer<typeof priceResearchSummarySchema>;

export const priceItemAlertSchema = z.object({ code: z.enum(PRICE_ITEM_ALERT_CODES) });
export type PriceItemAlert = z.infer<typeof priceItemAlertSchema>;

/** `PriceItem` (PRS-05/06): a linha do item na pesquisa, com o item do processo para exibição. */
export const priceItemSchema = z
  .object({
    id: z.uuid(),
    priceResearchId: z.uuid(),
    processItemId: z.uuid(),
    /** Nº do item no processo (RN-PROC-73), lote e descrição — exibição da SCR-009. */
    sequence: z.int(),
    lotNumber: z.int().nullable(),
    lotName: z.string().nullable(),
    description: z.string(),
    unit: z.object({ id: z.uuid(), label: z.string(), allowsDecimal: z.boolean() }),
    quantity: quantitySchema,
    methodOverride: z.enum(PRICE_CALCULATION_METHODS).nullable(),
    effectiveMethod: z.enum(PRICE_CALCULATION_METHODS).nullable(),
    validQuotationsCount: z.int().min(0),
    /** Cotações registradas (válidas ou não) — confirmação da remoção (FA-05). */
    quotationsCount: z.int().min(0),
    /** Valores monetários: `null` se ainda não calculados ou mascarados (`valuesMasked`). */
    meanPrice: z.string().nullable(),
    medianPrice: z.string().nullable(),
    lowestPrice: z.string().nullable(),
    highestPrice: z.string().nullable(),
    stdDeviation: z.string().nullable(),
    coefficientOfVariation: z.string().nullable(),
    manualUnitPrice: z.string().nullable(),
    manualJustification: z.string().nullable(),
    recommendedUnitPrice: z.string().nullable(),
    recommendedUnitPriceMasked: z.boolean(),
    totalPrice: z.string().nullable(),
    /** POL-09 (RN-PRICE-12): todos os valores monetários do item vêm `null`. */
    valuesMasked: z.boolean(),
    belowMinimumJustification: z.string().nullable(),
    alerts: z.array(priceItemAlertSchema),
    calculatedAt: isoDateTimeSchema.nullable(),
    sortOrder: z.int(),
    version: z.int(),
  })
  .meta({ id: 'PriceItem' });
export type PriceItemDto = z.infer<typeof priceItemSchema>;

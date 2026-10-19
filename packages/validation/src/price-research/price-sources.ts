import { z } from 'zod';

import { PRICE_RESEARCH_LIMITS } from './price-research.js';
import { PRICE_SOURCE_REQUIRED_FIELDS } from '../catalog/metadata.js';
import type { PriceSourceRequiredField } from '../catalog/metadata.js';
import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Fontes de pesquisa e cotações (US-026 · entities.md §4.8 `PriceSource`/`Quotation` · api/07
 * PRS-09..15). Cada fonte é uma evidência do art. 23, § 1º, da Lei 14.133/2021 cujos campos
 * obrigatórios vêm do tipo (`CatalogItem.metadata.requiredFields` do catálogo `PRICE_SOURCE_TYPE` —
 * RN-PRICE-21); as cotações são lançadas em grade, uma linha por item da pesquisa (RN-PRICE-24). Os
 * mesmos schemas e regras servem à API (corpo, resposta, OpenAPI) e à aba "Fontes" da SCR-009.
 */

/** `QuotationStatus` (entities.md §2). */
export const QUOTATION_STATUSES = ['VALID', 'EXCLUDED'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/** `ExclusionReason` (entities.md §2 · US-027). */
export const EXCLUSION_REASONS = [
  'UNFEASIBLE',
  'EXCESSIVE',
  'INCONSISTENT',
  'EXPIRED',
  'NON_COMPLIANT',
  'OTHER',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** `OutlierFlag` (entities.md §2 · US-030). */
export const OUTLIER_FLAGS = ['NONE', 'LOW', 'HIGH'] as const;
export type OutlierFlag = (typeof OUTLIER_FLAGS)[number];

export const PRICE_SOURCE_LIMITS = Object.freeze({
  descriptionMax: 300,
  urlMax: 2048,
  referenceOrganizationMax: 250,
  referenceDocumentMax: 120,
  longTextMax: 4000,
  brandModelMax: 200,
  /** Justificativa de desconsideração (US-027 · RN-PRICE-30). */
  exclusionJustificationMin: 20,
  exclusionJustificationMax: 4000,
  /** Linhas por grade: uma por item da pesquisa (o teto dos itens). */
  gridMax: PRICE_RESEARCH_LIMITS.itemsMax,
});

/** Campos da fonte que o tipo pode exigir (sem o anexo, que segue o fluxo de upload — RN-PRICE-28). */
export type PriceSourceField = Exclude<PriceSourceRequiredField, 'attachment'>;

/** Rótulos dos campos exigíveis, na ordem do formulário (mensagem de V-01). */
export const PRICE_SOURCE_FIELD_LABELS: Readonly<Record<PriceSourceRequiredField, string>> =
  Object.freeze({
    supplierId: 'fornecedor',
    quoteDate: 'data do orçamento/documento',
    accessedAt: 'data/hora de acesso',
    url: 'URL',
    referenceOrganization: 'órgão de referência',
    referenceDocument: 'documento de referência',
    supplierChoiceJustification: 'justificativa da escolha do fornecedor',
    attachment: 'anexo',
  });

/** Mensagens (V-01..V-09, FA-05/06/08, falha de upload) compartilhadas pela API e pela SCR-009. */
export const PRICE_SOURCE_MESSAGES = Object.freeze({
  requiredFields: (fields: readonly PriceSourceRequiredField[]) =>
    `Para este tipo de fonte, informe: ${fields.map((field) => PRICE_SOURCE_FIELD_LABELS[field]).join(', ')}.`,
  fieldRequired: 'Campo obrigatório para este tipo de fonte.',
  supplierRequired: 'Selecione o fornecedor',
  sourceTypeRequired: 'Selecione o tipo de fonte.',
  sourceTypeInvalid: 'Selecione um tipo de fonte válido.',
  supplierInvalid: 'Selecione um fornecedor válido.',
  descriptionRequired: 'Informe a descrição.',
  descriptionLength: `Informe no máximo ${String(PRICE_SOURCE_LIMITS.descriptionMax)} caracteres.`,
  textLength: (max: number) => `Informe no máximo ${String(max)} caracteres.`,
  urlHttps: 'Informe um endereço iniciado por https://.',
  dateFuture: 'A data informada não pode ser futura.',
  unitPriceInvalid: 'Informe um preço válido, maior que zero.',
  priceItemInvalid: 'Selecione itens desta pesquisa.',
  priceItemDuplicated: 'O item foi informado mais de uma vez.',
  quotationExcluded: 'Esta cotação foi desconsiderada. Restaure-a para editar o preço.',
  notEditable: 'Esta pesquisa de preços não pode mais ser editada.',
  versionConflict: 'Esta fonte foi alterada por outra pessoa. Recarregue os dados.',
  quotationVersionConflict: 'Esta cotação foi alterada por outra pessoa. Recarregue os dados.',
  sourceNotFound: 'Fonte de pesquisa não encontrada.',
  quotationNotFound: 'Cotação não encontrada.',
  permissionDenied: 'Você não tem permissão para editar esta pesquisa de preços.',
  emptyPatch: 'Informe ao menos um campo para alterar.',
  attachmentFailed: 'Não foi possível enviar o anexo agora. Tente novamente.',
  // US-027 (V-01..V-04).
  exclusionReasonRequired: 'Selecione o motivo.',
  exclusionJustificationShort: `A justificativa deve ter no mínimo ${String(PRICE_SOURCE_LIMITS.exclusionJustificationMin)} caracteres.`,
  exclusionJustificationLong: `Informe no máximo ${String(PRICE_SOURCE_LIMITS.exclusionJustificationMax)} caracteres.`,
  alreadyExcluded: 'Esta cotação já está desconsiderada.',
  alreadyValid: 'Esta cotação já está válida.',
  excludePermissionDenied: 'Você não tem permissão para desconsiderar ou restaurar cotações.',
});

// --- Regras compartilhadas (RN-PRICE-21/23/24 · V-01/V-04/V-05/V-06) ----------------------------

/** Valores da fonte conferidos contra `requiredFields` (vazio/nulo = ausente). */
export type PriceSourceFieldValues = Partial<Record<PriceSourceField, string | null | undefined>>;

const isBlank = (value: string | null | undefined) =>
  value === undefined || value === null || value.trim() === '';

/**
 * RN-PRICE-21 · V-01: os campos exigidos pelo tipo que estão ausentes, na ordem de
 * `PRICE_SOURCE_REQUIRED_FIELDS`. O anexo nunca entra: só pode ser enviado depois que a fonte existe
 * (RN-PRICE-28).
 */
export function missingPriceSourceFields(
  values: PriceSourceFieldValues,
  requiredFields: readonly PriceSourceRequiredField[],
): PriceSourceField[] {
  const required = new Set(requiredFields);
  return PRICE_SOURCE_REQUIRED_FIELDS.filter(
    (field): field is PriceSourceField =>
      field !== 'attachment' && required.has(field) && isBlank(values[field]),
  );
}

/** V-04 (RN-PRICE-23): a URL começa com `https://` (e não tem espaços). */
export function isHttpsUrl(value: string): boolean {
  return /^https:\/\/\S+$/i.test(value.trim());
}

/** Problema de um preço unitário: código e mensagem de V-06. */
export interface UnitPriceIssue {
  readonly code: 'INVALID_DECIMAL';
  readonly message: string;
}

/**
 * V-06 (RN-PRICE-24): preço presente, decimal com ponto, > 0, até 14 dígitos inteiros e até
 * `decimals` casas (2 ou 4, conforme o snapshot da pesquisa).
 */
export function unitPriceIssue(
  unitPrice: string | null | undefined,
  decimals: 2 | 4,
): UnitPriceIssue | null {
  const value = unitPrice?.trim() ?? '';
  const pattern = new RegExp(String.raw`^\d{1,14}(?:\.\d{1,${String(decimals)}})?$`);
  if (!pattern.test(value) || !/[1-9]/.test(value)) {
    return { code: 'INVALID_DECIMAL', message: PRICE_SOURCE_MESSAGES.unitPriceInvalid };
  }
  return null;
}

// --- Contratos ---------------------------------------------------------------------------------

/** Texto opcional que pode ser apagado: `""` e `null` viram `null` (campo ausente na regra do tipo). */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: PRICE_SOURCE_MESSAGES.textLength(max) })
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const urlSchema = z
  .string()
  .trim()
  .max(PRICE_SOURCE_LIMITS.urlMax, {
    error: PRICE_SOURCE_MESSAGES.textLength(PRICE_SOURCE_LIMITS.urlMax),
  })
  .transform((value) => (value === '' ? null : value))
  .refine((value) => value === null || isHttpsUrl(value), {
    error: PRICE_SOURCE_MESSAGES.urlHttps,
    params: { code: 'INVALID_FORMAT' },
  })
  .nullable()
  .optional();

const descriptionSchema = z
  .string({ error: PRICE_SOURCE_MESSAGES.descriptionRequired })
  .trim()
  .min(1, { error: PRICE_SOURCE_MESSAGES.descriptionRequired })
  .max(PRICE_SOURCE_LIMITS.descriptionMax, { error: PRICE_SOURCE_MESSAGES.descriptionLength });

const priceSourceFields = {
  /** Fornecedor ativo do tenant (RN-PRICE-22) — conferido no caso de uso. */
  supplierId: uuidV7Schema.nullable().optional(),
  /** `AAAA-MM-DD`, não futura no fuso do tenant (V-05 — conferido no caso de uso). */
  quoteDate: isoDateSchema.nullable().optional(),
  /** Data e hora da consulta ao sítio eletrônico (art. 23, § 1º, III), não futura. */
  accessedAt: isoDateTimeSchema.nullable().optional(),
  url: urlSchema,
  referenceOrganization: clearableText(PRICE_SOURCE_LIMITS.referenceOrganizationMax),
  referenceDocument: clearableText(PRICE_SOURCE_LIMITS.referenceDocumentMax),
  supplierChoiceJustification: clearableText(PRICE_SOURCE_LIMITS.longTextMax),
  notes: clearableText(PRICE_SOURCE_LIMITS.longTextMax),
};

/** PRS-10 — `POST /price-research/{id}/sources` (`Idempotency-Key`). */
export const createPriceSourceSchema = z
  .strictObject({
    sourceTypeId: uuidV7Schema,
    description: descriptionSchema,
    ...priceSourceFields,
  })
  .meta({ id: 'PriceSourceCreateRequest' });
export type CreatePriceSource = z.infer<typeof createPriceSourceSchema>;

/** PRS-11 — `PATCH /price-sources/{sourceId}` (`If-Match`): campos de PRS-10, parciais. */
export const updatePriceSourceSchema = z
  .strictObject({
    sourceTypeId: uuidV7Schema.optional(),
    description: descriptionSchema.optional(),
    ...priceSourceFields,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    error: PRICE_SOURCE_MESSAGES.emptyPatch,
    params: { code: 'REQUIRED' },
  })
  .meta({ id: 'PriceSourceUpdateRequest' });
export type UpdatePriceSource = z.infer<typeof updatePriceSourceSchema>;

/** Linha da grade (PRS-13): sem preço = linha vazia, ignorada (não altera a cotação do item). */
export const quotationLineSchema = z.strictObject({
  priceItemId: uuidV7Schema,
  /** Decimal como string (DEC-003); > 0 e casas do snapshot (V-06) conferidas no caso de uso. */
  unitPrice: z.string().max(40).nullable().optional(),
  brandModel: clearableText(PRICE_SOURCE_LIMITS.brandModelMax),
});
export type QuotationLine = z.infer<typeof quotationLineSchema>;

/** PRS-13 — `PUT /price-sources/{sourceId}/quotations` (`If-Match` = versão da fonte). */
export const upsertQuotationsSchema = z
  .strictObject({
    items: z.array(quotationLineSchema).max(PRICE_SOURCE_LIMITS.gridMax),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.items.forEach((line, index) => {
      if (seen.has(line.priceItemId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'priceItemId'],
          params: { code: 'DUPLICATE_IN_LIST' },
          message: PRICE_SOURCE_MESSAGES.priceItemDuplicated,
        });
      }
      seen.add(line.priceItemId);
    });
  })
  .meta({ id: 'QuotationsUpsertRequest' });
export type UpsertQuotations = z.infer<typeof upsertQuotationsSchema>;

/** PRS-14 — `PATCH /quotations/{quotationId}` (`If-Match` = versão da cotação). */
export const updateQuotationSchema = z
  .strictObject({
    unitPrice: z.string().max(40).optional(),
    brandModel: clearableText(PRICE_SOURCE_LIMITS.brandModelMax),
  })
  .refine((value) => value.unitPrice !== undefined || value.brandModel !== undefined, {
    error: PRICE_SOURCE_MESSAGES.emptyPatch,
    params: { code: 'REQUIRED' },
  })
  .meta({ id: 'QuotationUpdateRequest' });
export type UpdateQuotation = z.infer<typeof updateQuotationSchema>;

/**
 * PRS-16 — `POST /quotations/{quotationId}/exclude` (`If-Match` = versão da cotação): motivo
 * (`ExclusionReason`) e justificativa de no mínimo 20 caracteres (RN-PRICE-30 · V-01/V-02).
 */
export const excludeQuotationSchema = z
  .strictObject({
    // Ausente → `REQUIRED` (V-01); presente e fora do enum → `INVALID_ENUM`. O `pipe` a partir de
    // `string` é o que dá o `REQUIRED` (um `z.enum` ausente vira `INVALID_ENUM`).
    exclusionReason: z
      .string({ error: PRICE_SOURCE_MESSAGES.exclusionReasonRequired })
      .pipe(z.enum(EXCLUSION_REASONS, { error: PRICE_SOURCE_MESSAGES.exclusionReasonRequired }))
      .meta({ description: `ExclusionReason: ${EXCLUSION_REASONS.join(' | ')}.` }),
    exclusionJustification: z
      .string({ error: PRICE_SOURCE_MESSAGES.exclusionJustificationShort })
      .trim()
      .min(PRICE_SOURCE_LIMITS.exclusionJustificationMin, {
        error: PRICE_SOURCE_MESSAGES.exclusionJustificationShort,
      })
      .max(PRICE_SOURCE_LIMITS.exclusionJustificationMax, {
        error: PRICE_SOURCE_MESSAGES.exclusionJustificationLong,
      }),
  })
  .meta({ id: 'QuotationExcludeRequest' });
export type ExcludeQuotation = z.infer<typeof excludeQuotationSchema>;

export const priceSourceIdParamsSchema = z.strictObject({ sourceId: uuidV7Schema });
export const quotationIdParamsSchema = z.strictObject({ quotationId: uuidV7Schema });

/** `Quotation` (PRS-09/13/14): o preço de um item numa fonte; `unitPrice` sob POL-09. */
export const quotationSchema = z
  .object({
    id: z.uuid(),
    priceResearchId: z.uuid(),
    priceItemId: z.uuid(),
    priceSourceId: z.uuid(),
    /** Decimal(18,4); `null` se mascarado (POL-09 · RN-PRICE-12). */
    unitPrice: z.string().nullable(),
    unitPriceMasked: z.boolean(),
    brandModel: z.string().nullable(),
    status: z.enum(QUOTATION_STATUSES),
    exclusionReason: z.enum(EXCLUSION_REASONS).nullable(),
    exclusionJustification: z.string().nullable(),
    outlierFlag: z.enum(OUTLIER_FLAGS),
    /** RN-PRICE-26: data da fonte anterior à data-base − validade do tipo. */
    isExpired: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    version: z.int(),
  })
  .meta({ id: 'Quotation' });
export type QuotationDto = z.infer<typeof quotationSchema>;

/** Tipo de fonte como a SCR-009 o exibe (campos exigidos e validade — RN-PRICE-21/26). */
export const priceSourceTypeSummarySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  requiredFields: z.array(z.enum(PRICE_SOURCE_REQUIRED_FIELDS)),
  maxAgeDays: z.int().nullable(),
});
export type PriceSourceTypeSummary = z.infer<typeof priceSourceTypeSummarySchema>;

/** `PriceSource` (PRS-09/10/11): a evidência, o tipo, o fornecedor e as cotações dela. */
export const priceSourceSchema = z
  .object({
    id: z.uuid(),
    priceResearchId: z.uuid(),
    sourceTypeId: z.uuid(),
    sourceType: priceSourceTypeSummarySchema,
    description: z.string(),
    supplierId: z.uuid().nullable(),
    supplier: z
      .object({ id: z.uuid(), legalName: z.string(), documentNumber: z.string() })
      .nullable(),
    quoteDate: isoDateSchema.nullable(),
    accessedAt: isoDateTimeSchema.nullable(),
    url: z.string().nullable(),
    referenceOrganization: z.string().nullable(),
    referenceDocument: z.string().nullable(),
    supplierChoiceJustification: z.string().nullable(),
    notes: z.string().nullable(),
    sortOrder: z.int(),
    quotations: z.array(quotationSchema),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    version: z.int(),
  })
  .meta({ id: 'PriceSource' });
export type PriceSourceDto = z.infer<typeof priceSourceSchema>;

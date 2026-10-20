import { CATALOG_TYPES, ITEM_KINDS, PCA_STATUSES } from '@contrataflow/types';
import type { CatalogType } from '@contrataflow/types';
import { z } from 'zod';

/*
 * `CatalogItem.metadata` por `catalogType` (entities.md §5.9 · RN-TEN-62): um schema ESTRITO por
 * tipo — chave fora do schema é rejeitada (`NOT_ALLOWED`). É o `CatalogMetadataSchemas` do módulo
 * `catalog`, compartilhado pela API (validação e seeder) e pelo web (campos dinâmicos do SCR-109).
 */

const legalBasis = z
  .string({ error: 'Informe a base legal.' })
  .trim()
  .min(1, { error: 'Informe a base legal.' })
  .max(250, { error: 'Informe no máximo 250 caracteres.' });

/** Campos da pesquisa de preços que a fonte exige (entities.md §5.9 · `PRICE_SOURCE_TYPE`). */
export const PRICE_SOURCE_REQUIRED_FIELDS = [
  'supplierId',
  'quoteDate',
  'accessedAt',
  'url',
  'referenceOrganization',
  'referenceDocument',
  'attachment',
  'supplierChoiceJustification',
] as const;

export type PriceSourceRequiredField = (typeof PRICE_SOURCE_REQUIRED_FIELDS)[number];

export const PRICE_SOURCE_AGE_REFERENCES = ['quoteDate', 'accessedAt'] as const;

const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, { error: 'Informe a cor no formato #RRGGBB.' });

const metadataSchemas = {
  MODALITY: z.strictObject({
    legalBasis,
    isDirectContracting: z.boolean({ error: 'Informe verdadeiro ou falso.' }),
    // MVP 3 (PNCP): códigos opcionais já aceitos pelo contrato.
    pncpCodes: z.array(z.int().min(1).max(999)).max(20).optional(),
  }),
  CONTRACTING_TYPE: z.strictObject({
    itemKinds: z
      .array(z.enum(ITEM_KINDS, { error: 'Selecione um valor válido.' }))
      .min(1, { error: 'Informe ao menos um tipo de item.' })
      .max(ITEM_KINDS.length),
    isContinuous: z.boolean().optional(),
  }),
  PRICE_SOURCE_TYPE: z.strictObject({
    legalBasis,
    requiredFields: z
      .array(z.enum(PRICE_SOURCE_REQUIRED_FIELDS, { error: 'Selecione um valor válido.' }))
      .max(PRICE_SOURCE_REQUIRED_FIELDS.length),
    maxAgeDays: z.int().min(1).max(3650).optional(),
    ageReference: z
      .enum(PRICE_SOURCE_AGE_REFERENCES, { error: 'Selecione um valor válido.' })
      .optional(),
  }),
  UNIT_OF_MEASURE: z.strictObject({
    abbreviation: z
      .string({ error: 'Informe a abreviatura.' })
      .trim()
      .min(1, { error: 'Informe a abreviatura.' })
      .max(10, { error: 'Informe no máximo 10 caracteres.' }),
    allowsDecimal: z.boolean({ error: 'Informe verdadeiro ou falso.' }),
  }),
  RISK_CATEGORY: z.strictObject({ color: hexColor.optional() }),
  JUDGMENT_CRITERION: z.strictObject({ legalBasis }),
  PROCESS_ORIGIN: z.strictObject({
    requiresPcaStatus: z.enum(PCA_STATUSES, { error: 'Selecione um valor válido.' }).optional(),
  }),
  ATTACHMENT_CATEGORY: z.strictObject({}),
} as const satisfies Record<CatalogType, z.ZodType>;

export type CatalogMetadataSchemas = typeof metadataSchemas;

/** Schema de `metadata` do tipo de catálogo (entities.md §5.9). */
export function catalogMetadataSchema<T extends CatalogType>(type: T): CatalogMetadataSchemas[T] {
  return metadataSchemas[type];
}

/** Todos os tipos têm schema (conferido em teste). */
export const CATALOG_METADATA_TYPES: readonly CatalogType[] = CATALOG_TYPES;

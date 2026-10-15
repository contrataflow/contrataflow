import { CATALOG_TYPES } from '@contrataflow/types';
import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';

/*
 * Catálogos parametrizáveis (US-104 · entities.md §4 `CatalogItem` · api/14-tenant-administration.md
 * CAT-01..06 · RN-TEN-59..66). A `metadata` é validada por tipo (`catalogMetadataSchema`) no caso de
 * uso, que conhece o `catalogType` da rota.
 */

export const catalogTypeSchema = z.enum(CATALOG_TYPES, { error: 'Selecione um catálogo válido.' });

/** RN-TEN-59: `SCREAMING_SNAKE_CASE`, até 60 caracteres (`varchar(60)`). */
export const CATALOG_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
export const CATALOG_CODE_MESSAGE =
  'Use letras maiúsculas, números e sublinhado, sem repetir um código existente.';

export const catalogCodeSchema = z
  .string({ error: 'Informe o código.' })
  .min(1, { error: 'Informe o código.' })
  .max(60, { error: 'Informe no máximo 60 caracteres.' })
  .regex(CATALOG_CODE_PATTERN, { error: CATALOG_CODE_MESSAGE });

const labelSchema = trimmedString({ max: 150 });
const descriptionSchema = z
  .string()
  .trim()
  .max(1000, { error: 'Informe no máximo 1.000 caracteres.' });
const metadataInputSchema = z.record(z.string(), z.unknown(), {
  error: 'Revise os campos específicos deste catálogo.',
});

export const catalogTypeParamsSchema = z.strictObject({ catalogType: catalogTypeSchema });
export const catalogItemIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/**
 * CAT-01 (query): lista os itens do catálogo por `sortOrder`. Dezenas de itens por catálogo: a
 * página padrão já cobre o catálogo inteiro (até 100), mas o padrão de paginação da API vale.
 */
export const catalogItemListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  isActive: booleanQuery,
  q: z
    .string()
    .trim()
    .min(1, { error: 'Informe ao menos 1 caractere para buscar.' })
    .max(120, { error: 'Informe no máximo 120 caracteres.' })
    .optional(),
});
export type CatalogItemListQuery = z.output<typeof catalogItemListQuerySchema>;

/** CAT-02: `isSystem` e `isActive` não são aceitos do cliente (descartados no parse). */
export const createCatalogItemSchema = z.object({
  code: catalogCodeSchema,
  label: labelSchema,
  description: descriptionSchema.nullish(),
  parentId: uuidV7Schema.nullish(),
  metadata: metadataInputSchema.optional(),
});
export type CreateCatalogItem = z.output<typeof createCatalogItemSchema>;

/**
 * CAT-03: `code` é aceito no parse só para que a API possa responder `CATALOG_ITEM_SYSTEM` quando
 * o cliente tenta alterá-lo (RN-TEN-59/60 · FA-01); o caso de uso o rejeita se diferir do atual.
 */
export const updateCatalogItemSchema = z.object({
  code: z.string().max(60).optional(),
  label: labelSchema.optional(),
  description: descriptionSchema.nullish(),
  parentId: uuidV7Schema.nullish(),
  sortOrder: z.int({ error: 'Informe um número inteiro.' }).min(0).max(100000).optional(),
  metadata: metadataInputSchema.optional(),
});
export type UpdateCatalogItem = z.output<typeof updateCatalogItemSchema>;

/** CAT-06: lista completa dos IDs do catálogo, sem repetição, na ordem final (RN-TEN-65). */
export const reorderCatalogItemsSchema = z.strictObject({
  orderedIds: z
    .array(uuidV7Schema)
    .min(1, { error: 'Informe os itens na nova ordem.' })
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Há itens repetidos na lista.',
      params: { code: 'DUPLICATE_IN_LIST' },
    }),
});
export type ReorderCatalogItems = z.output<typeof reorderCatalogItemsSchema>;

/** `CatalogItem` da resposta (CAT-01..06). */
export const catalogItemSchema = z.object({
  id: z.uuid(),
  catalogType: catalogTypeSchema,
  code: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.int(),
  parentId: z.uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.int(),
});
export type CatalogItemDto = z.infer<typeof catalogItemSchema>;

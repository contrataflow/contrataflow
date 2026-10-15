import { z } from 'zod';

import { adminEmailSchema, ORGANIZATION_TYPES } from './tenant.js';
import { cnpjSchema } from '../common/cnpj.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';
import { pageQuerySchema } from '../http/pagination.js';

/*
 * Órgãos/entidades do tenant (US-101 · entities.md §4 `Organization` · api/14-tenant-administration.md
 * ORG-01..04 · RN-TEN-38..43). Schemas compartilhados pela API (corpo/query/resposta) e pelo
 * SCR-032 (`createOrganizationSchema`). Campos que o cliente não pode definir (`metadata` — RN-TEN-43
 * — e, na criação, `isActive`/`logoAttachmentId`) são descartados em silêncio pelo parse.
 */

const SELECT_MESSAGE = 'Selecione um valor válido.';

/** RN-TEN-39: 2–30 caracteres, só letras, números e hífen; exibida e gravada em maiúsculas. */
export const organizationShortNameSchema = z
  .string({ error: 'Informe a sigla.' })
  .trim()
  .min(2, { error: 'Use 2 a 30 letras, números ou hífen.' })
  .max(30, { error: 'Use 2 a 30 letras, números ou hífen.' })
  .regex(/^[A-Za-z0-9-]+$/, {
    error: 'Use 2 a 30 letras, números ou hífen, sem repetir uma sigla existente.',
  })
  .transform((value) => value.toUpperCase());

/** RN-TEN-42: endereço `https://` com host (V-05). */
export const WEBSITE_HTTPS_MESSAGE = 'Informe um endereço começando com https://.';

export const organizationWebsiteSchema = z
  .string()
  .trim()
  .max(255, { error: 'Informe no máximo 255 caracteres.' })
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname.length > 0;
      } catch {
        return false;
      }
    },
    { message: WEBSITE_HTTPS_MESSAGE, params: { code: 'INVALID_FORMAT' } },
  );

const phoneSchema = z.string().trim().max(20, { error: 'Informe no máximo 20 caracteres.' });
const addressPart = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Informe no máximo ${max} caracteres.` });
const stateSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, { error: 'Informe a UF com 2 letras.' })
  .transform((value) => value.toUpperCase());
/** CEP com ou sem máscara → 8 dígitos. */
const zipCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[.\-\s]/g, ''))
  .refine((value) => /^\d{8}$/.test(value), {
    message: 'Informe o CEP com 8 dígitos.',
    params: { code: 'INVALID_FORMAT' },
  });
const ibgeCityCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{7}$/, { error: 'Informe o código IBGE com 7 dígitos.' });

/** Campos opcionais de contato e endereço (ORG-02): ausentes, ou limpos com `null` no ORG-04. */
const optionalFields = {
  email: adminEmailSchema.nullish(),
  phone: phoneSchema.nullish(),
  website: organizationWebsiteSchema.nullish(),
  addressStreet: addressPart(200).nullish(),
  addressNumber: addressPart(20).nullish(),
  addressComplement: addressPart(100).nullish(),
  addressDistrict: addressPart(100).nullish(),
  addressCity: addressPart(100).nullish(),
  addressState: stateSchema.nullish(),
  addressZipCode: zipCodeSchema.nullish(),
  ibgeCityCode: ibgeCityCodeSchema.nullish(),
};

/** Campos que a criação e a edição compartilham (RN-TEN-38). */
const requiredFields = {
  name: trimmedString({ min: 3, max: 250 }),
  shortName: organizationShortNameSchema,
  cnpj: cnpjSchema,
  type: z.enum(ORGANIZATION_TYPES, { error: SELECT_MESSAGE }),
};

/** ORG-02. */
export const createOrganizationSchema = z.object({ ...requiredFields, ...optionalFields });
export type CreateOrganization = z.output<typeof createOrganizationSchema>;
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

/** ORG-04: todos os campos de ORG-02 opcionais + `isActive` e `logoAttachmentId`. */
export const updateOrganizationSchema = z.object({
  name: requiredFields.name.optional(),
  shortName: requiredFields.shortName.optional(),
  cnpj: requiredFields.cnpj.optional(),
  type: requiredFields.type.optional(),
  ...optionalFields,
  isActive: z.boolean({ error: 'Informe verdadeiro ou falso.' }).optional(),
  logoAttachmentId: uuidV7Schema.nullish(),
});
export type UpdateOrganization = z.output<typeof updateOrganizationSchema>;
export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;

export const organizationIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** ORG-01 (query): `q` com no mínimo 2 caracteres. */
export const organizationListQuerySchema = pageQuerySchema.extend({
  isActive: booleanQuery,
  q: z
    .string()
    .trim()
    .min(2, { error: 'Informe ao menos 2 caracteres para buscar.' })
    .max(120, { error: 'Informe no máximo 120 caracteres.' })
    .optional(),
});
export type OrganizationListQuery = z.infer<typeof organizationListQuerySchema>;

/** `Organization` da resposta (ORG-01..04). `metadata` é só leitura (RN-TEN-43). */
export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  shortName: z.string(),
  cnpj: z.string(),
  type: z.enum(ORGANIZATION_TYPES),
  isActive: z.boolean(),
  /** `true` no órgão principal do tenant (`tenants.primaryOrganizationId`). */
  isPrimary: z.boolean(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  addressStreet: z.string().nullable(),
  addressNumber: z.string().nullable(),
  addressComplement: z.string().nullable(),
  addressDistrict: z.string().nullable(),
  addressCity: z.string().nullable(),
  addressState: z.string().nullable(),
  addressZipCode: z.string().nullable(),
  ibgeCityCode: z.string().nullable(),
  logoAttachmentId: z.uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.int(),
});
export type OrganizationDto = z.infer<typeof organizationSchema>;

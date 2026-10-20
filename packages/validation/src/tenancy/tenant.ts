import {
  BRAZILIAN_STATE_CODES,
  BRAZILIAN_STATES,
  BRAZILIAN_TIMEZONES,
  DEFAULT_TENANT_LOCALE,
  DEFAULT_TENANT_PLAN,
  DEFAULT_TENANT_TIMEZONE,
  PLATFORM_CHANNELS,
  PROVISIONING_STEP_STATUSES,
  RESERVED_TENANT_SLUGS,
  TENANT_SLUG_PATTERN,
  TENANT_STATUSES,
  TENANT_TYPES,
  TENANT_TYPES_REQUIRING_IBGE,
} from '@contrataflow/types';
import { z } from 'zod';

import { cnpjSchema } from '../common/cnpj.js';
import { trimmedString } from '../common/text.js';
import { pageQuerySchema } from '../http/pagination.js';

/*
 * Provisionamento e ciclo de vida do tenant pela plataforma (US-099 · api/15-platform-health.md
 * PLT-01..05): corpo do `tenant.json` da CLI e da API (`provisionTenantSchema`), motivo de
 * suspensão/encerramento e as respostas. Mensagens de V-01..V-09 da story.
 */

export const ORGANIZATION_TYPES = [
  'DIRECT_ADMINISTRATION',
  'FUND',
  'AUTARCHY',
  'FOUNDATION',
  'PUBLIC_COMPANY',
  'MIXED_CAPITAL_COMPANY',
  'PUBLIC_CONSORTIUM',
  'LEGISLATIVE',
  'OTHER',
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

const SLUG_MESSAGE = 'Use letras minúsculas, números e hífen; este identificador é reservado.';
const RESERVED = new Set(RESERVED_TENANT_SLUGS);

/** RN-TEN-01: formato e lista de reservados → `INVALID_FORMAT` (V-02). */
export const tenantSlugSchema = z
  .string({ error: 'Informe o identificador.' })
  .trim()
  .min(3, { error: 'Informe ao menos 3 caracteres.' })
  .max(63, { error: 'Informe no máximo 63 caracteres.' })
  .superRefine((slug, ctx) => {
    if (!TENANT_SLUG_PATTERN.test(slug) || RESERVED.has(slug)) {
      ctx.addIssue({ code: 'custom', message: SLUG_MESSAGE, params: { code: 'INVALID_FORMAT' } });
    }
  });

/** Sugestão de slug a partir do nome (`Prefeitura de São José` → `prefeitura-de-sao-jose`). */
export function suggestTenantSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

const SELECT_MESSAGE = 'Selecione um valor válido.';

/** E-mail normalizado em minúsculas, até 254 caracteres (RN-TEN-04 · V-07). */
export const adminEmailSchema = z
  .string({ error: 'Informe o e-mail.' })
  .trim()
  .min(1, { error: 'Informe o e-mail.' })
  .max(254, { error: 'Informe no máximo 254 caracteres.' })
  .toLowerCase()
  .pipe(z.email({ error: 'Informe um e-mail válido.' }));

export const primaryOrganizationSchema = z.strictObject({
  name: trimmedString({ min: 3, max: 250 }),
  shortName: z
    .string({ error: 'Informe a sigla.' })
    .trim()
    .min(2, { error: 'Informe ao menos 2 caracteres.' })
    .max(30, { error: 'Informe no máximo 30 caracteres.' })
    .regex(/^[A-Za-z0-9-]+$/, { error: 'Use apenas letras, números e hífen na sigla.' })
    .transform((value) => value.toUpperCase()),
  cnpj: cnpjSchema,
  type: z.enum(ORGANIZATION_TYPES, { error: SELECT_MESSAGE }),
  email: adminEmailSchema.optional(),
  phone: z.string().trim().max(20, { error: 'Informe no máximo 20 caracteres.' }).optional(),
});
export type PrimaryOrganizationInput = z.infer<typeof primaryOrganizationSchema>;

export const firstAdminSchema = z.strictObject({
  email: adminEmailSchema,
  name: trimmedString({ min: 3, max: 200 }),
});
export type FirstAdminInput = z.infer<typeof firstAdminSchema>;

/** `tenant.json` da CLI e corpo de PLT-01 (RN-TEN-01..04). */
export const provisionTenantSchema = z
  .strictObject({
    slug: tenantSlugSchema,
    name: trimmedString({ min: 3, max: 200 }),
    legalName: z
      .string()
      .trim()
      .max(250, { error: 'Informe no máximo 250 caracteres.' })
      .optional(),
    type: z.enum(TENANT_TYPES, { error: SELECT_MESSAGE }),
    stateCode: z.enum(BRAZILIAN_STATE_CODES as [string, ...string[]], { error: SELECT_MESSAGE }),
    ibgeCityCode: z.string().trim().optional(),
    timezone: z
      .enum(BRAZILIAN_TIMEZONES, { error: SELECT_MESSAGE })
      .default(DEFAULT_TENANT_TIMEZONE),
    locale: z
      .literal(DEFAULT_TENANT_LOCALE, { error: SELECT_MESSAGE })
      .default(DEFAULT_TENANT_LOCALE),
    plan: z.literal(DEFAULT_TENANT_PLAN, { error: SELECT_MESSAGE }).default(DEFAULT_TENANT_PLAN),
    primaryOrganization: primaryOrganizationSchema,
    firstAdmin: firstAdminSchema,
    activate: z.boolean().default(true),
  })
  .superRefine((tenant, ctx) => {
    const prefix = BRAZILIAN_STATES[tenant.stateCode];
    const message = `Informe o código IBGE de 7 dígitos do município da UF ${tenant.stateCode}.`;
    const code = tenant.ibgeCityCode;
    if (code === undefined || code === '') {
      if (TENANT_TYPES_REQUIRING_IBGE.includes(tenant.type)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ibgeCityCode'],
          message,
          params: { code: 'CONDITIONAL_REQUIRED' },
        });
      }
      return;
    }
    if (!/^\d{7}$/.test(code) || (prefix !== undefined && !code.startsWith(prefix))) {
      ctx.addIssue({
        code: 'custom',
        path: ['ibgeCityCode'],
        message,
        params: { code: 'INVALID_FORMAT' },
      });
    }
  });
export type ProvisionTenantInput = z.input<typeof provisionTenantSchema>;
export type ProvisionTenant = z.output<typeof provisionTenantSchema>;

/** Motivo de suspensão/encerramento (RN-TEN-11/13 · V-09). */
export const tenantReasonSchema = z.strictObject({
  reason: z
    .string({ error: 'Informe o motivo (mín. 10 caracteres).' })
    .trim()
    .min(10, { error: 'Informe o motivo (mín. 10 caracteres).' })
    .max(1000, { error: 'Informe no máximo 1.000 caracteres.' }),
});
export type TenantReason = z.infer<typeof tenantReasonSchema>;

/** PLT-04: corpo vazio. */
export const tenantActivateSchema = z.strictObject({});

export const tenantIdParamsSchema = z.strictObject({
  id: z.uuid({ error: 'Identificador inválido.' }),
});

/** PLT-02: filtros e paginação. */
export const tenantListQuerySchema = pageQuerySchema.extend({
  status: z.enum(TENANT_STATUSES, { error: SELECT_MESSAGE }).optional(),
  stateCode: z
    .enum(BRAZILIAN_STATE_CODES as [string, ...string[]], { error: SELECT_MESSAGE })
    .optional(),
  q: z.string().trim().max(120).optional(),
});
export type TenantListQuery = z.infer<typeof tenantListQuerySchema>;

/** Item do checklist calculado (RN-TEN-06). */
export const provisioningStepSchema = z.object({
  key: z.string(),
  status: z.enum(PROVISIONING_STEP_STATUSES),
  version: z.string().nullable(),
  details: z.record(z.string(), z.number()).optional(),
});
export type ProvisioningStepDto = z.infer<typeof provisioningStepSchema>;

export const provisioningChecklistSchema = z.object({
  complete: z.boolean(),
  steps: z.array(provisioningStepSchema),
});
export type ProvisioningChecklistDto = z.infer<typeof provisioningChecklistSchema>;

/** Resumo de PLT-02. */
export const platformTenantSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  type: z.enum(TENANT_TYPES),
  status: z.enum(TENANT_STATUSES),
  stateCode: z.string(),
  plan: z.string(),
  activatedAt: z.iso.datetime().nullable(),
  suspendedAt: z.iso.datetime().nullable(),
});
export type PlatformTenantSummaryDto = z.infer<typeof platformTenantSummarySchema>;

/** `Tenant` das respostas de plataforma (sem o motivo de suspensão — só `hasSuspensionReason`). */
export const platformTenantSchema = platformTenantSummarySchema.extend({
  legalName: z.string().nullable(),
  ibgeCityCode: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  primaryOrganizationId: z.uuid().nullable(),
  deactivatedAt: z.iso.datetime().nullable(),
  offboardingStartedAt: z.iso.datetime().nullable(),
  hasSuspensionReason: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.int(),
});
export type PlatformTenantDto = z.infer<typeof platformTenantSchema>;

export const platformTenantDetailSchema = platformTenantSchema.extend({
  provisioning: provisioningChecklistSchema,
});
export type PlatformTenantDetailDto = z.infer<typeof platformTenantDetailSchema>;

/** Situação do primeiro administrador na resposta de PLT-01 (e-mail mascarado). */
export const firstAdminStatusSchema = z.object({
  email: z.string(),
  membershipStatus: z.string().nullable(),
  invitationDispatched: z.boolean(),
});
export type FirstAdminStatusDto = z.infer<typeof firstAdminStatusSchema>;

export const provisionTenantResultSchema = platformTenantDetailSchema.extend({
  firstAdmin: firstAdminStatusSchema,
});
export type ProvisionTenantResultDto = z.infer<typeof provisionTenantResultSchema>;

export const platformChannelSchema = z.enum(PLATFORM_CHANNELS);

/** `r***@pmsj.exemplo.gov.br`: o e-mail do administrador nunca sai inteiro (Logs da US-099). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

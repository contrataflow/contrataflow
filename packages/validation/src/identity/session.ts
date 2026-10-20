import { z } from 'zod';

/*
 * Contratos de identidade e sessão (US-087): ME-01 (`GET /me`), ME-04 (`GET /me/memberships`) e o
 * contrato interno BFF → API de início de sessão (`POST /internal/session-events` — fora de
 * `/api/v1`, rede privada; authentication.md §3). Compartilhados pela API e pelo BFF.
 */

export const TENANT_STATUSES = [
  'PROVISIONING',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDING',
  'DEACTIVATED',
] as const;
export const MEMBERSHIP_TYPES = ['INTERNAL', 'EXTERNAL', 'SERVICE'] as const;
export const MEMBERSHIP_STATUSES = [
  'INVITED',
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
  'EXPIRED',
] as const;

/** Como a instituição ativa foi escolhida (RN-IAM-09/17). */
export const TENANT_SELECTIONS = ['AUTO', 'DEFAULT', 'MANUAL'] as const;
export type TenantSelection = (typeof TENANT_SELECTIONS)[number];

/** Item de ME-04: vínculo e instituição, com `usable` consolidado (RN-IAM-08). */
export const membershipSummarySchema = z
  .object({
    membershipId: z.uuid(),
    tenant: z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(TENANT_STATUSES),
    }),
    type: z.enum(MEMBERSHIP_TYPES),
    status: z.enum(MEMBERSHIP_STATUSES),
    /** Fim do vínculo (externos); `null` = sem prazo. */
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    /** `ACTIVE`, não expirado e instituição disponível para este vínculo. */
    usable: z.boolean(),
    /** Instituição em encerramento: só leitura e exportação (DEC-132). */
    readOnly: z.boolean(),
  })
  .meta({ id: 'MembershipSummary' });

export type MembershipSummaryDto = z.infer<typeof membershipSummarySchema>;

/** ME-01 — perfil do usuário autenticado (api/01-session-me.md), com `version` para o `ETag`. */
export const myProfileSchema = z
  .object({
    id: z.uuid(),
    /** Nome civil (registros formais); o nome exibido é `socialName ?? name` (RN-IAM-110). */
    name: z.string(),
    socialName: z.string().nullable(),
    /** Somente leitura (RN-IAM-109). */
    email: z.string(),
    phone: z.string().nullable(),
    preferences: z.object({ density: z.string(), theme: z.string() }),
    /** Cargo e lotações do vínculo ativo na instituição do contexto (somente leitura). */
    membership: z.object({
      jobTitle: z.string().nullable(),
      departments: z.array(z.string()),
    }),
    /**
     * A sessão desta requisição comprova o segundo fator (derivado do `amr` — US-090 ·
     * RN-IAM-44); nunca o dispositivo nem o método usado.
     */
    mfaVerified: z.boolean(),
    version: z.int().min(1),
  })
  .meta({ id: 'MyProfile' });

export type MyProfileDto = z.infer<typeof myProfileSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, { error: 'Hash SHA-256 inválido.' });

/**
 * Evento de sessão enviado pelo BFF com o access token do usuário (RN-IAM-17). `SESSION_STARTED`
 * sem `tenantId` resolve a identidade (vínculo do `sub`, `lastLoginAt`) e lista os vínculos; com
 * `tenantId`, também ativa a instituição e grava `auth.session_start`. `TENANT_SWITCHED` troca a
 * instituição de uma sessão que já tinha uma ativa (`auth.tenant_switch` — US-093), identificada
 * pelo vínculo (`membershipId`, conferido contra os vínculos do próprio usuário) ou pelo `tenantId`.
 */
export const sessionEventRequestSchema = z
  .strictObject({
    type: z.enum(['SESSION_STARTED', 'TENANT_SWITCHED']),
    /** SHA-256 do id da sessão do BFF (liga a auditoria à sessão sem expor o cookie). */
    sessionIdHash: sha256Hex,
    tenantId: z.uuid().optional(),
    /** Vínculo escolhido em SCR-101 (US-093); de outra pessoa → 422 `REFERENCE_NOT_FOUND`. */
    membershipId: z.uuid().optional(),
    /** "Usar como padrão" (FA-04 da US-093): grava `User.preferences.defaultTenantId`. */
    setAsDefault: z.boolean().optional(),
    selection: z.enum(TENANT_SELECTIONS).optional(),
    /** Primeiro login da pessoa (vindo da resolução da identidade nesta mesma sessão). */
    firstLogin: z.boolean().optional(),
    fromTenantId: z.uuid().nullable().optional(),
    /** IP do cliente (cadeia confiável do balanceador) e user-agent, para a auditoria. */
    ip: z.string().max(45).nullable(),
    userAgent: z.string().max(512).nullable(),
  })
  .meta({ id: 'SessionEventRequest' });

export type SessionEventRequest = z.infer<typeof sessionEventRequestSchema>;

/** Vínculo devolvido ao BFF: o resumo de ME-04 + o fuso da instituição (formatação no shell). */
export const sessionMembershipSchema = membershipSummarySchema
  .extend({
    tenant: membershipSummarySchema.shape.tenant.extend({ timezone: z.string() }),
  })
  .meta({ id: 'SessionMembership' });

export type SessionMembershipDto = z.infer<typeof sessionMembershipSchema>;

export const sessionEventResponseSchema = z
  .object({
    user: z.object({
      id: z.uuid(),
      /** Nome social, quando houver; senão o nome civil. */
      displayName: z.string(),
    }),
    /** O `sub` foi vinculado ao usuário nesta chamada (primeiro login — RN-IAM-06). */
    firstLogin: z.boolean(),
    memberships: z.array(sessionMembershipSchema),
    /**
     * Instituição ativada por esta chamada (com `tenantId`/`membershipId`); `null` ao só resolver
     * a identidade ou quando a troca ficou suspensa pelo MFA (`mfaRequired`).
     */
    activeMembership: z
      .object({ membershipId: z.uuid(), tenantId: z.uuid(), readOnly: z.boolean() })
      .nullable(),
    /** Instituição padrão (`User.preferences.defaultTenantId` — RN-IAM-09 · FA-04 da US-093). */
    defaultTenantId: z.uuid().nullable().optional(),
    /**
     * A instituição de destino exige segundo fator (`security.mfaPolicy`) que a sessão não tem: a
     * troca não aconteceu e espera o *step-up* (RN-IAM-69 · US-093).
     */
    mfaRequired: z.boolean(),
  })
  .meta({ id: 'SessionEventResult' });

export type SessionEventResult = z.infer<typeof sessionEventResponseSchema>;

/**
 * Corpo de `POST /api/auth/switch-tenant` (BFF · US-093): o vínculo escolhido em SCR-101 e o
 * "Usar como padrão" (FA-04).
 */
export const switchTenantRequestSchema = z.strictObject({
  membershipId: z.uuid(),
  setAsDefault: z.boolean().optional(),
});

export type SwitchTenantRequest = z.infer<typeof switchTenantRequestSchema>;

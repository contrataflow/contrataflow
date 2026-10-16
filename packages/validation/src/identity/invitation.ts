import { z } from 'zod';

import { MEMBERSHIP_STATUSES } from './session.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { trimmedString } from '../common/text.js';
import { pageQuerySchema } from '../http/pagination.js';

/*
 * Convite e vínculos do tenant (US-091 · entities.md `TenantMembership` · api/14-tenant-administration.md
 * USR-01, USR-03..06 e USR-14 · RN-IAM-46..53). Schemas compartilhados pela API (corpo/query/
 * resposta), pelo SCR-029 (formulário "Convidar usuário" e convites pendentes) e pelo SCR-102
 * (aceite em `/convite/[token]`).
 */

/** Tipos de vínculo do MVP 1 (`SERVICE` fica fora — entities.md §2 `MembershipType`). */
export const INVITATION_MEMBERSHIP_TYPES = ['INTERNAL', 'EXTERNAL'] as const;
export type InvitationMembershipType = (typeof INVITATION_MEMBERSHIP_TYPES)[number];

/** RN-IAM-47: validade fixa do convite no MVP 1 (não configurável por tenant). */
export const INVITATION_VALIDITY_DAYS = 7;
/** RN-IAM-53: reenvios por convite e intervalo mínimo entre eles. */
export const INVITATION_RESEND_LIMIT = 5;
export const INVITATION_RESEND_INTERVAL_SECONDS = 60;
/** Padrão de `security.externalMembershipMaxDays` (entities.md §6) — RN-IAM-52. */
export const EXTERNAL_MEMBERSHIP_MAX_DAYS_DEFAULT = 180;
/** Lotações informadas no convite (a primeira é a principal). */
export const INVITATION_MAX_DEPARTMENTS = 20;

export const INVITE_NAME_MIN = 3;
export const INVITE_NAME_MAX = 200;
export const INVITE_JOB_TITLE_MAX = 150;

/** Mensagens da story (V-01/V-03/V-04). */
export const INVITE_EMAIL_MESSAGE = 'Informe um e-mail válido.';
export const EXTERNAL_EXPIRES_REQUIRED_MESSAGE = 'Informe a validade do vínculo externo.';
export const INVITE_SELECT_MESSAGE = 'Selecione uma opção válida.';

/**
 * Token opaco do convite (RN-IAM-47): 32 bytes de CSPRNG em base64url, sem preenchimento (43
 * caracteres). Só existe em claro no link do e-mail; o banco guarda o SHA-256.
 */
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const invitationTokenSchema = z
  .string({ error: 'Informe o token do convite.' })
  .regex(INVITATION_TOKEN_PATTERN, { error: 'Este convite não é válido.' });

const inviteEmailSchema = z
  .string({ error: INVITE_EMAIL_MESSAGE })
  .trim()
  .min(1, { error: INVITE_EMAIL_MESSAGE })
  .max(254, { error: 'Informe no máximo 254 caracteres.' })
  .toLowerCase()
  .pipe(z.email({ error: INVITE_EMAIL_MESSAGE }));

const typeSchema = z
  .string({ error: 'Informe o tipo de vínculo.' })
  .pipe(z.enum(INVITATION_MEMBERSHIP_TYPES, { error: INVITE_SELECT_MESSAGE }))
  .meta({ enum: [...INVITATION_MEMBERSHIP_TYPES] });

/** RN-IAM-52: `EXTERNAL` exige `expiresAt`; `INTERNAL` não aceita validade. */
function membershipValidity(
  value: { type: InvitationMembershipType; expiresAt?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const informed = value.expiresAt !== undefined && value.expiresAt !== null;
  if (value.type === 'EXTERNAL' && !informed) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: EXTERNAL_EXPIRES_REQUIRED_MESSAGE,
      params: { code: 'CONDITIONAL_REQUIRED' },
    });
  }
  if (value.type === 'INTERNAL' && informed) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Vínculo interno não tem validade.',
      params: { code: 'NOT_ALLOWED' },
    });
  }
}

/** Lotações sem repetição (a primeira é a principal). */
function distinctDepartments(
  value: { departmentIds?: readonly string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  const ids = value.departmentIds ?? [];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['departmentIds'],
      message: 'Selecione cada unidade uma única vez.',
      params: { code: 'DUPLICATE_IN_LIST' },
    });
  }
}

/** USR-03 (corpo). A validade máxima e o futuro de `expiresAt` são conferidos na API (setting). */
export const inviteUserSchema = z
  .strictObject({
    email: inviteEmailSchema,
    name: trimmedString({ min: INVITE_NAME_MIN, max: INVITE_NAME_MAX }),
    type: typeSchema,
    jobTitle: z
      .string()
      .trim()
      .max(INVITE_JOB_TITLE_MAX, { error: `Informe no máximo ${INVITE_JOB_TITLE_MAX} caracteres.` })
      .nullish(),
    expiresAt: isoDateTimeSchema.nullish(),
    departmentIds: z
      .array(z.uuid({ error: INVITE_SELECT_MESSAGE }))
      .max(INVITATION_MAX_DEPARTMENTS, {
        error: `Selecione no máximo ${INVITATION_MAX_DEPARTMENTS} unidades.`,
      })
      .optional(),
    roleId: z.uuid({ error: INVITE_SELECT_MESSAGE }).nullish(),
  })
  .superRefine((value, ctx) => {
    membershipValidity(value, ctx);
    distinctDepartments(value, ctx);
  })
  .meta({ id: 'InviteUser' });
export type InviteUser = z.infer<typeof inviteUserSchema>;

/** Caminho de USR-04/05: `userId` do convidado no tenant. */
export const invitationUserParamsSchema = z.strictObject({
  userId: z.uuid({ error: 'Informe um identificador válido.' }),
});

/** USR-06/USR-14 (corpo). */
export const invitationTokenBodySchema = z
  .strictObject({ token: invitationTokenSchema })
  .meta({ id: 'InvitationToken' });
export type InvitationTokenBody = z.infer<typeof invitationTokenBodySchema>;

/** `TenantMembership` da resposta (USR-01/03/06 — api/14 "Tipos de referência"). */
export const tenantMembershipSchema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    name: z.string(),
    socialName: z.string().nullable(),
    email: z.string(),
    type: z.enum(['INTERNAL', 'EXTERNAL', 'SERVICE']),
    status: z.enum(MEMBERSHIP_STATUSES),
    jobTitle: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    departmentIds: z.array(z.uuid()),
    /** `null` quando o vínculo ainda não tem lotação. */
    primaryDepartmentId: z.uuid().nullable(),
    invitedAt: z.iso.datetime().nullable(),
    /** Fim da validade do link do convite (só em `INVITED`). */
    inviteExpiresAt: z.iso.datetime().nullable(),
    activatedAt: z.iso.datetime().nullable(),
    version: z.int(),
  })
  .meta({ id: 'TenantMembership' });
export type TenantMembershipDto = z.infer<typeof tenantMembershipSchema>;

/** USR-04 (resposta). */
export const invitationResentSchema = z.object({ inviteExpiresAt: z.iso.datetime() });
export type InvitationResentDto = z.infer<typeof invitationResentSchema>;

/** USR-06 (resposta): o vínculo ativado e a instituição, para a troca de instituição ativa. */
export const acceptedInvitationSchema = tenantMembershipSchema
  .extend({ tenant: z.object({ id: z.uuid(), name: z.string() }) })
  .meta({ id: 'AcceptedInvitation' });
export type AcceptedInvitationDto = z.infer<typeof acceptedInvitationSchema>;

/** USR-14 (resposta): o que o SCR-102 mostra antes da confirmação (passo 6). */
export const invitationPreviewSchema = z
  .object({
    tenant: z.object({ id: z.uuid(), name: z.string() }),
    type: z.enum(INVITATION_MEMBERSHIP_TYPES),
    jobTitle: z.string().nullable(),
    departments: z.array(z.object({ id: z.uuid(), name: z.string() })),
    expiresAt: z.iso.datetime().nullable(),
    inviteExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'InvitationPreview' });
export type InvitationPreviewDto = z.infer<typeof invitationPreviewSchema>;

/** USR-01 (query): `status` aceita lista separada por vírgula (OU). */
export const membershipListQuerySchema = pageQuerySchema.extend({
  q: z
    .string()
    .trim()
    .min(2, { error: 'Informe ao menos 2 caracteres para buscar.' })
    .max(120, { error: 'Informe no máximo 120 caracteres.' })
    .optional(),
  status: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()))
    .pipe(z.array(z.enum(MEMBERSHIP_STATUSES, { error: INVITE_SELECT_MESSAGE })).min(1))
    .optional(),
  type: z.enum(INVITATION_MEMBERSHIP_TYPES, { error: INVITE_SELECT_MESSAGE }).optional(),
});
export type MembershipListQuery = z.infer<typeof membershipListQuerySchema>;

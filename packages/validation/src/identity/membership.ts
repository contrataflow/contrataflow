import { z } from 'zod';

import { INVITATION_MAX_DEPARTMENTS, tenantMembershipSchema } from './invitation.js';
import { isoDateTimeSchema } from '../common/dates.js';

/*
 * Gestão de vínculos do tenant (US-092 · api/14-tenant-administration.md USR-07..12 ·
 * RN-IAM-54..64). Schemas compartilhados pela API e pelo detalhe do SCR-029
 * (`/admin/usuarios/[userId]`). Nome, e-mail e demais dados de `User` são globais e somente
 * leitura aqui (RN-IAM-54 · DEC-012).
 */

export const MEMBERSHIP_JOB_TITLE_MAX = 150;
export const MEMBERSHIP_REGISTRATION_NUMBER_MAX = 40;
export const MEMBERSHIP_REASON_MAX = 500;

/** Mensagens da story (V-02/V-04/V-05 e Casos de erro). */
export const MEMBERSHIP_DEPARTMENTS_REQUIRED_MESSAGE = 'Selecione ao menos uma lotação.';
export const MEMBERSHIP_DEPARTMENT_INVALID_MESSAGE = 'Selecione uma lotação válida.';
export const MEMBERSHIP_PRIMARY_DEPARTMENT_MESSAGE =
  'A lotação principal deve estar entre as selecionadas.';
export const MEMBERSHIP_SELF_PROTECTION_MESSAGE = 'Você não pode remover o próprio acesso.';
export const MEMBERSHIP_LAST_ADMIN_MESSAGE = 'É preciso manter ao menos um administrador ativo.';
export const MEMBERSHIP_INVALID_STATE_MESSAGE =
  'Esta ação não é válida para o status atual do vínculo.';

/** "Informe uma validade entre hoje e {max} dias." (V-02). */
export function membershipValidityMessage(maxDays: number): string {
  return `Informe uma validade entre hoje e ${String(maxDays)} dias.`;
}

/** Ações do detalhe conforme status, POL-16 e `USER_MANAGE` (`meta.allowedActions` — api.md §1.5). */
export const MEMBERSHIP_ACTIONS = [
  'UPDATE',
  'UPDATE_DEPARTMENTS',
  'SUSPEND',
  'REACTIVATE',
  'REVOKE',
  // US-090 · USR-13: redefinir a autenticação em duas etapas (nunca a do próprio vínculo).
  'MFA_RESET',
] as const;
export type MembershipAction = (typeof MEMBERSHIP_ACTIONS)[number];

/** V-01: "{O campo} deve ter no máximo N caracteres." (`label` com o artigo). */
function limitedText(max: number, label: string) {
  return z
    .string()
    .trim()
    .max(max, { error: `${label} deve ter no máximo ${String(max)} caracteres.` });
}

/**
 * USR-08 (corpo · RN-IAM-55): `null` ou texto vazio limpa o campo. `expiresAt` só vale para
 * `EXTERNAL` — o intervalo (hoje < validade ≤ hoje + `security.externalMembershipMaxDays`) é
 * conferido na API, que conhece o tipo do vínculo e a configuração.
 */
export const updateMembershipSchema = z
  .strictObject({
    jobTitle: limitedText(MEMBERSHIP_JOB_TITLE_MAX, 'O cargo').nullish(),
    registrationNumber: limitedText(MEMBERSHIP_REGISTRATION_NUMBER_MAX, 'A matrícula').nullish(),
    expiresAt: isoDateTimeSchema.optional(),
  })
  .meta({ id: 'UpdateMembership' });
export type UpdateMembership = z.infer<typeof updateMembershipSchema>;
export type UpdateMembershipInput = z.input<typeof updateMembershipSchema>;

/** USR-09 (corpo · RN-IAM-56): ≥ 1 unidade, sem repetição, a principal entre elas. */
export const updateMembershipDepartmentsSchema = z
  .strictObject({
    departmentIds: z
      .array(z.uuid({ error: MEMBERSHIP_DEPARTMENT_INVALID_MESSAGE }), {
        error: MEMBERSHIP_DEPARTMENTS_REQUIRED_MESSAGE,
      })
      .max(INVITATION_MAX_DEPARTMENTS, {
        error: `Selecione no máximo ${String(INVITATION_MAX_DEPARTMENTS)} unidades.`,
      }),
    primaryDepartmentId: z.uuid({ error: MEMBERSHIP_DEPARTMENT_INVALID_MESSAGE }),
  })
  .superRefine((value, ctx) => {
    if (value.departmentIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['departmentIds'],
        message: MEMBERSHIP_DEPARTMENTS_REQUIRED_MESSAGE,
        params: { code: 'REQUIRED' },
      });
      return;
    }
    if (new Set(value.departmentIds).size !== value.departmentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['departmentIds'],
        message: 'Selecione cada unidade uma única vez.',
        params: { code: 'DUPLICATE_IN_LIST' },
      });
    }
    if (!value.departmentIds.includes(value.primaryDepartmentId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryDepartmentId'],
        message: MEMBERSHIP_PRIMARY_DEPARTMENT_MESSAGE,
        params: { code: 'INVALID_ENUM' },
      });
    }
  })
  .meta({ id: 'UpdateMembershipDepartments' });
export type UpdateMembershipDepartments = z.infer<typeof updateMembershipDepartmentsSchema>;

/** USR-10/USR-12 (corpo · RN-IAM-57/59): motivo opcional (nunca vai para logs). */
export const membershipReasonSchema = z
  .strictObject({
    reason: limitedText(MEMBERSHIP_REASON_MAX, 'O motivo').nullish(),
  })
  .meta({ id: 'MembershipReason' });
export type MembershipReason = z.infer<typeof membershipReasonSchema>;

/** USR-11 (corpo): vazio. */
export const reactivateMembershipSchema = z.strictObject({}).meta({ id: 'ReactivateMembership' });

/** US-090 · USR-13 (V-03): motivo obrigatório, 10–500 caracteres. */
export const MFA_RESET_REASON_MIN = 10;
export const MFA_RESET_REASON_MESSAGE = 'Informe o motivo da redefinição (mín. 10 caracteres).';
/** V-02 · RN-IAM-43: a redefinição sobre o próprio vínculo usa a recuperação no login. */
export const MFA_RESET_SELF_MESSAGE =
  'Para redefinir sua própria autenticação em duas etapas, use a recuperação no login.';

/** USR-13 (corpo · RN-IAM-43): o motivo vai para a auditoria `membership.mfa_reset`. */
export const mfaResetSchema = z
  .strictObject({
    reason: z
      .string({ error: MFA_RESET_REASON_MESSAGE })
      .trim()
      .min(MFA_RESET_REASON_MIN, { error: MFA_RESET_REASON_MESSAGE })
      .max(MEMBERSHIP_REASON_MAX, {
        error: `O motivo deve ter no máximo ${String(MEMBERSHIP_REASON_MAX)} caracteres.`,
      }),
  })
  .meta({ id: 'MfaReset' });
export type MfaReset = z.infer<typeof mfaResetSchema>;

/** Resposta de USR-13: `200 { data: { userId, resetAt } }`. */
export const mfaResetResultSchema = z
  .object({ userId: z.uuid(), resetAt: z.iso.datetime() })
  .meta({ id: 'MfaResetResult' });
export type MfaResetResult = z.infer<typeof mfaResetResultSchema>;

/** Caminho de USR-07..13. */
export const membershipUserParamsSchema = z.strictObject({
  userId: z.uuid({ error: 'Informe um identificador válido.' }),
});

/**
 * Detalhe do vínculo (USR-07..12): o `TenantMembership` com as lotações nomeadas (principal
 * primeiro) e os dados de suspensão/revogação — o motivo só aparece para quem consulta o detalhe.
 */
export const membershipDetailSchema = tenantMembershipSchema
  .extend({
    departments: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        isActive: z.boolean(),
        isPrimary: z.boolean(),
      }),
    ),
    suspendedAt: z.iso.datetime().nullable(),
    suspensionReason: z.string().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    revocationReason: z.string().nullable(),
  })
  .meta({ id: 'TenantMembershipDetail' });
export type TenantMembershipDetailDto = z.infer<typeof membershipDetailSchema>;

/** `meta` das respostas de USR-07..12 (api.md §1.5). */
export const membershipDetailMetaSchema = z.object({
  allowedActions: z.array(z.enum(MEMBERSHIP_ACTIONS)),
  /** O vínculo é o do próprio ator (POL-16: suspender/revogar ficam desabilitados com aviso). */
  isSelf: z.boolean(),
});
export type MembershipDetailMeta = z.infer<typeof membershipDetailMetaSchema>;

/**
 * RN-IAM-64: vínculo `EXTERNAL` com validade vencida aparece como "Expirado" antes mesmo de o job
 * `maintenance` gravar `EXPIRED`.
 */
export function isMembershipExpired(
  membership: { readonly type: string; readonly status: string; readonly expiresAt: string | null },
  now: Date,
): boolean {
  if (membership.status === 'EXPIRED') return true;
  return (
    membership.type === 'EXTERNAL' &&
    membership.expiresAt !== null &&
    (membership.status === 'ACTIVE' || membership.status === 'SUSPENDED') &&
    new Date(membership.expiresAt).getTime() <= now.getTime()
  );
}

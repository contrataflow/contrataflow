import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';

/*
 * Atribuição de perfis com escopo e vigência (US-096 · api/14-tenant-administration.md ROL-09..12 ·
 * RN-IAM-89..99). Schemas compartilhados pela API (corpo/resposta) e pela aba "Perfis e acessos"
 * do SCR-029 (`assignRoleSchema`, `revokeRoleAssignmentSchema`).
 */

/** Escopos de atribuição (entities.md §2 `ScopeType` · permissions.md §1). */
export const SCOPE_TYPES = ['TENANT', 'ORGANIZATION', 'DEPARTMENT', 'OWN_DEPARTMENTS'] as const;
export type ScopeTypeValue = (typeof SCOPE_TYPES)[number];

/** Escopos em que "Incluir subárvore" se aplica (RN-IAM-89 — padrão `true`). */
export const SUBTREE_SCOPE_TYPES: readonly ScopeTypeValue[] = ['DEPARTMENT', 'OWN_DEPARTMENTS'];

export const ROLE_ASSIGNMENT_REASON_MAX = 500;

/** Mensagens da story (V-01..V-09). */
export const ROLE_ASSIGNMENT_REQUIRED_MESSAGE = 'Selecione o perfil e o escopo.';
export const ROLE_ASSIGNMENT_ORGANIZATION_REQUIRED_MESSAGE = 'Informe o órgão para este escopo.';
export const ROLE_ASSIGNMENT_DEPARTMENT_REQUIRED_MESSAGE = 'Informe a unidade para este escopo.';
export const ROLE_ASSIGNMENT_SCOPE_NOT_ALLOWED_MESSAGE = 'Este escopo não aceita órgão ou unidade.';
export const ROLE_ASSIGNMENT_VALIDITY_MESSAGE =
  'A vigência final deve ser posterior ao início e não pode superar a validade do vínculo.';
export const ROLE_ASSIGNMENT_ESCALATION_MESSAGE =
  'Você não pode atribuir um perfil com permissões que não possui.';
export const ROLE_ASSIGNMENT_EXTERNAL_MESSAGE =
  'Este perfil não pode ser atribuído a um vínculo externo.';
export const ROLE_ASSIGNMENT_DUPLICATE_MESSAGE = 'Este perfil já está atribuído neste escopo.';
export const ROLE_ASSIGNMENT_LAST_ADMIN_MESSAGE =
  'É preciso manter ao menos um administrador ativo.';
export const ROLE_ASSIGNMENT_SELF_PROTECTION_MESSAGE =
  'Você não pode remover seu próprio último perfil administrativo.';
export const ROLE_ASSIGNMENT_MEMBERSHIP_INACTIVE_MESSAGE = 'Este vínculo não está ativo.';

/**
 * Permissões que tornam um perfil "administrativo" para a autoproteção (POL-16 · RN-IAM-97): quem
 * as perde deixa de conseguir gerir acessos do tenant.
 */
export const ADMINISTRATIVE_PERMISSIONS = ['ROLE_ASSIGN', 'ROLE_MANAGE', 'USER_MANAGE'] as const;

const idSchema = (message: string) => z.uuid({ error: message });

/**
 * RN-IAM-89: órgão só em `ORGANIZATION`, unidade só em `DEPARTMENT` (obrigatórios nesses escopos);
 * RN-IAM-93: `validUntil` > `validFrom` quando os dois vêm no corpo (contra "agora" e contra a
 * validade do vínculo externo, a API confere).
 */
function assignmentShape(
  value: {
    scopeType: ScopeTypeValue;
    scopeOrganizationId?: string | null | undefined;
    scopeDepartmentId?: string | null | undefined;
    validFrom?: string | undefined;
    validUntil?: string | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const organization = value.scopeOrganizationId ?? null;
  const department = value.scopeDepartmentId ?? null;
  if (value.scopeType === 'ORGANIZATION' && organization === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeOrganizationId'],
      message: ROLE_ASSIGNMENT_ORGANIZATION_REQUIRED_MESSAGE,
      params: { code: 'CONDITIONAL_REQUIRED' },
    });
  }
  if (value.scopeType === 'DEPARTMENT' && department === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeDepartmentId'],
      message: ROLE_ASSIGNMENT_DEPARTMENT_REQUIRED_MESSAGE,
      params: { code: 'CONDITIONAL_REQUIRED' },
    });
  }
  if (value.scopeType !== 'ORGANIZATION' && organization !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeOrganizationId'],
      message: ROLE_ASSIGNMENT_SCOPE_NOT_ALLOWED_MESSAGE,
      params: { code: 'NOT_ALLOWED' },
    });
  }
  if (value.scopeType !== 'DEPARTMENT' && department !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeDepartmentId'],
      message: ROLE_ASSIGNMENT_SCOPE_NOT_ALLOWED_MESSAGE,
      params: { code: 'NOT_ALLOWED' },
    });
  }
  if (
    value.validFrom !== undefined &&
    value.validUntil !== undefined &&
    value.validUntil !== null &&
    Date.parse(value.validUntil) <= Date.parse(value.validFrom)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: ROLE_ASSIGNMENT_VALIDITY_MESSAGE,
      params: { code: 'OUT_OF_RANGE' },
    });
  }
}

/** ROL-11 (corpo). */
export const assignRoleSchema = z
  .strictObject({
    roleId: idSchema(ROLE_ASSIGNMENT_REQUIRED_MESSAGE),
    scopeType: z
      .string({ error: ROLE_ASSIGNMENT_REQUIRED_MESSAGE })
      .pipe(z.enum(SCOPE_TYPES, { error: ROLE_ASSIGNMENT_REQUIRED_MESSAGE }))
      .meta({ enum: [...SCOPE_TYPES] }),
    scopeOrganizationId: idSchema('Selecione um órgão válido.').nullish(),
    scopeDepartmentId: idSchema('Selecione uma unidade válida.').nullish(),
    includeSubtree: z.boolean({ error: 'Informe verdadeiro ou falso.' }).optional(),
    validFrom: isoDateTimeSchema.optional(),
    validUntil: isoDateTimeSchema.nullish(),
  })
  .superRefine(assignmentShape)
  .meta({ id: 'AssignRole' });
export type AssignRole = z.output<typeof assignRoleSchema>;
export type AssignRoleInput = z.input<typeof assignRoleSchema>;

/** ROL-12 (corpo): motivo opcional (≤ 500), nunca logado acima de `debug`. */
export const revokeRoleAssignmentSchema = z
  .strictObject({
    reason: z
      .string()
      .trim()
      .max(ROLE_ASSIGNMENT_REASON_MAX, {
        error: `O motivo deve ter no máximo ${String(ROLE_ASSIGNMENT_REASON_MAX)} caracteres.`,
      })
      .nullish(),
  })
  .meta({ id: 'RevokeRoleAssignment' });
export type RevokeRoleAssignment = z.output<typeof revokeRoleAssignmentSchema>;

/** Caminho de ROL-10/11. */
export const roleAssignmentUserParamsSchema = z.strictObject({
  userId: z.uuid({ error: 'Informe um identificador válido.' }),
});

/** Caminho de ROL-12. */
export const roleAssignmentIdParamsSchema = z.strictObject({
  id: z.uuid({ error: 'Informe um identificador válido.' }),
});

/**
 * `RoleAssignment` da resposta (ROL-09..12): a atribuição com o perfil, o escopo nomeado, quem
 * concedeu e se o perfil é administrativo (POL-16 na tela). `status` = `REVOKED` só depois de
 * ROL-12; vigência futura ou vencida continua `ACTIVE` (a tela deriva "Agendada"/"Encerrada" das
 * datas).
 */
export const roleAssignmentSchema = z
  .object({
    id: z.uuid(),
    membershipId: z.uuid(),
    userId: z.uuid(),
    userName: z.string(),
    roleId: z.uuid(),
    roleKey: z.string(),
    roleName: z.string(),
    /** O perfil concede alguma de `ADMINISTRATIVE_PERMISSIONS` (POL-16). */
    isAdministrative: z.boolean(),
    scopeType: z.enum(SCOPE_TYPES),
    scopeOrganizationId: z.uuid().nullable(),
    scopeDepartmentId: z.uuid().nullable(),
    /** Nome do órgão/unidade do escopo; `null` em `TENANT`/`OWN_DEPARTMENTS`. */
    scopeName: z.string().nullable(),
    includeSubtree: z.boolean(),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().nullable(),
    status: z.enum(['ACTIVE', 'REVOKED']),
    grantedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    grantedAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    version: z.int(),
  })
  .meta({ id: 'RoleAssignment' });
export type RoleAssignmentDto = z.infer<typeof roleAssignmentSchema>;

/** ROL-10 (`meta`): o ator pode atribuir/revogar (`ROLE_ASSIGN`) e se a lista é a dele (POL-16). */
export const roleAssignmentListMetaSchema = z
  .object({ canAssign: z.boolean(), isSelf: z.boolean() })
  .meta({ id: 'RoleAssignmentListMeta' });
export type RoleAssignmentListMeta = z.infer<typeof roleAssignmentListMetaSchema>;

/**
 * FA-05 (POL-16 na tela): revogar `target` tira do próprio ator o último perfil administrativo
 * vigente — a tela avisa sem chamar a API. A API confere de novo (RN-IAM-97).
 */
export function isLastAdministrativeAssignment(
  target: Pick<RoleAssignmentDto, 'id' | 'isAdministrative' | 'status'>,
  assignments: readonly Pick<
    RoleAssignmentDto,
    'id' | 'isAdministrative' | 'status' | 'validFrom' | 'validUntil'
  >[],
  now: Date,
): boolean {
  if (!target.isAdministrative || target.status !== 'ACTIVE') return false;
  return !assignments.some(
    (other) =>
      other.id !== target.id &&
      other.isAdministrative &&
      other.status === 'ACTIVE' &&
      Date.parse(other.validFrom) <= now.getTime() &&
      (other.validUntil === null || Date.parse(other.validUntil) > now.getTime()),
  );
}

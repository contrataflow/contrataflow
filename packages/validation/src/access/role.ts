import { isPermissionCode } from '@contrataflow/types';
import type { PermissionCode } from '@contrataflow/types';
import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Perfis do tenant e matriz de permissões (US-095 · api/14-tenant-administration.md ROL-02..08 ·
 * RN-IAM-79..88). Schemas compartilhados pela API (corpo/query/resposta) e pelas telas SCR-030/031
 * (`createRoleSchema`, `updateRoleSchema`).
 */

/** V-01: mesma mensagem para ausente, curto e longo. */
export const ROLE_NAME_MESSAGE = 'Informe um nome entre 3 e 120 caracteres.';
/** V-03. */
export const ROLE_PERMISSIONS_MESSAGE = 'Selecione permissões válidas.';

/** Chave do perfil (SCREAMING_SNAKE, ASCII; mesmo check de `roles_key_format`). */
export const ROLE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,59}$/;

/**
 * Permissões com que `ADMIN_ORGAO` é semeado (permissions.md §3.2): protegidas pela DEC-035 —
 * nunca saem do perfil (RN-IAM-82). A API confere a igualdade com a matriz padrão em teste; a UI
 * usa a lista para travar os interruptores (FA-01).
 */
export const ADMIN_ORGAO_SEEDED_PERMISSIONS = [
  'PROCESS_VIEW',
  'PROCESS_FOLLOW',
  'TAG_MANAGE',
  'TEMPLATE_VIEW',
  'TEMPLATE_MANAGE',
  'TEMPLATE_PUBLISH',
  'DOCUMENT_TYPE_MANAGE',
  'WORKFLOW_VIEW',
  'WORKFLOW_MANAGE',
  'WORKFLOW_PUBLISH',
  'COMMENT_MODERATE',
  'INBOX_VIEW',
  'DASHBOARD_VIEW',
  'AUDIT_VIEW',
  'AUDIT_EXPORT',
  'USER_VIEW',
  'USER_INVITE',
  'USER_MANAGE',
  'ROLE_VIEW',
  'ROLE_MANAGE',
  'ROLE_ASSIGN',
  'ORGANIZATION_MANAGE',
  'DEPARTMENT_MANAGE',
  'CATALOG_MANAGE',
  'CALENDAR_MANAGE',
  'SETTINGS_MANAGE',
] as const satisfies readonly PermissionCode[];

/** Chave do perfil protegido (DEC-035 · POL-12). */
export const PROTECTED_ROLE_KEY = 'ADMIN_ORGAO';

export const roleNameSchema = z
  .string({ error: ROLE_NAME_MESSAGE })
  .trim()
  .min(3, { error: ROLE_NAME_MESSAGE })
  .max(120, { error: ROLE_NAME_MESSAGE });

const descriptionSchema = z
  .string()
  .trim()
  .max(500, { error: 'Informe no máximo 500 caracteres.' });

/**
 * Lista de códigos do catálogo (V-03): código desconhecido → `REFERENCE_NOT_FOUND` no item;
 * repetidos são descartados.
 */
export const rolePermissionCodesSchema = z
  .array(
    z.string({ error: ROLE_PERMISSIONS_MESSAGE }).max(80, { error: ROLE_PERMISSIONS_MESSAGE }),
    {
      error: ROLE_PERMISSIONS_MESSAGE,
    },
  )
  .max(200, { error: ROLE_PERMISSIONS_MESSAGE })
  .superRefine((codes, context) => {
    codes.forEach((code, index) => {
      if (!isPermissionCode(code)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: ROLE_PERMISSIONS_MESSAGE,
          params: { code: 'REFERENCE_NOT_FOUND' },
        });
      }
    });
  })
  .transform((codes) => [...new Set(codes)] as PermissionCode[]);

/** ROL-03. */
export const createRoleSchema = z.object({
  name: roleNameSchema,
  description: descriptionSchema.nullish(),
  allowExternalAssignment: z.boolean({ error: 'Informe verdadeiro ou falso.' }).optional(),
  permissions: rolePermissionCodesSchema.optional(),
});
export type CreateRole = z.output<typeof createRoleSchema>;
export type CreateRoleInput = z.input<typeof createRoleSchema>;

/** ROL-05: `description: null` limpa a descrição; `key`, `isSystem` etc. não são editáveis. */
export const updateRoleSchema = z.object({
  name: roleNameSchema.optional(),
  description: descriptionSchema.nullish(),
  allowExternalAssignment: z.boolean({ error: 'Informe verdadeiro ou falso.' }).optional(),
});
export type UpdateRole = z.output<typeof updateRoleSchema>;
export type UpdateRoleInput = z.input<typeof updateRoleSchema>;

/** ROL-06: a lista COMPLETA de códigos marcados na matriz. */
export const updateRolePermissionsSchema = z.object({
  permissions: rolePermissionCodesSchema,
});
export type UpdateRolePermissions = z.output<typeof updateRolePermissionsSchema>;

/** ROL-07: corpo `{}` (campos extras são ignorados). */
export const duplicateRoleSchema = z.object({});

/** ROL-08 (FA-04): confirmação explícita quando há vínculos ativos com o perfil. */
export const deactivateRoleSchema = z.object({
  confirmDeactivate: z.boolean({ error: 'Informe verdadeiro ou falso.' }).optional(),
});
export type DeactivateRole = z.output<typeof deactivateRoleSchema>;

export const roleIdParamsSchema = z.strictObject({ id: uuidV7Schema });

/** ROL-02 (query): `search` por nome ou chave; `isActive` como texto booleano. */
export const roleListQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120, { error: 'Informe no máximo 120 caracteres.' })
    .optional()
    .describe('Contém, no nome ou na chave, sem diferenciar maiúsculas.'),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type RoleListQuery = z.infer<typeof roleListQuerySchema>;

/** `Role` da resposta (ROL-02..08); `permissions` só em ROL-04/06. */
export const roleSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  isProtected: z.boolean(),
  allowExternalAssignment: z.boolean(),
  isActive: z.boolean(),
  /** Vínculos com atribuição ativa do perfil (US-096; 0 enquanto não houver atribuições). */
  activeAssignmentsCount: z.int().min(0),
  permissions: z.array(z.string()).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.int(),
});
export type RoleDto = z.infer<typeof roleSchema>;

/** `Role` com a matriz (ROL-04/06). */
export const roleWithPermissionsSchema = roleSchema.extend({ permissions: z.array(z.string()) });
export type RoleWithPermissionsDto = z.infer<typeof roleWithPermissionsSchema>;

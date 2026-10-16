import { z } from 'zod';

import { SCOPE_TYPES } from './role-assignment.js';

/*
 * Permissões efetivas do usuário no tenant ativo (US-097 · ME-03 `GET /me/permissions` ·
 * permissions.md §9 · RN-IAM-106): única fonte dos hooks de permissão do frontend
 * (`usePermission`, `<Can>`). Conveniência de UI — a decisão é sempre da API (RN-IAM-107).
 */

/** Escopo em que a permissão vale (atribuição vigente do perfil — permissions.md §1). */
export const permissionScopeSchema = z
  .object({
    type: z.enum(SCOPE_TYPES),
    /** Órgão do escopo `ORGANIZATION`. */
    organizationId: z.uuid().optional(),
    /** Unidade do escopo `DEPARTMENT`. */
    departmentId: z.uuid().optional(),
    /** Inclui as unidades descendentes (`DEPARTMENT`/`OWN_DEPARTMENTS`). */
    includeSubtree: z.boolean(),
  })
  .meta({ id: 'PermissionScope' });
export type PermissionScopeDto = z.infer<typeof permissionScopeSchema>;

export const effectivePermissionSchema = z
  .object({
    code: z.string(),
    scopes: z.array(permissionScopeSchema),
  })
  .meta({ id: 'EffectivePermission' });
export type EffectivePermissionDto = z.infer<typeof effectivePermissionSchema>;

/** Resposta de ME-03: permissões por perfil/escopo e as capacidades implícitas (§7). */
export const myPermissionsSchema = z
  .object({
    permissions: z.array(effectivePermissionSchema),
    implicit: z.object({
      /** Unidades ativas de que o usuário é titular ou substituto (POL-05 · §7). */
      headOfDepartmentIds: z.array(z.uuid()),
    }),
  })
  .meta({ id: 'MyPermissions' });
export type MyPermissionsDto = z.infer<typeof myPermissionsSchema>;

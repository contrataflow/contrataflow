import { PERMISSIONS } from '@contrataflow/types';
import type { PermissionCode, PermissionRiskLevel } from '@contrataflow/types';

import { DEFAULT_ROLE_GRANTS } from './default-roles.js';

/*
 * Concessões padrão por perfil (permissions.md §3.2 — matriz perfil × permissão). PONTE até a
 * autorização por permissões efetivas (US-097): hoje o perfil do vínculo vem do contexto
 * (`roleKeys`) e as concessões, da matriz padrão semeada em todo tenant (US-094); a US-097 troca
 * `AccessFacade.assertCan` pela resolução real (perfis do tenant, escopos e cache) sem mudar quem
 * a chama.
 */

/** Risco da permissão (permissions.md §2): `HIGH` exige MFA conforme `security.mfaPolicy` (POL-14). */
export const PERMISSION_RISKS: Readonly<Record<PermissionCode, PermissionRiskLevel>> =
  Object.fromEntries(
    PERMISSIONS.map((permission) => [permission.code, permission.riskLevel]),
  ) as Record<PermissionCode, PermissionRiskLevel>;

/** Perfis padrão que concedem cada permissão (§3.2, lida por coluna). */
export const ROLE_GRANTS: Readonly<Record<PermissionCode, readonly string[]>> = (() => {
  const grants = Object.fromEntries(
    PERMISSIONS.map((permission) => [permission.code, [] as string[]]),
  ) as Record<PermissionCode, string[]>;
  for (const [roleKey, codes] of Object.entries(DEFAULT_ROLE_GRANTS)) {
    for (const code of codes) grants[code].push(roleKey);
  }
  return grants;
})();

/** Algum dos perfis concede a permissão. */
export function rolesGrant(roleKeys: readonly string[], permission: PermissionCode): boolean {
  return roleKeys.some((roleKey) => ROLE_GRANTS[permission].includes(roleKey));
}

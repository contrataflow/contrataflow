import type { PermissionCode } from '@contrataflow/types';

/*
 * Concessões padrão por perfil (permissions.md §2 e §5 — matriz perfil × permissão) das
 * permissões já consumidas pelas stories entregues. PONTE até a autorização por permissões
 * efetivas (US-097): hoje o perfil do vínculo vem do contexto (`roleKeys`) e as concessões, desta
 * tabela; a US-097 troca `AccessFacade.assertCan` pela resolução real (perfis, escopos e cache)
 * sem mudar quem a chama. Permissão nova entra aqui com a story que a consome.
 */

export type PermissionRisk = 'L' | 'M' | 'H';

/** Risco da permissão (permissions.md §2): `H` exige MFA conforme `security.mfaPolicy` (POL-14). */
export const PERMISSION_RISKS: Readonly<Record<PermissionCode, PermissionRisk>> = {
  APPROVAL_DECIDE: 'H',
  DOCUMENT_TYPE_MANAGE: 'H',
};

const APPROVER_ROLES = [
  'GESTOR_CONTRATACOES',
  'REQUISITANTE',
  'PLANEJAMENTO',
  'COMPRAS',
  'LICITACOES',
  'CONTABILIDADE',
  'JURIDICO',
  'CONTROLE_INTERNO',
  'AUTORIDADE_COMPETENTE',
] as const;

/** Perfis que concedem a permissão (§5 da matriz). */
export const ROLE_GRANTS: Readonly<Record<PermissionCode, readonly string[]>> = {
  APPROVAL_DECIDE: APPROVER_ROLES,
  DOCUMENT_TYPE_MANAGE: ['ADMIN_ORGAO'],
};

/** Algum dos perfis concede a permissão. */
export function rolesGrant(roleKeys: readonly string[], permission: PermissionCode): boolean {
  return roleKeys.some((roleKey) => ROLE_GRANTS[permission].includes(roleKey));
}

import { StatusChip } from '@contrataflow/ui';
import { PROTECTED_ROLE_KEY } from '@contrataflow/validation';
import type { RoleDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

export const ROLES_PATH = '/admin/perfis';

/** O perfil `ADMIN_ORGAO` nunca pode ser desativado (POL-12 · FA-05): a ação nem aparece. */
export function canDeactivate(role: RoleDto): boolean {
  return role.isActive && !role.isProtected && role.key !== PROTECTED_ROLE_KEY;
}

/** Situação do perfil: Ativo / Inativo. */
export function RoleStatusChip({ role }: { readonly role: RoleDto }) {
  const t = useTranslations('roles.badges');
  return (
    <StatusChip tone={role.isActive ? 'success' : 'warning'}>
      {role.isActive ? t('active') : t('inactive')}
    </StatusChip>
  );
}

/** Tipo do perfil: Padrão / Personalizado e, quando for o caso, Protegido. */
export function RoleKindChips({ role }: { readonly role: RoleDto }) {
  const t = useTranslations('roles.badges');
  return (
    <div className="flex flex-wrap gap-1.5">
      <StatusChip>{role.isSystem ? t('system') : t('custom')}</StatusChip>
      {role.isProtected ? <StatusChip>{t('protected')}</StatusChip> : null}
    </div>
  );
}

/** Todos os chips do perfil, para a faixa do detalhe. */
export function RoleBadges({ role }: { readonly role: RoleDto }) {
  const t = useTranslations('roles.badges');
  return (
    <>
      <RoleStatusChip role={role} />
      <RoleKindChips role={role} />
      {role.allowExternalAssignment ? <StatusChip tone="info">{t('external')}</StatusChip> : null}
    </>
  );
}

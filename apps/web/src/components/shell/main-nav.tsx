'use client';

import { cx } from '@contrataflow/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { usePermission } from '@/lib/permissions/use-permission';

import { Icon } from './icons';
import { ADMIN_NAV, MAIN_NAV, isActivePath } from './navigation';
import type { AdminNavItem, NavItem } from './navigation';

/*
 * Itens do menu sobre o navy do menu lateral (DEC-185): ativo na primária (o tenant pode trocá-la,
 * sempre com contraste validado); foco no azul claro da marca, legível sobre o navy.
 */
const SIDEBAR_LINK =
  'flex min-h-10 items-center gap-3 rounded-control px-3 text-sm focus-visible:outline-sidebar-accent';
const SIDEBAR_LINK_ACTIVE = 'bg-primary text-primary-foreground';
const SIDEBAR_LINK_IDLE = 'text-sidebar-foreground hover:bg-sidebar-foreground/10';

/** Menu principal (barra lateral e gaveta móvel): página atual com `aria-current`. */
export function MainNav({
  onNavigate,
  showExample = false,
}: {
  readonly onNavigate?: (() => void) | undefined;
  /** Item da página de exemplo do shell: só em ambientes de desenvolvimento e teste. */
  readonly showExample?: boolean;
}) {
  const t = useTranslations('shell');
  const handleClick = () => onNavigate?.();
  const pathname = usePathname();
  return (
    <nav aria-label={t('nav.label')} className="flex-1 space-y-1 overflow-y-auto p-3">
      {MAIN_NAV.filter((item) => showExample || item.labelKey !== 'example').map((item) =>
        item.permission ? (
          <GatedMainLink key={item.href} item={item} pathname={pathname} onNavigate={handleClick} />
        ) : (
          <MainLink key={item.href} item={item} pathname={pathname} onNavigate={handleClick} />
        ),
      )}
      <p className="mt-6 px-3 pb-1 text-xs font-semibold tracking-wide text-sidebar-muted uppercase">
        {t('nav.administration')}
      </p>
      <Link
        href="/admin"
        onClick={handleClick}
        aria-current={pathname === '/admin' ? 'page' : undefined}
        className={cx(
          SIDEBAR_LINK,
          isActivePath(pathname, '/admin') ? SIDEBAR_LINK_ACTIVE : SIDEBAR_LINK_IDLE,
        )}
      >
        <Icon
          name="settings"
          className={cx(
            'size-4',
            isActivePath(pathname, '/admin') ? 'text-primary-foreground' : 'text-sidebar-muted',
          )}
        />
        {t('admin.title')}
      </Link>
    </nav>
  );
}

function MainLink({
  item,
  pathname,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly onNavigate: () => void;
}) {
  const t = useTranslations('shell');
  const active = isActivePath(pathname, item.href);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx(SIDEBAR_LINK, 'font-medium', active ? SIDEBAR_LINK_ACTIVE : SIDEBAR_LINK_IDLE)}
    >
      <Icon
        name={item.icon}
        className={cx('size-4', active ? 'text-primary-foreground' : 'text-sidebar-muted')}
      />
      {t(`nav.${item.labelKey}`)}
    </Link>
  );
}

/** Item do menu principal que exige permissão: oculto quando a API confirma que falta (RN-FND-92). */
function GatedMainLink(props: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly onNavigate: () => void;
}) {
  const { allowed, status } = usePermission(props.item.permission ?? '');
  if (status === 'success' && !allowed) return null;
  return <MainLink {...props} />;
}

/** Navegação secundária de `(app)/admin`. */
export function AdminNav() {
  const t = useTranslations('shell.admin');
  const pathname = usePathname();
  return (
    <nav aria-label={t('label')} className="flex flex-wrap gap-1 border-b border-border pb-3">
      {ADMIN_NAV.map((item) =>
        item.permission ? (
          <GatedAdminLink key={item.href} item={item} pathname={pathname} />
        ) : (
          <AdminLink key={item.href} item={item} pathname={pathname} />
        ),
      )}
    </nav>
  );
}

function AdminLink({ item, pathname }: { readonly item: AdminNavItem; readonly pathname: string }) {
  const t = useTranslations('shell.admin');
  return (
    <Link
      href={item.href}
      aria-current={isActivePath(pathname, item.href) ? 'page' : undefined}
      className={cx(
        'inline-flex min-h-9 items-center rounded-control px-3 text-sm',
        isActivePath(pathname, item.href) ? 'bg-primary-soft text-primary' : 'hover:bg-muted',
      )}
    >
      {t(item.labelKey)}
    </Link>
  );
}

/** Item de administração que exige permissão: oculto quando a API confirma que falta (RN-FND-92). */
function GatedAdminLink({
  item,
  pathname,
}: {
  readonly item: AdminNavItem;
  readonly pathname: string;
}) {
  const { allowed, status } = usePermission(item.permission ?? '');
  if (status === 'success' && !allowed) return null;
  return <AdminLink item={item} pathname={pathname} />;
}

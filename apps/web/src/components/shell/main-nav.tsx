'use client';

import { cx } from '@contrataflow/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Icon } from './icons';
import { ADMIN_NAV, MAIN_NAV, isActivePath } from './navigation';

/** Menu principal (barra lateral e gaveta móvel): página atual com `aria-current`. */
export function MainNav({ onNavigate }: { readonly onNavigate?: (() => void) | undefined }) {
  const t = useTranslations('shell');
  const handleClick = () => onNavigate?.();
  const pathname = usePathname();
  return (
    <nav aria-label={t('nav.label')} className="flex-1 space-y-1 overflow-y-auto p-3">
      {MAIN_NAV.map((item) => {
        const active = isActivePath(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={handleClick}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'flex min-h-10 items-center gap-3 rounded-control px-3 text-sm font-medium',
              active ? 'bg-primary-soft text-primary' : 'text-foreground hover:bg-muted',
            )}
          >
            <Icon name={item.icon} className="size-4 text-muted-foreground" />
            {t(`nav.${item.labelKey}`)}
          </Link>
        );
      })}
      <p className="mt-6 px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('nav.administration')}
      </p>
      <Link
        href="/admin"
        onClick={handleClick}
        aria-current={pathname === '/admin' ? 'page' : undefined}
        className={cx(
          'flex min-h-10 items-center gap-3 rounded-control px-3 text-sm',
          isActivePath(pathname, '/admin')
            ? 'bg-primary-soft text-primary'
            : 'text-foreground hover:bg-muted',
        )}
      >
        <Icon name="settings" className="size-4 text-muted-foreground" />
        {t('admin.title')}
      </Link>
    </nav>
  );
}

/** Navegação secundária de `(app)/admin`. */
export function AdminNav() {
  const t = useTranslations('shell.admin');
  const pathname = usePathname();
  return (
    <nav aria-label={t('label')} className="flex flex-wrap gap-1 border-b border-border pb-3">
      {ADMIN_NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActivePath(pathname, item.href) ? 'page' : undefined}
          className={cx(
            'inline-flex min-h-9 items-center rounded-control px-3 text-sm',
            isActivePath(pathname, item.href) ? 'bg-primary-soft text-primary' : 'hover:bg-muted',
          )}
        >
          {t(item.labelKey)}
        </Link>
      ))}
    </nav>
  );
}

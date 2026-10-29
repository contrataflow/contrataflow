'use client';

import { cx } from '@contrataflow/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useTaskInboxCounters } from '@/features/task-inbox/task-inbox.api';
import { usePermission } from '@/lib/permissions/use-permission';

import { Icon } from './icons';
import { ADMIN_NAV, MAIN_NAV, NAV_GROUPS, isActivePath } from './navigation';
import type { AdminNavItem, NavItem } from './navigation';

/*
 * Itens da barra lateral clara (prd-4 · padrão 1): ativo em azul suave com indicador de 3 px na
 * primária (o tenant pode trocá-la, sempre com contraste validado); alvo de toque de 44 px.
 */
const SIDEBAR_LINK =
  'flex min-h-11 items-center gap-3 rounded-control px-3 text-sm focus-visible:outline-sidebar-accent';
const SIDEBAR_LINK_ACTIVE =
  'bg-primary-soft font-bold text-primary-soft-foreground shadow-[inset_3px_0_0_var(--color-primary)]';
const SIDEBAR_LINK_IDLE = 'font-medium text-sidebar-foreground hover:bg-muted';

/** Contadores das entradas com fila (TSK-02), na mesma chave que a caixa de tarefas consulta. */
type NavCounters = Partial<Record<NonNullable<NavItem['counter']>, number>>;

/**
 * Contadores da barra lateral: só com `INBOX_VIEW` confirmada (sem ela a API responderia 403). A
 * leitura é a mesma da caixa de tarefas (repete a cada 60 s com a aba visível); falha não mostra
 * contador.
 */
function useNavCounters(): NavCounters {
  const { allowed, status } = usePermission('INBOX_VIEW');
  const { data } = useTaskInboxCounters(status === 'success' && allowed);
  return data ? { mine: data.mine, pendingApprovals: data.pendingApprovals } : {};
}

/**
 * Menu principal (barra lateral e gaveta móvel) em grupos "Operação" e "Governança": página atual
 * com `aria-current`, contadores de pendências na caixa de tarefas e nas aprovações.
 */
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
  const counters = useNavCounters();
  const items = MAIN_NAV.filter((item) => showExample || item.labelKey !== 'example');
  return (
    <nav aria-label={t('nav.label')} className="flex flex-1 flex-col gap-6 px-3.5">
      {NAV_GROUPS.map((group) => (
        <div key={group} className="flex flex-col gap-1">
          <p
            id={`nav-grupo-${group}`}
            className="px-3 pb-1.5 text-[0.6875rem] font-bold tracking-[0.12em] text-sidebar-muted uppercase"
          >
            {t(`nav.groups.${group}`)}
          </p>
          <ul aria-labelledby={`nav-grupo-${group}`} className="flex flex-col gap-1">
            {items
              .filter((item) => item.group === group)
              .map((item) =>
                item.permission ? (
                  <GatedMainLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    count={item.counter ? counters[item.counter] : undefined}
                    onNavigate={handleClick}
                  />
                ) : (
                  <MainLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    count={item.counter ? counters[item.counter] : undefined}
                    onNavigate={handleClick}
                  />
                ),
              )}
          </ul>
        </div>
      ))}
    </nav>
  );
}

const MAX_COUNT = 99;

function MainLink({
  item,
  pathname,
  count,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly count: number | undefined;
  readonly onNavigate: () => void;
}) {
  const t = useTranslations('shell');
  const active = isActivePath(pathname, item.href);
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cx(SIDEBAR_LINK, active ? SIDEBAR_LINK_ACTIVE : SIDEBAR_LINK_IDLE)}
      >
        <Icon
          name={item.icon}
          className={cx('size-5 flex-none', active ? 'text-primary' : 'text-sidebar-muted')}
        />
        <span className="flex-1">{t(`nav.${item.labelKey}`)}</span>
        {count !== undefined && count > 0 ? (
          <>
            <span
              aria-hidden="true"
              className="inline-flex h-[1.375rem] min-w-[1.375rem] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground"
            >
              {count > MAX_COUNT ? t('nav.countOverflow') : count}
            </span>{' '}
            <span className="sr-only">{t('nav.count', { count })}</span>
          </>
        ) : null}
      </Link>
    </li>
  );
}

/** Item do menu principal que exige permissão: oculto quando a API confirma que falta (RN-FND-92). */
function GatedMainLink(props: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly count: number | undefined;
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
  // O hub (`/admin`) já lista as mesmas áreas em cartões: a barra não se repete ali.
  if (pathname === '/admin') return null;
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

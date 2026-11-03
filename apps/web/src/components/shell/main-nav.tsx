'use client';

import { Collapsible, CollapsibleContent, CollapsibleTrigger, cx } from '@contrataflow/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useTaskInboxCounters } from '@/features/task-inbox/task-inbox.api';
import { usePermission } from '@/lib/permissions/use-permission';

import { Icon } from './icons';
import { ADMIN_NAV, ADMIN_PATH, MAIN_NAV, isActivePath } from './navigation';
import type { AdminNavItem, NavItem } from './navigation';

/*
 * Itens da barra lateral clara (prd-6 · §2.2, padrão do Microlegis): 40 px de altura, ativo em
 * azul suave com indicador de 3 px na primária (o tenant pode trocá-la, sempre com contraste
 * validado). Os subitens da Administração têm 30 px e recuo de 42 px — com o grupo aberto, o menu
 * cabe em 1280×768 sem rolagem própria.
 */
const SIDEBAR_LINK =
  'flex min-h-10 items-center gap-3 rounded-control px-3 text-sm focus-visible:outline-sidebar-accent';
const SIDEBAR_LINK_ACTIVE =
  'bg-primary-soft font-bold text-primary-soft-foreground shadow-[inset_3px_0_0_var(--color-primary)]';
const SIDEBAR_LINK_IDLE = 'font-medium text-sidebar-foreground hover:bg-muted';
const SUB_LINK =
  'flex min-h-[1.875rem] items-center rounded-control pr-3 pl-[2.625rem] text-[0.8125rem] focus-visible:outline-sidebar-accent';

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
 * Menu principal (barra lateral e gaveta móvel): os itens do dia a dia sem rótulo de grupo, com o
 * contador no texto ("Caixa de tarefas · 2"), e o grupo "Sistema" com Auditoria e a Administração
 * recolhível, cujos subitens são as áreas de administração. Página atual com `aria-current`.
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
  const renderItem = (item: NavItem) => {
    if (item.href === ADMIN_PATH) {
      return (
        <AdminGroup key={item.href} item={item} pathname={pathname} onNavigate={handleClick} />
      );
    }
    const props = {
      item,
      pathname,
      count: item.counter ? counters[item.counter] : undefined,
      onNavigate: handleClick,
    };
    return item.permission ? (
      <GatedMainLink key={item.href} {...props} />
    ) : (
      <MainLink key={item.href} {...props} />
    );
  };
  return (
    <nav aria-label={t('nav.label')} className="flex flex-1 flex-col px-3">
      <ul className="flex flex-col gap-0.5">
        {items.filter((item) => item.group === 'main').map(renderItem)}
      </ul>
      <p
        id="nav-grupo-sistema"
        className="px-3 pt-3 pb-1.5 text-[0.6875rem] font-bold tracking-[0.12em] text-sidebar-muted uppercase"
      >
        {t('nav.groups.system')}
      </p>
      <ul aria-labelledby="nav-grupo-sistema" className="flex flex-col gap-0.5">
        {items.filter((item) => item.group === 'system').map(renderItem)}
      </ul>
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
          className={cx(
            'size-[1.125rem] flex-none',
            active ? 'text-primary' : 'text-sidebar-muted',
          )}
        />
        <span className="flex-1">
          {t(`nav.${item.labelKey}`)}
          {/* Contador no texto (prd-6 · §2.2); some enquanto a API não respondeu. */}
          {count === undefined ? null : (
            <>
              <span aria-hidden="true" className="font-medium text-sidebar-muted">
                {' · '}
                {count > MAX_COUNT ? t('nav.countOverflow') : count}
              </span>{' '}
              <span className="sr-only">{t('nav.count', { count })}</span>
            </>
          )}
        </span>
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

/**
 * "Administração" recolhível (prd-6 · §2.2): o rótulo leva ao hub (`/admin`) e o chevron abre ou
 * fecha as áreas (substituem a antiga barra horizontal de `(app)/admin`). Começa aberto nas rotas
 * de `/admin*` e fechado fora delas; ao entrar na administração por outro caminho (paleta, hub),
 * abre sozinho.
 */
function AdminGroup({
  item,
  pathname,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly onNavigate: () => void;
}) {
  const t = useTranslations('shell');
  const inAdmin = isActivePath(pathname, ADMIN_PATH);
  const onHub = pathname === ADMIN_PATH;
  const [open, setOpen] = useState(inAdmin);
  const [wasInAdmin, setWasInAdmin] = useState(inAdmin);
  if (inAdmin !== wasInAdmin) {
    setWasInAdmin(inAdmin);
    if (inAdmin) setOpen(true);
  }
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cx(
            'flex items-center rounded-control',
            onHub
              ? SIDEBAR_LINK_ACTIVE
              : inAdmin
                ? 'font-bold text-sidebar-foreground hover:bg-muted'
                : SIDEBAR_LINK_IDLE,
          )}
        >
          <Link
            href={item.href}
            onClick={onNavigate}
            aria-current={onHub ? 'page' : undefined}
            className={cx(SIDEBAR_LINK, 'flex-1 pr-1')}
          >
            <Icon
              name={item.icon}
              className={cx(
                'size-[1.125rem] flex-none',
                inAdmin ? 'text-primary' : 'text-sidebar-muted',
              )}
            />
            <span className="flex-1">{t(`nav.${item.labelKey}`)}</span>
          </Link>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={t('nav.adminAreas')}
              className="grid size-10 flex-none place-items-center rounded-control text-sidebar-muted hover:text-sidebar-foreground focus-visible:outline-sidebar-accent"
            >
              <Icon name={open ? 'chevronUp' : 'chevronDown'} className="size-4" />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <ul aria-label={t('nav.adminAreas')} className="flex flex-col pt-0.5">
            {ADMIN_NAV.map((area) =>
              area.permission ? (
                <GatedAdminLink
                  key={area.href}
                  item={area}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ) : (
                <AdminLink
                  key={area.href}
                  item={area}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ),
            )}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function AdminLink({
  item,
  pathname,
  onNavigate,
}: {
  readonly item: AdminNavItem;
  readonly pathname: string;
  readonly onNavigate: () => void;
}) {
  const t = useTranslations('shell.admin');
  const active = isActivePath(pathname, item.href);
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cx(SUB_LINK, active ? SIDEBAR_LINK_ACTIVE : SIDEBAR_LINK_IDLE)}
      >
        {t(item.labelKey)}
      </Link>
    </li>
  );
}

/** Área de administração que exige permissão: oculta quando a API confirma que falta (RN-FND-92). */
function GatedAdminLink(props: {
  readonly item: AdminNavItem;
  readonly pathname: string;
  readonly onNavigate: () => void;
}) {
  const { allowed, status } = usePermission(props.item.permission ?? '');
  if (status === 'success' && !allowed) return null;
  return <AdminLink {...props} />;
}

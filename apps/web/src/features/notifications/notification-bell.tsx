'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from '@contrataflow/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Icon } from '@/components/shell/icons';
import { useTenantId } from '@/lib/session/session-context';

import { RelativeTime, notificationIcon } from './notification-item';
import {
  PANEL_SIZE,
  UNREAD_COUNT_REFETCH_MS,
  fetchNotifications,
  fetchUnreadCount,
  notificationKeys,
} from './notifications.api';
import { useNotificationActions } from './use-notification-actions';

const MAX_BADGE = 99;

/** Contador do sininho (NTF-02): sondagem periódica e no foco; falha mantém o último valor. */
export function useUnreadCount(): number {
  const tenantId = useTenantId();
  const query = useQuery({
    queryKey: notificationKeys.unreadCount(tenantId),
    queryFn: ({ signal }) => fetchUnreadCount(signal),
    refetchInterval: UNREAD_COUNT_REFETCH_MS,
    refetchOnWindowFocus: true,
    // O sininho nunca derruba a tela: sem retentativa nem boundary; `data` guarda o último valor.
    retry: false,
    throwOnError: false,
  });
  return query.data ?? 0;
}

function Badge({ count }: { readonly count: number }) {
  const t = useTranslations('notifications.bell');
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1.5 text-[0.6875rem] leading-none font-bold text-destructive-foreground"
    >
      {count > MAX_BADGE ? t('overflow') : count}
    </span>
  );
}

/** Painel curto do sininho (NTF-01 com os 5 mais recentes), carregado ao abrir. */
function NotificationPanel() {
  const t = useTranslations('notifications');
  const tenantId = useTenantId();
  const actions = useNotificationActions();
  const recent = useQuery({
    queryKey: [...notificationKeys.list(tenantId, 'all'), 'panel'],
    queryFn: ({ signal }) => fetchNotifications({ limit: PANEL_SIZE, filter: 'all' }, signal),
    throwOnError: false,
    retry: false,
  });
  const items = recent.data?.items ?? [];
  // Dentro de `role="menu"` só há itens de menu (estados como itens desabilitados — axe).
  const state = (text: string) => (
    <DropdownMenuItem disabled className="py-3 text-muted-foreground">
      {text}
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenuLabel className="normal-case">{t('panel.heading')}</DropdownMenuLabel>
      {items.some((item) => item.readAt === null) ? (
        <DropdownMenuItem
          disabled={actions.busy}
          onSelect={(event) => {
            event.preventDefault();
            actions.markAll();
          }}
        >
          <Icon name="check" />
          {t('actions.markAllRead')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      {recent.isPending ? (
        <DropdownMenuItem disabled aria-label={t('panel.loading')}>
          <Skeleton className="h-8 w-full" />
        </DropdownMenuItem>
      ) : recent.isError ? (
        state(t('panel.failed'))
      ) : items.length === 0 ? (
        state(t('panel.empty'))
      ) : (
        items.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <Link
              href={item.link ?? '/notificacoes'}
              onClick={() => {
                actions.open(item);
              }}
              className="flex items-start gap-3"
            >
              <Icon
                name={notificationIcon(item.type)}
                className={item.readAt === null ? 'mt-0.5 size-4 text-primary' : 'mt-0.5 size-4'}
              />
              <span className="flex min-w-0 flex-col">
                <span className={item.readAt === null ? 'font-semibold' : 'text-muted-foreground'}>
                  {item.title}
                  {item.readAt === null ? (
                    <span className="sr-only"> ({t('item.unread')})</span>
                  ) : null}
                </span>
                <RelativeTime value={item.createdAt} />
              </span>
            </Link>
          </DropdownMenuItem>
        ))
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href="/notificacoes" className="justify-center font-medium">
          {t('panel.seeAll')}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href="/perfil?aba=notificacoes" className="justify-center text-muted-foreground">
          {t('panel.managePreferences')}
        </Link>
      </DropdownMenuItem>
    </>
  );
}

/**
 * `NotificationBell` (SCR-036): sininho global do cabeçalho com o contador de não lidas anunciado
 * por `aria-live="polite"`. A partir de 768 px abre o painel com as mais recentes; abaixo disso o
 * sininho leva direto à página cheia (`/notificacoes`).
 */
export function NotificationBell() {
  const t = useTranslations('notifications.bell');
  const count = useUnreadCount();
  const [open, setOpen] = useState(false);
  const label = count > 0 ? t('labelWithCount', { count }) : t('label');
  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {t('announce', { count })}
      </span>
      <Link
        href="/notificacoes"
        aria-label={label}
        className="relative grid size-11 place-items-center rounded-control border border-border-strong bg-surface hover:bg-muted md:hidden"
      >
        <Icon name="bell" className="size-5 text-muted-foreground" />
        <Badge count={count} />
      </Link>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label={label}
            className="relative hidden md:grid md:place-items-center"
          >
            <Icon name="bell" className="size-5 text-muted-foreground" />
            <Badge count={count} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-96 max-w-[calc(100vw-2rem)]">
          {open ? <NotificationPanel /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

'use client';

import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cx,
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
function NotificationPanel({ onNavigate }: { readonly onNavigate: () => void }) {
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
  const state = (text: string) => (
    <p className="px-4 py-6 text-center text-sm text-muted-foreground">{text}</p>
  );
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold text-brand-ink">{t('panel.heading')}</h2>
        {items.some((item) => item.readAt === null) ? (
          <Button variant="link" size="sm" disabled={actions.busy} onClick={actions.markAll}>
            {t('actions.markAllRead')}
          </Button>
        ) : null}
      </div>
      {recent.isPending ? (
        <div role="status" aria-label={t('panel.loading')} className="flex flex-col gap-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : recent.isError ? (
        state(t('panel.failed'))
      ) : items.length === 0 ? (
        state(t('panel.empty'))
      ) : (
        <ul aria-label={t('panel.heading')} className="flex flex-col py-1">
          {items.map((item) => {
            const unread = item.readAt === null;
            return (
              <li key={item.id}>
                <Link
                  href={item.link ?? '/notificacoes'}
                  onClick={() => {
                    actions.open(item);
                    onNavigate();
                  }}
                  className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted focus-visible:bg-muted"
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      'mt-0.5 grid size-8 flex-none place-items-center rounded-full',
                      unread
                        ? 'bg-primary-soft text-primary-soft-foreground'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon name={notificationIcon(item.type)} className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cx(
                        'text-sm',
                        unread ? 'font-semibold text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {item.title}
                      {unread ? <span className="sr-only"> ({t('item.unread')})</span> : null}
                    </span>
                    <RelativeTime value={item.createdAt} />
                  </span>
                  {unread ? (
                    <span
                      aria-hidden="true"
                      className="mt-2 size-2 flex-none rounded-full bg-primary"
                    />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm">
        <Link
          href="/notificacoes"
          onClick={onNavigate}
          className="font-semibold text-primary-soft-foreground underline-offset-2 hover:underline"
        >
          {t('panel.seeAll')}
        </Link>
        <Link
          href="/perfil?aba=notificacoes"
          onClick={onNavigate}
          className="text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('panel.managePreferences')}
        </Link>
      </div>
    </div>
  );
}

/**
 * `NotificationBell` (SCR-036 · prd-5): sininho global do cabeçalho com o contador de não lidas
 * anunciado por `aria-live="polite"`. A partir de 768 px abre um `Popover` com as 5 mais recentes
 * (marcador nas não lidas) e o link para a página; abaixo disso leva direto a `/notificacoes`.
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
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label={label}
                className="relative max-md:hidden md:grid md:place-items-center"
              >
                <Icon name="bell" className="size-5 text-muted-foreground" />
                <Badge count={count} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('label')}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" aria-label={t('panel')} className="w-96 p-0">
          {open ? (
            <NotificationPanel
              onNavigate={() => {
                setOpen(false);
              }}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </>
  );
}

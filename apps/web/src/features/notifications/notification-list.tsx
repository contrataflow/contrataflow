'use client';

import {
  Alert,
  Bell,
  Button,
  Check,
  EmptyState,
  ListPage,
  ViewTabs,
  buttonClassName,
} from '@contrataflow/ui';
import type { NotificationDto } from '@contrataflow/validation';
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { useShellSession } from '@/lib/session/session-context';

import { NotificationItem } from './notification-item';
import { LIST_PAGE_SIZE, fetchNotifications, notificationKeys } from './notifications.api';
import type { NotificationFilter } from './notifications.api';
import { useNotificationActions } from './use-notification-actions';

const FILTERS: readonly NotificationFilter[] = ['all', 'unread'];
const PANEL_ID = 'notificacoes-painel';

/** Dia civil (`YYYY-MM-DD`) de um instante no fuso da instituição. */
function dayOf(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));
}

/** Notificações em grupos por dia, na ordem em que a API as devolve (mais recentes primeiro). */
export function groupByDay(
  items: readonly NotificationDto[],
  timeZone: string,
): { readonly day: string; readonly items: readonly NotificationDto[] }[] {
  const groups: { day: string; items: NotificationDto[] }[] = [];
  for (const item of items) {
    const day = dayOf(item.createdAt, timeZone);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/**
 * SCR-036 — `NotificationList` (`/notificacoes` · US-111) no modelo `ListPage` (prd-5): histórico
 * completo das notificações do usuário no tenant ativo, agrupado por dia e paginado por cursor
 * (`useInfiniteQuery` sobre NTF-01). Visões "Todas"/"Não lidas" em abas, "Marcar todas como
 * lidas" (NTF-04) como única ação do cabeçalho e, por item, marcar como lida (NTF-03) e arquivar
 * (NTF-05). Estados: skeleton na primeira carga, vazio, erro com "Tentar novamente" (mantém a
 * lista anterior) e item lido atenuado, sem o marcador das não lidas.
 */
export function NotificationList() {
  const t = useTranslations('notifications');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const actions = useNotificationActions();

  const list = useInfiniteQuery({
    queryKey: notificationKeys.list(tenantId, filter),
    queryFn: ({ pageParam, signal }) =>
      fetchNotifications({ cursor: pageParam, limit: LIST_PAGE_SIZE, filter }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    // Erro de carga fica na tela ("Tentar novamente"), sem derrubar o segmento.
    throwOnError: false,
  });

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const hasUnread = items.some((item) => item.readAt === null);
  const today = dayOf(now, timeZone);
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000), timeZone);
  const dayLabel = (day: string) =>
    day === today
      ? t('list.today')
      : day === yesterday
        ? t('list.yesterday')
        : format.dateTime(new Date(`${day}T12:00:00Z`), {
            dateStyle: 'long',
            timeZone: 'UTC',
          });
  const retry = (
    <Button variant="secondary" size="sm" className="mt-2" onClick={() => void list.refetch()}>
      {t('actions.retry')}
    </Button>
  );

  return (
    <ListPage
      header={
        <AppPageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <>
              <Link
                href="/perfil?aba=notificacoes"
                className={buttonClassName({ variant: 'ghost' })}
              >
                {t('actions.preferences')}
              </Link>
              <Button
                iconLeft={<Check />}
                disabled={!hasUnread || actions.busy}
                onClick={actions.markAll}
              >
                {t('actions.markAllRead')}
              </Button>
            </>
          }
        />
      }
      tabs={
        <ViewTabs
          label={t('filters.label')}
          value={filter}
          panelId={PANEL_ID}
          onValueChange={(id) => {
            setFilter(id as NotificationFilter);
          }}
          tabs={FILTERS.map((value) => ({ id: value, label: t(`filters.${value}`) }))}
        />
      }
      loading={list.isPending}
      loadingLabel={t('list.loading')}
      error={
        list.isError ? (
          <Alert tone="error" title={t('list.loadFailed')}>
            {retry}
          </Alert>
        ) : null
      }
      empty={
        !list.isPending && !list.isError && items.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={filter === 'unread' ? t('list.emptyUnread') : t('list.empty')}
            description={t('list.emptyHint')}
          />
        ) : null
      }
    >
      <div
        role="tabpanel"
        id={PANEL_ID}
        aria-label={t(`filters.${filter}`)}
        className="flex min-w-0 flex-col gap-5 empty:hidden"
      >
        {items.length > 0 ? (
          <>
            <ul aria-label={t('title')} className="flex flex-col gap-5">
              {groupByDay(items, timeZone).map((group) => (
                <li key={group.day} className="flex flex-col gap-2">
                  <h2 className="text-label text-muted-foreground uppercase">
                    {dayLabel(group.day)}
                  </h2>
                  <ul className="overflow-hidden rounded-card bg-surface shadow-card">
                    {group.items.map((item) => (
                      <NotificationItem
                        key={item.id}
                        notification={item}
                        busy={actions.busy}
                        onOpen={actions.open}
                        onMarkRead={actions.markRead}
                        onArchive={actions.archive}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {list.hasNextPage ? (
              <Button
                variant="secondary"
                className="self-center"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {t('actions.loadMore')}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </ListPage>
  );
}

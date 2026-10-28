'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { useTenantId } from '@/lib/session/session-context';

import { NotificationItem } from './notification-item';
import { LIST_PAGE_SIZE, fetchNotifications, notificationKeys } from './notifications.api';
import type { NotificationFilter } from './notifications.api';
import { useNotificationActions } from './use-notification-actions';

const FILTERS: readonly NotificationFilter[] = ['all', 'unread'];

/**
 * SCR-036 — `NotificationList` (`/notificacoes` · US-111): histórico completo das notificações do
 * usuário no tenant ativo, paginado por cursor (`useInfiniteQuery` sobre NTF-01), com filtro
 * "Não lidas", "Marcar todas como lidas" (NTF-04) e, por item, marcar como lida (NTF-03) e
 * arquivar (NTF-05). Estados: skeleton na primeira carga, vazio, erro com "Tentar novamente"
 * (mantém a lista anterior) e item lido atenuado.
 */
export function NotificationList() {
  const t = useTranslations('notifications');
  const tenantId = useTenantId();
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

  return (
    <section className="flex flex-col gap-6">
      <AppPageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Link
            href="/perfil?aba=notificacoes"
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('actions.preferences')}
          </Link>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">{t('filters.label')}</legend>
          {FILTERS.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'primary' : 'secondary'}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
              }}
            >
              {t(`filters.${value}`)}
            </Button>
          ))}
        </fieldset>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasUnread || actions.busy}
          onClick={actions.markAll}
        >
          {t('actions.markAllRead')}
        </Button>
      </div>

      {list.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-label={t('list.loading')}>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : list.isError && items.length === 0 ? (
        <Alert tone="error" title={t('list.loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void list.refetch()}
          >
            {t('actions.retry')}
          </Button>
        </Alert>
      ) : items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-8 text-center">
          <p className="font-medium">
            {filter === 'unread' ? t('list.emptyUnread') : t('list.empty')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{t('list.emptyHint')}</p>
        </div>
      ) : (
        <>
          {list.isError ? (
            <Alert tone="error" title={t('list.loadFailed')}>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() => void list.refetch()}
              >
                {t('actions.retry')}
              </Button>
            </Alert>
          ) : null}
          <ul className="overflow-hidden rounded-card border border-border" aria-label={t('title')}>
            {items.map((item) => (
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
      )}
    </section>
  );
}

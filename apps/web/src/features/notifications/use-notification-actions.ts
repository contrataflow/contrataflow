'use client';

import { toast } from '@contrataflow/ui';
import type { NotificationDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  archiveNotification,
  markAllNotificationsRead,
  markNotificationRead,
  notificationKeys,
} from './notifications.api';

/**
 * Ações da central (NTF-03..05): toda mutação invalida contador e lista (`['t', tenantId,
 * 'notifications']`). 404 → a notificação sumiu (outro dispositivo, arquivada): sai da lista local.
 */
export function useNotificationActions() {
  const t = useTranslations('notifications.toast');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();

  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all(tenantId) });
  const failure = (error: unknown) => {
    if (isApiError(error) && error.status === 404) {
      toast({ title: t('notFound'), tone: 'info' });
    } else if (isApiError(error) && error.status === 503) {
      toast({ title: t('unavailable'), tone: 'error' });
    } else {
      toast({ title: t('failed'), tone: 'error' });
    }
    void refresh();
  };

  const markRead = useMutation({
    mutationFn: (notification: NotificationDto) => markNotificationRead(notification.id),
    onSuccess: () => refresh(),
    onError: failure,
  });
  const archive = useMutation({
    mutationFn: (notification: NotificationDto) => archiveNotification(notification.id),
    onSuccess: () => {
      toast({ title: t('archived'), tone: 'success' });
      return refresh();
    },
    onError: failure,
  });
  const markAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: (result) => {
      toast({ title: t('allRead', { count: result.data.updated }), tone: 'success' });
      return refresh();
    },
    onError: failure,
  });

  return {
    markRead: (notification: NotificationDto) => {
      markRead.mutate(notification);
    },
    /** Abrir o link marca como lida, sem toast (a navegação segue normalmente — FA-05). */
    open: (notification: NotificationDto) => {
      if (notification.readAt === null) markRead.mutate(notification);
    },
    archive: (notification: NotificationDto) => {
      archive.mutate(notification);
    },
    markAll: () => {
      markAll.mutate();
    },
    busy: markRead.isPending || archive.isPending || markAll.isPending,
  };
}

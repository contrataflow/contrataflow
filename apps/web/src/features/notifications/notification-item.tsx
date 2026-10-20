'use client';

import type { NotificationType } from '@contrataflow/types';
import { Button, cx } from '@contrataflow/ui';
import type { NotificationDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';

import { Icon } from '@/components/shell/icons';
import type { IconName } from '@/components/shell/icons';

/** Ícone por tipo (SCR-036: "ícone por tipo"). */
const TYPE_ICONS: Readonly<Record<NotificationType, IconName>> = {
  PROCESS_RECEIVED: 'inbox',
  PROCESS_RETURNED: 'folder',
  PROCESS_ASSIGNED: 'folder',
  PROCESS_STATUS_CHANGED: 'folder',
  APPROVAL_REQUESTED: 'stamp',
  APPROVAL_DECIDED: 'stamp',
  APPROVAL_REASSIGNED: 'stamp',
  MENTIONED: 'message',
  COMMENT_REPLY: 'message',
  STAGE_DUE_SOON: 'clock',
  STAGE_OVERDUE: 'clock',
  PARTICIPANT_ADDED: 'user',
  ATTACHMENT_REJECTED: 'alert',
  DOCUMENT_RENDER_FAILED: 'alert',
  ROLE_CHANGED: 'user',
  AI_GENERATION_READY: 'folder',
  AI_GENERATION_FAILED: 'alert',
  AI_USAGE_LIMIT_WARNING: 'alert',
};

export function notificationIcon(type: NotificationType): IconName {
  return TYPE_ICONS[type];
}

/** Tempo relativo ("há 5 minutos") atualizado a cada minuto, com a data completa no `title`. */
export function RelativeTime({ value }: { readonly value: string }) {
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const date = new Date(value);
  return (
    <time
      dateTime={value}
      title={format.dateTime(date, { dateStyle: 'short', timeStyle: 'short' })}
      className="text-xs text-muted-foreground"
    >
      {format.relativeTime(date, now)}
    </time>
  );
}

export interface NotificationItemProps {
  readonly notification: NotificationDto;
  /** Ao abrir o link (o item é marcado como lido). */
  readonly onOpen: (notification: NotificationDto) => void;
  readonly onMarkRead: (notification: NotificationDto) => void;
  readonly onArchive: (notification: NotificationDto) => void;
  readonly busy?: boolean;
}

/**
 * `NotificationItem` (SCR-036): ícone por tipo, título, corpo, tempo relativo e estado lido/não
 * lido (não lido em destaque, lido atenuado — o estado também vai em texto, não só na cor).
 * O link leva ao recurso; se ele não existir mais, a tela de destino mostra o próprio 404 (FA-05).
 */
export function NotificationItem({
  notification,
  onOpen,
  onMarkRead,
  onArchive,
  busy = false,
}: NotificationItemProps) {
  const t = useTranslations('notifications');
  const unread = notification.readAt === null;
  const heading = notification.link ? (
    <Link
      href={notification.link}
      onClick={() => {
        onOpen(notification);
      }}
      className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      {notification.title}
    </Link>
  ) : (
    <span className="font-medium">{notification.title}</span>
  );
  return (
    <li
      className={cx(
        'flex gap-3 border-b border-border px-4 py-3 last:border-b-0',
        unread ? 'bg-surface' : 'bg-muted/40 text-muted-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'mt-0.5 grid size-8 flex-none place-items-center rounded-full',
          unread ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon name={notificationIcon(notification.type)} className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {heading}
          <span className={cx('text-xs', unread ? 'font-semibold text-primary' : 'sr-only')}>
            {unread ? t('item.unread') : t('item.read')}
          </span>
        </div>
        <p className="text-sm break-words">{notification.body}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RelativeTime value={notification.createdAt} />
          {notification.groupCount > 1 ? (
            <span className="text-xs text-muted-foreground">
              {t('item.grouped', { count: notification.groupCount })}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-none flex-col items-end gap-1 sm:flex-row sm:items-start">
        {unread ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={t('actions.markReadOf', { title: notification.title })}
            onClick={() => {
              onMarkRead(notification);
            }}
          >
            <Icon name="check" />
            <span className="hidden sm:inline">{t('actions.markRead')}</span>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={t('actions.archiveOf', { title: notification.title })}
          onClick={() => {
            onArchive(notification);
          }}
        >
          <Icon name="archive" />
          <span className="hidden sm:inline">{t('actions.archive')}</span>
        </Button>
      </div>
    </li>
  );
}

import type {
  NotificationDto,
  NotificationListQuery,
  UnreadCountDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { requireRequestContext } from '#shared/context/request-context.js';
import { cursorResult, decodeCursor } from '#shared/http/pagination.js';
import type { CursorResult } from '#shared/http/pagination.js';

import {
  NOTIFICATION_CLOCK,
  NOTIFICATION_REPOSITORY,
  NOTIFICATION_TRANSACTIONS,
} from './notification-ports.js';
import type {
  NotificationClock,
  NotificationRepository,
  NotificationTransactions,
} from './notification-ports.js';
import { toNotificationDto } from './notification.view.js';

/** Posição opaca do cursor de NTF-01 (o cliente nunca interpreta). */
const cursorPosition = z.strictObject({ c: z.iso.datetime(), i: z.uuid() });

/** Destinatário = usuário autenticado (as rotas NTF-* são do próprio recurso, como as `ME-*`). */
export function currentRecipientId(): string {
  const { userId } = requireRequestContext().actor;
  if (userId === null) throw new Error('NTF-*: rota de tenant sem usuário autenticado');
  return userId;
}

/**
 * `ListNotificationsQuery` — NTF-01 (US-111): as notificações do usuário no tenant ativo, não
 * arquivadas e não vencidas (RN-NTF-09), mais recentes primeiro, por cursor; `unreadOnly` filtra
 * as não lidas. Cursor inválido → 422 `VALIDATION_ERROR` (V-01).
 */
@Injectable()
export class ListNotificationsQuery {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(NOTIFICATION_TRANSACTIONS) private readonly transactions: NotificationTransactions,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
  ) {}

  execute(query: NotificationListQuery): Promise<CursorResult<NotificationDto>> {
    const recipientId = currentRecipientId();
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor, cursorPosition);
    return this.transactions.read(async (tx) => {
      const fetched = await this.notifications.list(tx, {
        recipientId,
        unreadOnly: query.unreadOnly,
        after: position === null ? null : { createdAt: new Date(position.c), id: position.i },
        take: query.limit + 1,
        now: this.clock(),
      });
      return cursorResult(fetched.map(toNotificationDto), query.limit, (item) => ({
        c: item.createdAt,
        i: item.id,
      }));
    });
  }
}

/** `GetUnreadCountQuery` — NTF-02: contador do sininho (RN-NTF-10). */
@Injectable()
export class GetUnreadCountQuery {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(NOTIFICATION_TRANSACTIONS) private readonly transactions: NotificationTransactions,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
  ) {}

  execute(): Promise<UnreadCountDto> {
    const recipientId = currentRecipientId();
    return this.transactions.read(async (tx) => ({
      count: await this.notifications.countUnread(tx, recipientId, this.clock()),
    }));
  }
}

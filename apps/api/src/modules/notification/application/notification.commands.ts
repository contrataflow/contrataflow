import type { NotificationDto, ReadAllResultDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

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
import { notificationNotFound } from './notification.errors.js';
import { currentRecipientId } from './notification.queries.js';
import { toNotificationDto } from './notification.view.js';

/*
 * Comandos da central (US-111 · NTF-03..05): só sobre as notificações do próprio destinatário
 * (RN-NTF-11/12), idempotentes (repetir não é erro nem muda o instante já gravado) e sem
 * `AuditLog` nem evento de domínio (DEC-161: projeção de sistema, alto volume, baixo valor).
 */

/** `MarkNotificationReadCommand` — NTF-03. @throws ApiError 404 `NOTIFICATION_NOT_FOUND` */
@Injectable()
export class MarkNotificationReadCommand {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(NOTIFICATION_TRANSACTIONS) private readonly transactions: NotificationTransactions,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
  ) {}

  execute(id: string): Promise<NotificationDto> {
    const recipientId = currentRecipientId();
    return this.transactions.run(async (tx) => {
      await this.notifications.markRead(tx, id, recipientId, this.clock());
      const notification = await this.notifications.findOwn(tx, id, recipientId);
      if (!notification) throw notificationNotFound();
      return toNotificationDto(notification);
    });
  }
}

/** `MarkAllReadCommand` — NTF-04: só o usuário autenticado no tenant ativo (RN-NTF-12). */
@Injectable()
export class MarkAllReadCommand {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(NOTIFICATION_TRANSACTIONS) private readonly transactions: NotificationTransactions,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
  ) {}

  execute(): Promise<ReadAllResultDto> {
    const recipientId = currentRecipientId();
    return this.transactions.run(async (tx) => ({
      updated: await this.notifications.markAllRead(tx, recipientId, this.clock()),
    }));
  }
}

/** `ArchiveNotificationCommand` — NTF-05. @throws ApiError 404 `NOTIFICATION_NOT_FOUND` */
@Injectable()
export class ArchiveNotificationCommand {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(NOTIFICATION_TRANSACTIONS) private readonly transactions: NotificationTransactions,
    @Inject(NOTIFICATION_CLOCK) private readonly clock: NotificationClock,
  ) {}

  execute(id: string): Promise<NotificationDto> {
    const recipientId = currentRecipientId();
    return this.transactions.run(async (tx) => {
      await this.notifications.archive(tx, id, recipientId, this.clock());
      const notification = await this.notifications.findOwn(tx, id, recipientId);
      if (!notification) throw notificationNotFound();
      return toNotificationDto(notification);
    });
  }
}

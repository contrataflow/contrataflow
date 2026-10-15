import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  NotificationListFilter,
  NotificationRepository,
  NotificationTransactions,
} from '../application/notification-ports.js';
import { isListed, isUnread } from '../domain/notification.js';
import type { Notification } from '../domain/notification.js';

/** `createdAt DESC, id DESC` — a mesma ordem do índice `notifications_recipient_idx`. */
function newestFirst(a: Notification, b: Notification): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
}

/**
 * Notificações em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`), filtro pelo
 * destinatário e atualizações idempotentes. `seed` simula o `NotificationDispatcher` do worker.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly rows = new Map<string, Notification>();

  seed(...notifications: readonly Notification[]): void {
    for (const notification of notifications) this.rows.set(notification.id, notification);
  }

  private own(recipientId: string): Notification[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter(
      (n) => n.tenantId === tenantId && n.recipientId === recipientId,
    );
  }

  list(_tx: TenantTx, filter: NotificationListFilter): Promise<Notification[]> {
    const { after } = filter;
    return Promise.resolve(
      this.own(filter.recipientId)
        .filter((n) => isListed(n, filter.now))
        .filter((n) => !filter.unreadOnly || n.readAt === null)
        .filter(
          (n) =>
            after === null ||
            n.createdAt.getTime() < after.createdAt.getTime() ||
            (n.createdAt.getTime() === after.createdAt.getTime() && n.id < after.id),
        )
        .sort(newestFirst)
        .slice(0, filter.take),
    );
  }

  countUnread(_tx: TenantTx, recipientId: string, now: Date): Promise<number> {
    return Promise.resolve(this.own(recipientId).filter((n) => isUnread(n, now)).length);
  }

  findOwn(_tx: TenantTx, id: string, recipientId: string): Promise<Notification | null> {
    return Promise.resolve(this.own(recipientId).find((n) => n.id === id) ?? null);
  }

  markRead(_tx: TenantTx, id: string, recipientId: string, now: Date): Promise<void> {
    const found = this.own(recipientId).find((n) => n.id === id && n.readAt === null);
    if (found) this.rows.set(id, { ...found, readAt: now });
    return Promise.resolve();
  }

  markAllRead(_tx: TenantTx, recipientId: string, now: Date): Promise<number> {
    const unread = this.own(recipientId).filter((n) => isUnread(n, now));
    for (const n of unread) this.rows.set(n.id, { ...n, readAt: now });
    return Promise.resolve(unread.length);
  }

  archive(_tx: TenantTx, id: string, recipientId: string, now: Date): Promise<void> {
    const found = this.own(recipientId).find((n) => n.id === id && n.archivedAt === null);
    if (found) this.rows.set(id, { ...found, archivedAt: now });
    return Promise.resolve();
  }
}

@Injectable()
export class InMemoryNotificationTransactions implements NotificationTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

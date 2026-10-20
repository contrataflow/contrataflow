import { isNotificationType } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import type {
  NotificationListFilter,
  NotificationRepository,
  NotificationTransactions,
} from '../application/notification-ports.js';
import type { Notification } from '../domain/notification.js';

type Row = Prisma.NotificationGetPayload<object>;

function toDomain(row: Row): Notification {
  // `type` é varchar validado pelo dispatcher; um valor fora do registro é erro de programação.
  if (!isNotificationType(row.type))
    throw new Error(`notifications: tipo ${row.type} fora do registro`);
  return {
    id: row.id,
    tenantId: row.tenantId,
    recipientId: row.recipientId,
    type: row.type,
    priority: row.priority,
    title: row.title,
    body: row.body,
    link: row.link,
    processId: row.processId,
    entityType: row.entityType,
    entityId: row.entityId,
    sourceEventId: row.sourceEventId,
    groupKey: row.groupKey,
    groupCount: row.groupCount,
    groupedEventIds: row.groupedEventIds,
    emailStatus: row.emailStatus,
    emailSentAt: row.emailSentAt,
    readAt: row.readAt,
    archivedAt: row.archivedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** Listadas (RN-NTF-09): não arquivadas e não vencidas. */
function listed(recipientId: string, now: Date): Prisma.NotificationWhereInput {
  return {
    recipientId,
    archivedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/**
 * `notifications` no PostgreSQL (US-111): no `tx` do caso de uso, sob a RLS do tenant e a extensão
 * de isolamento (que injeta o `tenantId`). A API só tem `UPDATE (read_at, archived_at)` — GRANT por
 * coluna da migração.
 */
@Injectable()
export class PrismaNotificationRepository implements NotificationRepository {
  async list(tx: TenantTx, filter: NotificationListFilter): Promise<Notification[]> {
    const { after } = filter;
    const rows = await tx.notification.findMany({
      where: {
        AND: [
          listed(filter.recipientId, filter.now),
          filter.unreadOnly ? { readAt: null } : {},
          after === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.take,
    });
    return rows.map(toDomain);
  }

  countUnread(tx: TenantTx, recipientId: string, now: Date): Promise<number> {
    return tx.notification.count({ where: { ...listed(recipientId, now), readAt: null } });
  }

  async findOwn(tx: TenantTx, id: string, recipientId: string): Promise<Notification | null> {
    const row = await tx.notification.findFirst({ where: { id, recipientId } });
    return row ? toDomain(row) : null;
  }

  async markRead(tx: TenantTx, id: string, recipientId: string, now: Date): Promise<void> {
    await tx.notification.updateMany({
      where: { id, recipientId, readAt: null },
      data: { readAt: now },
    });
  }

  async markAllRead(tx: TenantTx, recipientId: string, now: Date): Promise<number> {
    const { count } = await tx.notification.updateMany({
      where: { ...listed(recipientId, now), readAt: null },
      data: { readAt: now },
    });
    return count;
  }

  async archive(tx: TenantTx, id: string, recipientId: string, now: Date): Promise<void> {
    await tx.notification.updateMany({
      where: { id, recipientId, archivedAt: null },
      data: { archivedAt: now },
    });
  }
}

@Injectable()
export class PrismaNotificationTransactions implements NotificationTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

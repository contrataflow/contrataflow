import { uuidv7 } from '@contrataflow/observability';
import { decideNotificationGrouping } from '@contrataflow/types';
import type {
  EmailDeliveryStatus,
  NotificationPriority,
  NotificationType,
} from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { NotificationContent } from './notification-templates.js';

/** Notificação de UM destinatário a gravar para um evento (`Notification.upsertGrouped`). */
export interface NotificationWrite {
  readonly tenantId: string;
  readonly recipientId: string;
  readonly type: NotificationType;
  readonly priority: NotificationPriority;
  readonly link: string | null;
  readonly processId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly sourceEventId: string;
  readonly groupKey: string | null;
  /** Título e corpo para o total de eventos agregados. */
  readonly content: (groupCount: number) => NotificationContent;
  /** `emailStatus` de uma notificação NOVA (a agrupada mantém o seu — RN-NTF-04/05). */
  readonly emailStatus: EmailDeliveryStatus;
  /** Preferência in-app desligada (US-113): grava arquivada, sem agrupar com notificações visíveis. */
  readonly hiddenInApp: boolean;
  readonly now: Date;
}

export interface NotificationWriteOutcome {
  readonly notificationId: string;
  /** `inserted` (linha nova), `grouped` (agregada a uma recente) ou `duplicate` (reentrega). */
  readonly kind: 'inserted' | 'grouped' | 'duplicate';
  /** Estado atual do e-mail — `PENDING` é (re)enfileirado após o commit (padrão B). */
  readonly emailStatus: EmailDeliveryStatus;
}

interface CandidateRow {
  readonly id: string;
  readonly source_event_id: string;
  readonly grouped_event_ids: string[];
  readonly created_at: Date;
  readonly archived_at: Date | null;
  readonly email_status: EmailDeliveryStatus;
}

/**
 * Gravação idempotente e agrupada (RN-NTF-03/04 · Impacto técnico da US-111), na transação do job:
 * 1. trava consultiva de transação por `(tenant, destinatário, groupKey)` — dois eventos quase
 *    simultâneos do mesmo grupo se enfileiram em vez de criar duas linhas (a candidata pode ainda
 *    não existir, então `FOR UPDATE` sozinho não basta);
 * 2. reentrega: o evento já consta como `sourceEventId` ou em `groupedEventIds` → nada muda;
 * 3. candidata (`FOR UPDATE`) criada há menos de 5 min, não arquivada e com espaço → agrega;
 * 4. senão, `INSERT … ON CONFLICT (tenant_id, recipient_id, source_event_id, type) DO NOTHING`.
 */
export class NotificationStore {
  async upsertGrouped(
    client: SqlClient,
    write: NotificationWrite,
  ): Promise<NotificationWriteOutcome> {
    const groupable = write.groupKey !== null && !write.hiddenInApp;
    if (groupable) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `notifications:${write.tenantId}:${write.recipientId}:${write.groupKey}`,
      ]);
    }
    const existing = await this.findDelivered(client, write);
    if (existing) return existing;

    if (groupable) {
      const { rows } = await client.query<CandidateRow>(
        `SELECT id, source_event_id, grouped_event_ids, created_at, archived_at, email_status
           FROM notifications
          WHERE recipient_id = $1 AND group_key = $2 AND archived_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [write.recipientId, write.groupKey],
      );
      const candidate = rows[0] ?? null;
      const decision = decideNotificationGrouping(
        candidate && {
          id: candidate.id,
          sourceEventId: candidate.source_event_id,
          groupedEventIds: candidate.grouped_event_ids,
          createdAt: candidate.created_at,
          archivedAt: candidate.archived_at,
        },
        write.sourceEventId,
        write.now,
      );
      if (decision.kind === 'duplicate' && candidate) {
        return {
          notificationId: candidate.id,
          kind: 'duplicate',
          emailStatus: candidate.email_status,
        };
      }
      if (decision.kind === 'group' && candidate) {
        const groupCount = candidate.grouped_event_ids.length + 2;
        const content = write.content(groupCount);
        await client.query(
          `UPDATE notifications
              SET group_count = group_count + 1,
                  grouped_event_ids = array_append(grouped_event_ids, $2::uuid),
                  title = $3, body = $4, link = $5, read_at = NULL
            WHERE id = $1`,
          [candidate.id, write.sourceEventId, content.title, content.body, write.link],
        );
        return {
          notificationId: candidate.id,
          kind: 'grouped',
          emailStatus: candidate.email_status,
        };
      }
    }
    return this.insert(client, write);
  }

  private async findDelivered(
    client: SqlClient,
    write: NotificationWrite,
  ): Promise<NotificationWriteOutcome | null> {
    const { rows } = await client.query<{ id: string; email_status: EmailDeliveryStatus }>(
      `SELECT id, email_status
         FROM notifications
        WHERE recipient_id = $1 AND type = $2
          AND (source_event_id = $3 OR grouped_event_ids @> ARRAY[$3]::uuid[])
        LIMIT 1`,
      [write.recipientId, write.type, write.sourceEventId],
    );
    const row = rows[0];
    return row
      ? { notificationId: row.id, kind: 'duplicate', emailStatus: row.email_status }
      : null;
  }

  private async insert(
    client: SqlClient,
    write: NotificationWrite,
  ): Promise<NotificationWriteOutcome> {
    const content = write.content(1);
    const { rows } = await client.query<{ id: string; email_status: EmailDeliveryStatus }>(
      `INSERT INTO notifications
         (id, tenant_id, recipient_id, type, priority, title, body, link, process_id, entity_type,
          entity_id, source_event_id, group_key, email_status, created_at, archived_at)
       VALUES ($1, $2, $3, $4, $5::notification_priority, $6, $7, $8, $9, $10, $11, $12, $13,
               $14::email_delivery_status, $15, $16)
       ON CONFLICT (tenant_id, recipient_id, source_event_id, type) DO NOTHING
       RETURNING id, email_status`,
      [
        uuidv7(),
        write.tenantId,
        write.recipientId,
        write.type,
        write.priority,
        content.title,
        content.body,
        write.link,
        write.processId,
        write.entityType,
        write.entityId,
        write.sourceEventId,
        write.groupKey,
        write.emailStatus,
        write.now,
        write.hiddenInApp ? write.now : null,
      ],
    );
    const inserted = rows[0];
    if (inserted) {
      return { notificationId: inserted.id, kind: 'inserted', emailStatus: inserted.email_status };
    }
    // Corrida com outra entrega do mesmo evento: a outra linha venceu (RN-NTF-03).
    const existing = await this.findDelivered(client, write);
    if (!existing) throw new Error('notifications: conflito sem linha existente');
    return existing;
  }
}

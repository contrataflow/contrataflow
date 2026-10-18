import type { DomainEventEnvelope } from '@contrataflow/types';
import type { Logger } from '@nestjs/common';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { NotificationWriteOutcome } from './notification-store.js';

type Payload = Readonly<Record<string, unknown>>;

/**
 * Efeito do despacho no módulo dono do evento (porta do dispatcher): roda na MESMA transação das
 * notificações, depois de gravar ao menos uma nova (reentrega não repete), e registra o log depois
 * do commit.
 */
export interface NotificationEffect {
  readonly eventType: string;
  apply(client: SqlClient, envelope: DomainEventEnvelope<Payload>, now: Date): Promise<void>;
  committed?(
    logger: Logger,
    envelope: DomainEventEnvelope<Payload>,
    written: readonly NotificationWriteOutcome[],
    durationMs: number,
  ): void;
}

const mentionIdOf = (envelope: DomainEventEnvelope<Payload>): string | null =>
  typeof envelope.payload.mentionId === 'string' ? envelope.payload.mentionId : null;

/**
 * US-072 (`Mention.notifiedAt`): marca a menção como notificada quando `MENTIONED` sai para ao
 * menos um destinatário (GRANT só de `UPDATE (notified_at)` ao `cf_worker`) e registra
 * `mention.notification_sent` — só ids, tipo e canais, nunca nome ou e-mail.
 */
export class MentionNotifiedEffect implements NotificationEffect {
  readonly eventType = 'UserMentioned';

  async apply(client: SqlClient, envelope: DomainEventEnvelope<Payload>, now: Date): Promise<void> {
    const mentionId = mentionIdOf(envelope);
    if (mentionId === null) return;
    await client.query(
      'UPDATE mentions SET notified_at = $2 WHERE id = $1 AND notified_at IS NULL',
      [mentionId, now],
    );
  }

  committed(
    logger: Logger,
    envelope: DomainEventEnvelope<Payload>,
    written: readonly NotificationWriteOutcome[],
    durationMs: number,
  ): void {
    const fresh = written.filter((item) => item.kind !== 'duplicate');
    if (fresh.length === 0) return;
    logger.log({
      event: 'mention.notification_sent',
      mentionId: mentionIdOf(envelope),
      notificationType: 'MENTIONED',
      channels: fresh.some((item) => item.emailStatus === 'PENDING')
        ? ['IN_APP', 'EMAIL']
        : ['IN_APP'],
      recipientCount: fresh.length,
      durationMs,
      correlationId: envelope.correlationId,
    });
  }
}

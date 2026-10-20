import { OUTBOX_NOTIFY_CHANNEL } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { OutboxRow, OutboxStore } from '../../application/outbox-ports.js';

/**
 * `outbox_events` no PostgreSQL (US-082): INSERT parametrizado no `tx` do caso de uso, com a RLS
 * do tenant (`WITH CHECK`), `occurred_at = clock_timestamp()` e `pg_notify` — o NOTIFY só é
 * entregue ao relay se a transação fizer commit (ADR-004).
 */
@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  async insert(tx: TenantTx, row: OutboxRow): Promise<Date> {
    const inserted = await tx.$queryRaw<{ occurred_at: Date }[]>`
      INSERT INTO outbox_events (
        id, tenant_id, event_type, routing_key, event_version, aggregate_type, aggregate_id,
        process_id, payload, metadata, occurred_at
      ) VALUES (
        ${row.id}::uuid, ${row.tenantId}::uuid, ${row.eventType}, ${row.routingKey},
        ${row.eventVersion}, ${row.aggregateType}, ${row.aggregateId}::uuid,
        ${row.processId}::uuid, ${JSON.stringify(row.payload)}::jsonb,
        ${JSON.stringify(row.metadata)}::jsonb, clock_timestamp()
      )
      RETURNING occurred_at`;
    await tx.$executeRaw`SELECT pg_notify(${OUTBOX_NOTIFY_CHANNEL}, '')`;
    const occurredAt = inserted[0]?.occurred_at;
    if (!occurredAt) throw new Error('INSERT em outbox_events sem linha devolvida.');
    return occurredAt;
  }

  async insertOnce(tx: TenantTx, row: OutboxRow): Promise<Date | null> {
    const inserted = await tx.$queryRaw<{ occurred_at: Date }[]>`
      INSERT INTO outbox_events (
        id, tenant_id, event_type, routing_key, event_version, aggregate_type, aggregate_id,
        process_id, payload, metadata, occurred_at
      ) VALUES (
        ${row.id}::uuid, ${row.tenantId}::uuid, ${row.eventType}, ${row.routingKey},
        ${row.eventVersion}, ${row.aggregateType}, ${row.aggregateId}::uuid,
        ${row.processId}::uuid, ${JSON.stringify(row.payload)}::jsonb,
        ${JSON.stringify(row.metadata)}::jsonb, clock_timestamp()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING occurred_at`;
    const occurredAt = inserted[0]?.occurred_at ?? null;
    if (occurredAt !== null) await tx.$executeRaw`SELECT pg_notify(${OUTBOX_NOTIFY_CHANNEL}, '')`;
    return occurredAt;
  }
}

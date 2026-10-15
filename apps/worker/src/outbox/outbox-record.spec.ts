import { describe, expect, it } from 'vitest';

import { purgePublishedOutboxEvents } from './outbox-purge.js';
import { toPublishableEvent } from './outbox-record.js';
import type { OutboxRecord } from './outbox-record.js';
import { OutboxRepository } from './outbox.repository.js';
import { MemoryOutboxDatabase } from './testing.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const USER = '0192f000-0000-7000-8000-0000000000a1';
const EVENT = '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293';
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const record: OutboxRecord = {
  id: EVENT,
  tenant_id: TENANT,
  event_type: 'ProcessStageChanged',
  routing_key: 'process.stage_changed.forward',
  event_version: 1,
  aggregate_type: 'Process',
  aggregate_id: USER,
  process_id: USER,
  payload: { cause: 'FORWARD' },
  metadata: {
    actor: { type: 'USER', userId: USER, membershipId: null },
    correlationId: 'corr-1',
    causationId: null,
    traceparent: TRACEPARENT,
    tracestate: 'cf=1',
  },
  occurred_at: new Date('2026-10-15T12:00:00.000Z'),
  attempts: 0,
};

describe('toPublishableEvent (DEC-160 · DEC-164)', () => {
  it('monta envelope e JobMeta; o trace fica no meta, nunca no envelope', () => {
    const check = toPublishableEvent(record, new Date('2026-10-15T12:00:01.000Z'));
    expect(check).toEqual({
      ok: true,
      event: {
        jobId: EVENT,
        eventType: 'ProcessStageChanged',
        occurredAt: record.occurred_at,
        data: {
          meta: {
            schemaVersion: 1,
            tenantId: TENANT,
            actor: { type: 'USER', userId: USER, membershipId: null },
            correlationId: 'corr-1',
            causationId: null,
            traceparent: TRACEPARENT,
            tracestate: 'cf=1',
            enqueuedAt: '2026-10-15T12:00:01.000Z',
          },
          payload: {
            envelope: {
              eventId: EVENT,
              eventType: 'ProcessStageChanged',
              routingKey: 'process.stage_changed.forward',
              eventVersion: 1,
              occurredAt: '2026-10-15T12:00:00.000Z',
              tenantId: TENANT,
              aggregateType: 'Process',
              aggregateId: USER,
              processId: USER,
              actor: { type: 'USER', userId: USER, membershipId: null },
              correlationId: 'corr-1',
              causationId: null,
              payload: { cause: 'FORWARD' },
            },
          },
        },
      },
    });
  });

  it('sem trace no metadata, o meta não ganha traceparent', () => {
    const check = toPublishableEvent(
      {
        ...record,
        metadata: {
          actor: { type: 'SYSTEM', userId: null, membershipId: null },
          correlationId: 'c',
          causationId: null,
        },
      },
      new Date(),
    );
    expect(check.ok && 'traceparent' in check.event.data.meta).toBe(false);
  });

  it.each([
    ['metadata sem ator', { metadata: { correlationId: 'c', causationId: null } }, /metadata/],
    ['eventId que não é UUIDv7', { id: '0192f000-0000-4000-8000-000000000001' }, /eventId/],
    ['payload que não é objeto', { payload: [1, 2] }, /payload/],
  ])('recusa %s com motivo sem valores', (_name, patch, reason) => {
    const check = toPublishableEvent({ ...record, ...patch }, new Date());
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(reason);
  });
});

describe('purgePublishedOutboxEvents (DEC-085)', () => {
  it('apaga em lotes até esgotar, com corte em 7 dias', async () => {
    const db = new MemoryOutboxDatabase();
    const cutoffs: Date[] = [];
    const batches = [3, 3, 1];
    const repository = new (class extends OutboxRepository {
      override purgePublishedBatch(_client: unknown, before: Date, limit: number): Promise<number> {
        cutoffs.push(before);
        expect(limit).toBe(3);
        return Promise.resolve(batches.shift() ?? 0);
      }
    })();
    const now = new Date('2026-10-15T00:00:00.000Z');
    const total = await purgePublishedOutboxEvents(db, {
      repository,
      batchSize: 3,
      now: () => now,
    });
    expect(total).toBe(7);
    expect(cutoffs).toHaveLength(3);
    expect(cutoffs[0]?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });
});

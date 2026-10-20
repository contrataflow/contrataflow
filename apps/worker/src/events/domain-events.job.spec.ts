import type { JobMeta } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { DomainEventsJobHandler } from './domain-events.job.js';
import { DomainEventsProcessor } from './domain-events.processor.js';
import type { FanOutJob } from './domain-events.processor.js';
import type { JobHandlerContext } from '../queues/run-job.js';

const EVENT = '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293';
const TENANT = '0192f000-0000-7000-8000-00000000000a';

function envelope(tenantId: string | null) {
  return {
    eventId: EVENT,
    eventType: 'DocumentTypeChanged',
    routingKey: 'document_type.changed',
    eventVersion: 1,
    occurredAt: '2026-10-15T12:00:00.000Z',
    tenantId,
    aggregateType: 'DocumentType',
    aggregateId: EVENT,
    processId: null,
    actor: { type: 'SYSTEM' as const, userId: null, membershipId: null },
    correlationId: 'corr-1',
    causationId: null,
    payload: {},
  };
}

const meta: JobMeta = {
  schemaVersion: 1,
  tenantId: TENANT,
  actor: { type: 'SYSTEM', userId: null, membershipId: null },
  correlationId: 'corr-1',
  causationId: null,
  enqueuedAt: '2026-10-15T12:00:01.000Z',
};

describe('DomainEventsJobHandler (domain-events pelo runJob)', () => {
  it('delega ao processor com o meta do contexto e o jobId', async () => {
    const added: FanOutJob[] = [];
    const handler = new DomainEventsJobHandler(
      new DomainEventsProcessor({
        queues: {
          add: (_queue, child) => {
            added.push(child);
            return Promise.resolve();
          },
        },
        handlers: [],
        routes: { queues: [{ match: ['document_type.*'], queue: 'notifications' }], inline: [] },
      }),
    );
    const payload = handler.payloadSchema.parse({ envelope: envelope(TENANT) });
    await expect(
      handler.handle(payload, { meta, jobId: EVENT } as unknown as JobHandlerContext),
    ).resolves.toBe('completed');
    expect(added.map((child) => child.jobId)).toEqual([EVENT]);
    expect(handler.ignoresTenantStatus).toBe(true);
  });

  it('só evento de plataforma (tenantId nulo no envelope) dispensa tenant no meta', () => {
    const handler = new DomainEventsJobHandler(
      new DomainEventsProcessor({ queues: { add: () => Promise.resolve() }, handlers: [] }),
    );
    expect(
      handler.acceptsPlatformContext(handler.payloadSchema.parse({ envelope: envelope(null) })),
    ).toBe(true);
    expect(
      handler.acceptsPlatformContext(handler.payloadSchema.parse({ envelope: envelope(TENANT) })),
    ).toBe(false);
  });
});

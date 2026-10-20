import type { DomainEventEnvelope } from '@contrataflow/types';
import { describe, expect, it, vi } from 'vitest';

import { DomainEventsProcessor } from './domain-events.processor.js';
import type { FanOutQueues } from './domain-events.processor.js';
import { InvitationEmailEnqueuer } from './inline-handlers.js';
import { DOMAIN_EVENT_ROUTES, resolveRoutes } from './routes.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const USER = '0192f000-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0192f000-0000-7000-8000-0000000000c1';
const EVENT = '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293';

const payload = {
  membershipId: MEMBERSHIP,
  userId: USER,
  type: 'INTERNAL',
  inviteExpiresAt: '2026-10-22T12:00:00.000Z',
  resend: false,
};

function envelope(
  overrides: Partial<DomainEventEnvelope<Record<string, unknown>>> = {},
): DomainEventEnvelope<Record<string, unknown>> {
  return {
    eventId: EVENT,
    eventType: 'UserInvited',
    routingKey: 'membership.invited',
    eventVersion: 1,
    occurredAt: '2026-10-15T12:00:00.000Z',
    tenantId: TENANT,
    aggregateType: 'TenantMembership',
    aggregateId: MEMBERSHIP,
    processId: null,
    actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
    correlationId: 'corr-1',
    causationId: null,
    payload,
    ...overrides,
  };
}

describe('InvitationEmailEnqueuer (US-091)', () => {
  it('enfileira email/send com a referência do vínculo e jobId = eventId (sem ":")', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await new InvitationEmailEnqueuer({ enqueue }).handle(envelope());
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      'email',
      'send',
      { kind: 'INVITATION', membershipId: MEMBERSHIP },
      { jobId: EVENT },
    );
    expect(EVENT).not.toContain(':');
  });

  it('o reenvio (resend = true) enfileira do mesmo jeito, com o jobId do novo evento', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const resendEvent = '0192f3a0-5c1e-7a2b-9c3d-4e5f60718294';
    await new InvitationEmailEnqueuer({ enqueue }).handle(
      envelope({ eventId: resendEvent, payload: { ...payload, resend: true } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      'email',
      'send',
      { kind: 'INVITATION', membershipId: MEMBERSHIP },
      { jobId: resendEvent },
    );
  });

  it('ignora evento sem tenant e payload fora do contrato (sem enfileirar, sem lançar)', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = new InvitationEmailEnqueuer({ enqueue });
    await handler.handle(envelope({ tenantId: null }));
    await handler.handle(envelope({ payload: { ...payload, membershipId: 'não-uuid' } }));
    await handler.handle(envelope({ payload: {} }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('falha ao enfileirar propaga (o job do domain-events é repetido pela fila)', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('redis fora'));
    await expect(new InvitationEmailEnqueuer({ enqueue }).handle(envelope())).rejects.toThrow(
      'redis fora',
    );
  });

  it('[Duplicidade] a rota casa membership.invited e o processor reentrega com o mesmo jobId', async () => {
    expect(resolveRoutes('membership.invited').inline).toEqual(
      expect.arrayContaining(['InvitationEmailEnqueuer', 'PermissionCacheInvalidator']),
    );
    expect(resolveRoutes('membership.activated').inline).not.toContain('InvitationEmailEnqueuer');
    expect(DOMAIN_EVENT_ROUTES.inline.some((r) => r.handler === 'InvitationEmailEnqueuer')).toBe(
      true,
    );

    const jobIds = new Set<string>();
    const enqueue = vi.fn(
      (_queue: string, _name: string, _payload: unknown, o?: { jobId?: string }) => {
        // dedup do BullMQ: o mesmo jobId não cria segundo job
        if (o?.jobId) jobIds.add(o.jobId);
        return Promise.resolve();
      },
    );
    const queues: FanOutQueues = { add: () => Promise.resolve() };
    const processor = new DomainEventsProcessor({
      queues,
      handlers: [new InvitationEmailEnqueuer({ enqueue })],
      routes: {
        queues: [],
        inline: [{ match: ['membership.invited'], handler: 'InvitationEmailEnqueuer' }],
      },
    });
    const data = {
      meta: {
        schemaVersion: 1,
        tenantId: TENANT,
        actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
        correlationId: 'corr-1',
        causationId: null,
        enqueuedAt: '2026-10-15T12:00:01.000Z',
      },
      payload: { envelope: envelope() },
    };
    await processor.process(data, EVENT);
    await processor.process(data, EVENT);
    expect(jobIds).toEqual(new Set([EVENT]));
  });
});

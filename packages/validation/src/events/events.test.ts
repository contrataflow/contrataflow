import { DOMAIN_EVENT_NAMES, MAX_EVENT_PAYLOAD_BYTES } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DOMAIN_EVENT_DEFINITIONS,
  DomainEventContractError,
  defineDomainEvent,
  domainEventEnvelopeSchema,
  domainEventJobSchema,
  eventPayloadBytes,
  matchesAnyRoutingKey,
  matchesRoutingKey,
} from './index.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const AGGREGATE = '0192f000-0000-7000-8000-0000000000b1';

const envelope = {
  eventId: '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293',
  eventType: 'ProcessStageChanged',
  routingKey: 'process.stage_changed.forward',
  eventVersion: 1,
  occurredAt: '2026-10-15T12:00:00.000Z',
  tenantId: TENANT,
  aggregateType: 'Process',
  aggregateId: AGGREGATE,
  processId: AGGREGATE,
  actor: { type: 'USER', userId: AGGREGATE, membershipId: null },
  correlationId: 'corr-1',
  causationId: null,
  payload: { cause: 'FORWARD' },
} as const;

/** Evento de teste com routing key especializada pelo payload (DEC-162). */
const DocumentCreated = defineDomainEvent({
  eventType: 'DocumentCreated',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({ documentTypeCode: z.enum(['DFD', 'ETP']), documentId: z.uuid() }),
  routingKey: (payload) => `document.created.${payload.documentTypeCode.toLowerCase()}`,
});

describe('envelope de evento (DEC-160)', () => {
  it('aceita o envelope completo e tipado', () => {
    expect(domainEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it.each([
    ['eventId que não é UUIDv7', { eventId: '0192f000-0000-4000-8000-000000000001' }],
    ['eventType fora de PascalCase', { eventType: 'process_created' }],
    ['routing key sem fato', { routingKey: 'process' }],
    ['versão zero', { eventVersion: 0 }],
    ['data sem fuso', { occurredAt: '2026-10-15 12:00' }],
    ['ator desconhecido', { actor: { type: 'ANONYMOUS', userId: null, membershipId: null } }],
    ['payload que não é objeto', { payload: 'x' }],
    ['campo extra', { extra: 1 }],
  ])('recusa %s', (_name, patch) => {
    expect(domainEventEnvelopeSchema.safeParse({ ...envelope, ...patch }).success).toBe(false);
  });

  it('recusa campo obrigatório ausente', () => {
    const { correlationId: _omit, ...partial } = envelope;
    expect(domainEventEnvelopeSchema.safeParse(partial).success).toBe(false);
  });

  it('mede o payload serializado em bytes UTF-8', () => {
    expect(eventPayloadBytes({ a: 'ç' })).toBe(Buffer.byteLength('{"a":"ç"}'));
  });
});

describe('defineDomainEvent', () => {
  it('monta o rascunho e resolve a routing key especializada do mesmo evento genérico', () => {
    const draft = DocumentCreated.of({
      aggregateId: AGGREGATE,
      processId: null,
      payload: { documentTypeCode: 'DFD', documentId: AGGREGATE },
    });
    expect(draft).toMatchObject({ aggregateId: AGGREGATE, processId: null, causationId: null });
    expect(draft.definition.resolve(draft.payload)).toEqual({
      eventType: 'DocumentCreated',
      eventVersion: 1,
      aggregateType: 'Document',
      routingKey: 'document.created.dfd',
      payload: { documentTypeCode: 'DFD', documentId: AGGREGATE },
    });
    expect(
      DocumentCreated.resolve({ documentTypeCode: 'ETP', documentId: AGGREGATE }).routingKey,
    ).toBe('document.created.etp');
  });

  it('recusa payload com campo obrigatório ausente, sem expor valores', () => {
    const error = (() => {
      try {
        DocumentCreated.resolve({ documentTypeCode: 'DFD' });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(DomainEventContractError);
    expect((error as DomainEventContractError).issues).toEqual(['documentId: invalid_type']);
  });

  it('recusa payload acima de 16 KB', () => {
    const Big = defineDomainEvent({
      eventType: 'BigHappened',
      eventVersion: 1,
      aggregateType: 'Process',
      payload: z.strictObject({ blob: z.string() }),
      routingKey: 'process.big',
    });
    expect(() => Big.resolve({ blob: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) })).toThrow(/16 KB/);
    expect(Big.resolve({ blob: 'x' }).routingKey).toBe('process.big');
  });

  it('recusa routing key calculada inválida', () => {
    const Bad = defineDomainEvent({
      eventType: 'BadHappened',
      eventVersion: 1,
      aggregateType: 'Process',
      payload: z.strictObject({ kind: z.string() }),
      routingKey: (payload) => payload.kind,
    });
    expect(() => Bad.resolve({ kind: 'Não Pode' })).toThrow(/routingKey/);
  });

  it('recusa definição com nome, agregado, versão ou routing key fora da convenção', () => {
    const base = {
      eventType: 'ProcessCreated',
      eventVersion: 1,
      aggregateType: 'Process',
      payload: z.strictObject({}),
      routingKey: 'process.created',
    };
    expect(() => defineDomainEvent({ ...base, eventType: 'process_created' })).toThrow();
    expect(() => defineDomainEvent({ ...base, aggregateType: 'process' })).toThrow();
    expect(() => defineDomainEvent({ ...base, eventVersion: 0 })).toThrow(DomainEventContractError);
    expect(() => defineDomainEvent({ ...base, routingKey: 'Process.Created' })).toThrow();
  });
});

describe('registro de eventos (V-03)', () => {
  it('toda definição tem nome registrado em @contrataflow/types e vice-versa', () => {
    expect(Object.keys(DOMAIN_EVENT_DEFINITIONS).sort()).toEqual([...DOMAIN_EVENT_NAMES].sort());
    for (const [name, definition] of Object.entries(DOMAIN_EVENT_DEFINITIONS)) {
      expect(definition.eventType).toBe(name);
    }
  });
});

describe('padrões de routing key (queues.md §7.1)', () => {
  it.each([
    ['process.*', 'process.created', true],
    ['process.*', 'process.stage_changed.forward', true],
    ['process.*', 'process', false],
    ['process.stage_changed.*', 'process.stage_changed.forward', true],
    ['process.stage_changed.*', 'process.stage_changed', false],
    ['document.*.dfd', 'document.created.dfd', true],
    ['document.*.dfd', 'document.created.etp', false],
    ['document.*.dfd', 'document.created.dfd.extra', false],
    ['process.assigned', 'process.assigned', true],
    ['process.assigned', 'process.assigned.x', false],
    ['role.*', 'membership.suspended', false],
  ])('%s × %s → %s', (pattern, key, expected) => {
    expect(matchesRoutingKey(pattern, key)).toBe(expected);
  });

  it('casa se algum padrão casar', () => {
    expect(matchesAnyRoutingKey(['role.*', 'department.moved'], 'department.moved')).toBe(true);
    expect(matchesAnyRoutingKey([], 'department.moved')).toBe(false);
  });
});

describe('job de domain-events (DEC-164)', () => {
  it('valida meta e envelope', () => {
    const job = {
      meta: {
        schemaVersion: 1,
        tenantId: TENANT,
        actor: envelope.actor,
        correlationId: 'corr-1',
        causationId: null,
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        enqueuedAt: '2026-10-15T12:00:01.000Z',
      },
      payload: { envelope },
    };
    expect(domainEventJobSchema.parse(job)).toEqual(job);
    expect(
      domainEventJobSchema.safeParse({ ...job, meta: { ...job.meta, schemaVersion: 2 } }).success,
    ).toBe(false);
  });
});

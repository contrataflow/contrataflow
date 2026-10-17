import { defineDomainEvent } from '@contrataflow/validation';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { RequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';
import {
  OUTBOX_WRITER,
  SYNC_EVENT_HANDLERS,
  SyncEventHandlerNotAllowedError,
} from '#shared/outbox/outbox-writer.js';
import type { RecordedDomainEvent, SyncEventHandler } from '#shared/outbox/outbox-writer.js';

import { OUTBOX_STORE, OutboxContractError } from './outbox-ports.js';
import { OutboxWriterService } from './outbox-writer.service.js';
import { SyncEventHandlerRegistry } from './sync-event-handler.registry.js';
import { testConfig } from '../../../../test/support/api-test-app.js';
import { AppModule } from '../../../app.module.js';
import { InMemoryOutboxStore } from '../infrastructure/outbox/in-memory-outbox.store.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const USER = '0192f000-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0192f000-0000-7000-8000-0000000000c1';
const PROCESS = '0192f000-0000-7000-8000-0000000000e1';
const RECORDED_AT = new Date('2026-10-15T12:00:00.123Z');

/** Fato de teste com routing key especializada pelo payload (DEC-162). */
const ProbeStageChanged = defineDomainEvent({
  eventType: 'ProbeStageChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({ cause: z.enum(['FORWARD', 'RETURN']), stageId: z.uuid() }),
  routingKey: (payload) => `probe.stage_changed.${payload.cause.toLowerCase()}`,
});

const validEvent = () =>
  ProbeStageChanged.of({
    aggregateId: PROCESS,
    processId: PROCESS,
    payload: { cause: 'FORWARD', stageId: MEMBERSHIP },
  });

function setup() {
  const store = new InMemoryOutboxStore(() => RECORDED_AT);
  const registry = new SyncEventHandlerRegistry();
  const writer = new OutboxWriterService(store, registry);
  return { store, registry, writer };
}

type ContextPatch = Partial<Pick<RequestContext, 'tenantId' | 'actor'>>;

/** Executa como uma requisição autenticada no tenant (o que os guards fazem). */
function asUser<T>(fn: () => Promise<T>, patch: ContextPatch = {}): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'corr-outbox', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId: TENANT,
        actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
        ...patch,
      });
      return fn();
    },
  );
}

function handler(
  name: string,
  routingKeys: string[],
): SyncEventHandler & { seen: RecordedDomainEvent[] } {
  const seen: RecordedDomainEvent[] = [];
  return {
    name: name as SyncEventHandler['name'],
    routingKeys,
    seen,
    handle: (_tx: TenantTx, event: RecordedDomainEvent) => {
      seen.push(event);
      return Promise.resolve();
    },
  };
}

describe('OutboxWriter (US-082)', () => {
  it('[Sucesso] grava o envelope DEC-160 do contexto e roda os handlers síncronos no mesmo tx', async () => {
    const { store, registry, writer } = setup();
    const timeline = handler('TimelineProjector', ['probe.*']);
    const access = handler('ProcessAccessProjector', ['other.*']);
    registry.register(timeline);
    registry.register(access);

    const recorded = await asUser(() =>
      runSimulatedTransaction((tx) => writer.record(tx, validEvent())),
    );

    expect(recorded.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(recorded).toEqual({
      eventId: recorded.eventId,
      eventType: 'ProbeStageChanged',
      routingKey: 'probe.stage_changed.forward',
      eventVersion: 1,
      occurredAt: RECORDED_AT.toISOString(),
      tenantId: TENANT,
      aggregateType: 'Process',
      aggregateId: PROCESS,
      processId: PROCESS,
      actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
      correlationId: 'corr-outbox',
      causationId: null,
      payload: { cause: 'FORWARD', stageId: MEMBERSHIP },
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      id: recorded.eventId,
      tenantId: TENANT,
      metadata: {
        actor: recorded.actor,
        correlationId: 'corr-outbox',
        causationId: null,
      },
    });
    expect(timeline.seen).toEqual([recorded]);
    expect(access.seen).toEqual([]);
  });

  it('[US-116] recordOnce: id determinístico grava uma vez; repetido não grava nem despacha', async () => {
    const { store, registry, writer } = setup();
    const timeline = handler('TimelineProjector', ['probe.*']);
    registry.register(timeline);
    const fixedId = '0192f000-0000-7000-8000-0000000000f1';

    const [first, second] = await asUser(() =>
      runSimulatedTransaction(async (tx) => [
        await writer.recordOnce(tx, validEvent(), fixedId),
        await writer.recordOnce(tx, validEvent(), fixedId),
      ]),
    );

    expect(first?.eventId).toBe(fixedId);
    expect(second).toBeNull();
    expect(store.rows.map((row) => row.id)).toEqual([fixedId]);
    expect(timeline.seen).toHaveLength(1);
  });

  it('preserva o causationId e aceita ator SYSTEM (job originado por evento)', async () => {
    const { writer } = setup();
    const causation = '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293';
    const recorded = await asUser(
      () =>
        runSimulatedTransaction((tx) =>
          writer.record(
            tx,
            ProbeStageChanged.of({
              aggregateId: PROCESS,
              payload: { cause: 'RETURN', stageId: PROCESS },
              causationId: causation,
            }),
          ),
        ),
      { actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'job' } },
    );
    expect(recorded).toMatchObject({
      routingKey: 'probe.stage_changed.return',
      processId: null,
      causationId: causation,
      actor: { type: 'SYSTEM', userId: null, membershipId: null },
    });
  });

  it('[Validação] payload com campo obrigatório ausente é recusado antes do INSERT', async () => {
    const { store, writer } = setup();
    const event = ProbeStageChanged.of({
      aggregateId: PROCESS,
      payload: { cause: 'FORWARD' } as unknown as { cause: 'FORWARD'; stageId: string },
    });
    const attempt = asUser(() => runSimulatedTransaction((tx) => writer.record(tx, event)));
    await expect(attempt).rejects.toThrow(OutboxContractError);
    await expect(attempt).rejects.toThrow(/V-02: .*stageId: invalid_type/);
    expect(store.rows).toEqual([]);
  });

  it('[Validação] envelope com campo de tipo incorreto é recusado (V-01)', async () => {
    const { store, writer } = setup();
    const event = ProbeStageChanged.of({
      aggregateId: 'não-é-uuid',
      payload: { cause: 'FORWARD', stageId: PROCESS },
    });
    await expect(
      asUser(() => runSimulatedTransaction((tx) => writer.record(tx, event))),
    ).rejects.toThrow(/V-01: envelope de ProbeStageChanged inválido: aggregateId/);
    expect(store.rows).toEqual([]);
  });

  it('propaga erros que não são de contrato da definição do evento', async () => {
    const { writer } = setup();
    const Broken = defineDomainEvent({
      eventType: 'BrokenHappened',
      eventVersion: 1,
      aggregateType: 'Process',
      payload: z.strictObject({}),
      routingKey: () => {
        throw new TypeError('bug');
      },
    });
    await expect(
      asUser(() =>
        runSimulatedTransaction((tx) =>
          writer.record(tx, Broken.of({ aggregateId: PROCESS, payload: {} })),
        ),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('recusa tx que não é o da transação ativa do caso de uso', async () => {
    const { writer } = setup();
    await expect(asUser(() => writer.record({} as TenantTx, validEvent()))).rejects.toThrow(
      /TRANSACTION: OutboxWriter.record exige o tx/,
    );
  });

  it.each<[string, ContextPatch, RegExp]>([
    ['sem tenant no contexto', { tenantId: null }, /exige o tenant/],
    ['com tenant inválido', { tenantId: 'x' }, /exige o tenant/],
    [
      'com ator anônimo',
      { actor: { type: 'ANONYMOUS', userId: null, membershipId: null } },
      /ator autenticado/,
    ],
  ])('recusa evento %s', async (_name, patch, message) => {
    const { writer } = setup();
    await expect(
      asUser(() => runSimulatedTransaction((tx) => writer.record(tx, validEvent())), patch),
    ).rejects.toThrow(message);
  });

  it('erro de handler síncrono propaga (a transação do caso de uso é desfeita)', async () => {
    const { registry, writer } = setup();
    registry.register({
      name: 'TimelineProjector',
      routingKeys: ['probe.*'],
      handle: () => Promise.reject(new Error('projeção falhou')),
    });
    await expect(
      asUser(() => runSimulatedTransaction((tx) => writer.record(tx, validEvent()))),
    ).rejects.toThrow('projeção falhou');
  });
});

describe('SyncEventHandlerRegistry (RN-FND-52)', () => {
  it('só aceita TimelineProjector e ProcessAccessProjector, uma vez cada', () => {
    const registry = new SyncEventHandlerRegistry();
    expect(() => {
      registry.register(handler('NotificationDispatcher', ['process.*']));
    }).toThrow(SyncEventHandlerNotAllowedError);
    registry.register(handler('ProcessAccessProjector', ['process.*']));
    expect(() => {
      registry.register(handler('ProcessAccessProjector', ['process.*']));
    }).toThrow(/já registrado/);
  });

  it('despacha só para os handlers cuja assinatura casa a routing key', async () => {
    const registry = new SyncEventHandlerRegistry();
    const timeline = handler('TimelineProjector', ['process.*', 'document.created.*']);
    const access = handler('ProcessAccessProjector', ['process.stage_changed.*']);
    registry.register(timeline);
    registry.register(access);
    const event = { routingKey: 'document.created.dfd' } as RecordedDomainEvent;
    await registry.dispatch({} as TenantTx, event);
    expect(timeline.seen).toEqual([event]);
    expect(access.seen).toEqual([]);
  });
});

describe('PlatformModule (global)', () => {
  it('expõe OUTBOX_WRITER e SYNC_EVENT_HANDLERS; no modo fake o outbox fica em memória', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(testConfig())],
    }).compile();
    try {
      expect(moduleRef.get(OUTBOX_WRITER)).toBeInstanceOf(OutboxWriterService);
      expect(moduleRef.get(SYNC_EVENT_HANDLERS)).toBeInstanceOf(SyncEventHandlerRegistry);
      expect(moduleRef.get(OUTBOX_STORE)).toBeInstanceOf(InMemoryOutboxStore);
    } finally {
      await moduleRef.close();
    }
  });

  it('com banco configurado usa o store Prisma', async () => {
    const config = testConfig();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...config, oidc: { ...config.oidc, fakeSigningKey: null } })],
    }).compile();
    try {
      expect(moduleRef.get(OUTBOX_STORE)).not.toBeInstanceOf(InMemoryOutboxStore);
    } finally {
      await moduleRef.close();
    }
  }, 20_000);
});

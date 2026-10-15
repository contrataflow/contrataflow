import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runAsSystem,
  runWithRequestContext,
  updateRequestContext,
} from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type {
  RecordedDomainEvent,
  SyncEventHandlerRegistryPort,
} from '#shared/outbox/outbox-writer.js';

import type { AnyTimelineLookupSource, TimelineEntryStore } from './ports.js';
import { TimelineLookupUnavailableError } from './timeline-errors.js';
import { TimelineLookupResolver } from './timeline-lookup.resolver.js';
import { TimelineProjector } from './timeline-projector.js';
import { timelineMetrics } from './timeline-telemetry.js';
import { TimelinePayloadError } from '../domain/timeline-entry.js';
import { InMemoryTimelineEntryStore } from '../infrastructure/in-memory-timeline-entry.store.js';

// O caminho completo pelo `OutboxWriter` (mesmo tx, PostgreSQL real) está em
// test/timeline/timeline-projection.spec.ts; aqui o projetor é chamado como o `OutboxWriter` o
// chama: `handle(tx, envelopeGravado)`.

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const ANA = '0192f000-0000-7000-8000-0000000000a1';
const ANA_MEMBERSHIP = '0192f000-0000-7000-8000-0000000000c1';
const PROCESS = '0192f000-0000-7000-8000-0000000000e1';
const DEPT_MANUT = '0192f000-0000-7000-8000-0000000000d1';
const DEPT_COMPRAS = '0192f000-0000-7000-8000-0000000000d2';
const STAGE_A = '0192f000-0000-7000-8000-0000000000f1';
const STAGE_B = '0192f000-0000-7000-8000-0000000000f2';
const MOVEMENT = '0192f000-0000-7000-8000-0000000000f3';
const tx = {} as TenantTx;

/** Envelope gravado no outbox (DEC-160), com payload de events.md §4.1. */
const recorded = (overrides: Partial<RecordedDomainEvent> = {}): RecordedDomainEvent => ({
  eventId: '0192f000-0000-7000-8000-000000000e01',
  eventType: 'ProcessCreated',
  routingKey: 'process.created',
  eventVersion: 1,
  occurredAt: '2026-10-01T10:00:00.123Z',
  tenantId: TENANT,
  aggregateType: 'Process',
  aggregateId: PROCESS,
  processId: PROCESS,
  actor: { type: 'USER', userId: ANA, membershipId: ANA_MEMBERSHIP },
  correlationId: 'corr-us059',
  causationId: null,
  payload: { code: '0012/2026', title: 'Manutenção predial', requestingDepartmentId: DEPT_MANUT },
  ...overrides,
});

/** Fontes de teste no lugar dos módulos que ainda não existem (organization, process…). */
function sources(): AnyTimelineLookupSource[] {
  const named = (ids: readonly string[], names: Readonly<Record<string, string>>) =>
    Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const name = names[id];
          return name ? [[id, { name }] as const] : [];
        }),
      ),
    );
  return [
    { kind: 'USER', lookup: (_tx, ids) => named(ids, { [ANA]: 'Ana Souza (lida)' }) },
    {
      kind: 'DEPARTMENT',
      lookup: (_tx, ids) =>
        named(ids, { [DEPT_MANUT]: 'Setor de Manutenção', [DEPT_COMPRAS]: 'Compras' }),
    },
    {
      kind: 'PROCESS_STAGE',
      lookup: (_tx, ids) => named(ids, { [STAGE_A]: 'Abertura', [STAGE_B]: 'Análise' }),
    },
  ];
}

function setup(options: { store?: TimelineEntryStore; sources?: AnyTimelineLookupSource[] } = {}) {
  const store = options.store ?? new InMemoryTimelineEntryStore();
  const register = vi.fn<SyncEventHandlerRegistryPort['register']>();
  const registry: SyncEventHandlerRegistryPort = { register };
  const projector = new TimelineProjector(
    registry,
    store,
    new TimelineLookupResolver(options.sources ?? sources()),
  );
  return { store, register, projector };
}

/** Requisição autenticada da Ana (nome exibido carregado pelos guards). */
function asAna<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'corr-us059', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId: TENANT,
        actor: { type: 'USER', userId: ANA, membershipId: ANA_MEMBERSHIP, name: 'Ana Souza' },
      });
      return fn();
    },
  );
}

function rowsOf(store: TimelineEntryStore) {
  return (store as InMemoryTimelineEntryStore).rows;
}

function logs() {
  return {
    log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    debug: vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimelineProjector (US-059)', () => {
  it('registra-se na subida como handler síncrono do outbox (DEC-161)', () => {
    const { register, projector } = setup();
    projector.onModuleInit();
    expect(register).toHaveBeenCalledWith(projector);
    expect(projector.name).toBe('TimelineProjector');
  });

  it('[Sucesso] ProcessCreated vira PROCESS_CREATED com nomes congelados', async () => {
    const spies = logs();
    const projected = vi.spyOn(timelineMetrics().projected, 'add');
    const duration = vi.spyOn(timelineMetrics().duration, 'record');
    const { store, projector } = setup();
    const event = recorded();

    await asAna(() => projector.handle(tx, event));

    expect(rowsOf(store)).toEqual([
      {
        id: expect.any(String) as string,
        tenantId: TENANT,
        processId: PROCESS,
        // Instante do fato (o do evento), não o da gravação.
        occurredAt: new Date('2026-10-01T10:00:00.123Z'),
        type: 'PROCESS_CREATED',
        actorType: 'USER',
        actorId: ANA,
        // Nome do contexto da requisição: nenhuma leitura de `users`.
        actorName: 'Ana Souza',
        actorDepartmentName: null,
        entityType: 'Process',
        entityId: PROCESS,
        movementId: null,
        params: {
          code: '0012/2026',
          title: 'Manutenção predial',
          requestingDepartmentName: 'Setor de Manutenção',
        },
        visibility: 'STANDARD',
        sourceEventId: event.eventId,
      },
    ]);
    expect(projected).toHaveBeenCalledWith(1, { type: 'PROCESS_CREATED' });
    expect(duration).toHaveBeenCalledWith(expect.any(Number), { event_type: 'ProcessCreated' });
    const [info] = spies.log.mock.calls;
    expect(info?.[0]).toEqual({
      event: 'timeline.entry_projected',
      processId: PROCESS,
      type: 'PROCESS_CREATED',
      sourceEventId: event.eventId,
      durationMs: expect.any(Number) as number,
    });
    // Logs sem params (título, nomes) — seção Logs da story.
    expect(JSON.stringify(spies.log.mock.calls)).not.toContain('Manutenção predial');
  });

  it('tramitação: unidade do ator (custódia) e movementId', async () => {
    logs();
    const { store, projector } = setup();
    await asAna(() =>
      projector.handle(
        tx,
        recorded({
          eventType: 'ProcessStageChanged',
          routingKey: 'process.stage_changed.forward',
          payload: {
            cause: 'FORWARD',
            movementId: MOVEMENT,
            fromStage: { processStageId: STAGE_A, key: 'ABERTURA' },
            toStage: { processStageId: STAGE_B, key: 'ANALISE', type: 'TASK' },
            fromDepartmentId: DEPT_MANUT,
            toDepartmentId: DEPT_COMPRAS,
            toUserId: null,
            documentIds: [],
          },
        }),
      ),
    );
    expect(rowsOf(store)).toMatchObject([
      {
        type: 'PROCESS_FORWARDED',
        actorDepartmentName: 'Setor de Manutenção',
        movementId: MOVEMENT,
        params: { fromStageName: 'Abertura', toStageName: 'Análise', toDepartmentName: 'Compras' },
      },
    ]);
  });

  it('[Validação] evento sem mapeamento é ignorado com log debug, sem erro', async () => {
    const spies = logs();
    const { store, projector } = setup();
    await asAna(() =>
      projector.handle(
        tx,
        recorded({
          eventType: 'ProcessDraftDiscarded',
          routingKey: 'process.draft_discarded',
          payload: { reasonProvided: false },
        }),
      ),
    );
    expect(rowsOf(store)).toEqual([]);
    expect(spies.debug).toHaveBeenCalledWith(
      { event: 'timeline.event_not_mapped', eventType: 'ProcessDraftDiscarded' },
      'timeline.event_not_mapped',
    );
  });

  it('[Duplicidade] o mesmo evento reprocessado não duplica a entrada (warn)', async () => {
    const spies = logs();
    const duplicates = vi.spyOn(timelineMetrics().duplicates, 'add');
    const { store, projector } = setup();
    const event = recorded();

    await asAna(() => projector.project(tx, event));
    await asAna(() => projector.project(tx, event));

    expect(rowsOf(store)).toHaveLength(1);
    expect(duplicates).toHaveBeenCalledWith(1, { type: 'PROCESS_CREATED' });
    expect(spies.warn).toHaveBeenCalledWith(
      {
        event: 'timeline.duplicate_ignored',
        sourceEventId: event.eventId,
        type: 'PROCESS_CREATED',
      },
      'timeline.duplicate_ignored',
    );
  });

  it('replay fora da requisição original: o nome do ator é lido (fonte USER)', async () => {
    logs();
    const { store, projector } = setup();
    await runAsSystem({ name: 'Backfill da timeline', tenantId: TENANT }, () =>
      projector.project(tx, recorded()),
    );
    expect(rowsOf(store)[0]).toMatchObject({
      actorType: 'USER',
      actorId: ANA,
      actorName: 'Ana Souza (lida)',
    });
  });

  it('ator SYSTEM: sem actorId e com o nome do job do contexto', async () => {
    logs();
    const { store, projector } = setup();
    const system = { type: 'SYSTEM' as const, userId: null, membershipId: null };
    await runAsSystem({ name: 'Job de prazos', tenantId: TENANT }, () =>
      projector.project(
        tx,
        recorded({
          eventType: 'ProcessStatusChanged',
          routingKey: 'process.status_changed.suspended',
          actor: system,
          payload: { fromStatus: 'IN_PROGRESS', toStatus: 'SUSPENDED' },
        }),
      ),
    );
    expect(rowsOf(store)[0]).toMatchObject({
      type: 'PROCESS_SUSPENDED',
      actorType: 'SYSTEM',
      actorId: null,
      actorName: 'Job de prazos',
    });
  });

  it('fora de qualquer contexto e sem usuário, o ator fica sem nome', async () => {
    logs();
    const { store, projector } = setup();
    await projector.project(
      tx,
      recorded({ actor: { type: 'SYSTEM', userId: null, membershipId: null } }),
    );
    expect(rowsOf(store)[0]).toMatchObject({ actorName: null, actorId: null });
  });

  it('discriminador sem linha (FA-02) é ignorado', async () => {
    const spies = logs();
    const { store, projector } = setup();
    await projector.project(
      tx,
      recorded({
        eventType: 'ProcessStatusChanged',
        payload: { fromStatus: 'DRAFT', toStatus: 'IN_PROGRESS' },
      }),
    );
    expect(rowsOf(store)).toEqual([]);
    expect(spies.debug).toHaveBeenCalledTimes(1);
  });

  it('anexo fora de processo é ignorado; evento de processo sem processId falha (V-01)', async () => {
    const spies = logs();
    const { store, projector } = setup();
    await projector.project(
      tx,
      recorded({
        eventType: 'AttachmentUploaded',
        processId: null,
        payload: { attachmentId: PROCESS, targetType: 'TENANT_ASSET', fileName: 'brasao.png' },
      }),
    );
    expect(rowsOf(store)).toEqual([]);

    await expect(projector.project(tx, recorded({ processId: null }))).rejects.toThrow(
      TimelinePayloadError,
    );
    await expect(projector.project(tx, recorded({ tenantId: null }))).rejects.toThrow(/tenantId/);
    expect(spies.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'timeline.projection_failed',
        errorCode: 'INTERNAL_ERROR',
        cause: 'TimelinePayloadError',
        correlationId: 'corr-us059',
      }),
      'timeline.projection_failed',
    );
  });

  it('[V-01] payload incompleto falha sem gravar e sem logar valores', async () => {
    const spies = logs();
    const failed = vi.spyOn(timelineMetrics().failed, 'add');
    const { store, projector } = setup();
    await expect(
      projector.project(tx, recorded({ payload: { title: 'Segredo do título' } })),
    ).rejects.toThrow(TimelinePayloadError);
    expect(rowsOf(store)).toEqual([]);
    expect(failed).toHaveBeenCalledWith(1, { error_code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(spies.error.mock.calls)).not.toContain('Segredo');
  });

  it('referência sem fonte registrada desfaz a origem (INTERNAL_ERROR)', async () => {
    logs();
    const { projector } = setup({ sources: [] });
    await expect(projector.project(tx, recorded())).rejects.toThrow(TimelineLookupUnavailableError);
  });

  it('[Falha de banco] erro transitório propaga, logado como DEPENDENCY_UNAVAILABLE', async () => {
    const spies = logs();
    const dropped = new Error('Connection terminated unexpectedly');
    const { projector } = setup({ store: { insert: () => Promise.reject(dropped) } });
    await expect(projector.project(tx, recorded())).rejects.toBe(dropped);
    expect(spies.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'DEPENDENCY_UNAVAILABLE', cause: 'Error' }),
      'timeline.projection_failed',
    );
  });

  it('deadlock/serialização propaga sem log de erro (a TenantTransaction refaz tudo)', async () => {
    const spies = logs();
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { projector } = setup({ store: { insert: () => Promise.reject(conflict) } });
    await expect(projector.project(tx, recorded())).rejects.toBe(conflict);
    expect(spies.error).not.toHaveBeenCalled();
  });
});

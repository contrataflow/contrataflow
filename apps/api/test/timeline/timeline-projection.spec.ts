// Projeção da timeline contra PostgreSQL real (US-059 · Gherkin "Projetar eventos do processo na
// timeline"): migrações reais, a aplicação como `cf_app` (RLS) pela `TenantTransaction`, o
// `OutboxWriter` com o `TimelineProjector` real e a fonte `USER` real (`identity`). Processos e
// unidades ainda não existem (US-001/US-102): um agregado de teste e as fontes `PROCESS` e
// `DEPARTMENT` leem tabelas criadas só neste contêiner, com a mesma RLS das tabelas de negócio.
// Também na suíte "tenant leak" (`test:tenant-leak`).
// `pnpm --filter @contrataflow/api test:integration`.
import { defineDomainEvent } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { IdentityFacade } from '#modules/identity/application/identity.facade.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { OutboxWriterService } from '#modules/platform/application/outbox-writer.service.js';
import { SyncEventHandlerRegistry } from '#modules/platform/application/sync-event-handler.registry.js';
import { PrismaOutboxStore } from '#modules/platform/infrastructure/outbox/prisma-outbox.store.js';
import type { AnyTimelineLookupSource } from '#modules/timeline/application/ports.js';
import { TimelineLookupResolver } from '#modules/timeline/application/timeline-lookup.resolver.js';
import { TimelineProjector } from '#modules/timeline/application/timeline-projector.js';
import { IdentityUserLookupSource } from '#modules/timeline/infrastructure/identity-user.lookup-source.js';
import { PrismaTimelineEntryStore } from '#modules/timeline/infrastructure/prisma-timeline-entry.store.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import type { RecordedDomainEvent } from '#shared/outbox/outbox-writer.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const SAO_JOSE = '0192f000-0000-7000-8000-00000000059a';
const PREF_B = '0192f000-0000-7000-8000-00000000059b';
const ANA = '0192f000-0000-7000-8000-0000000005a1';
const BRUNO = '0192f000-0000-7000-8000-0000000005b1';
const ANA_SJ = '0192f000-0000-7000-8000-0000000015a1';
const BRUNO_B = '0192f000-0000-7000-8000-0000000015b1';
const MANUTENCAO = '0192f000-0000-7000-8000-0000000005d1';
const COMPRAS_B = '0192f000-0000-7000-8000-0000000005d2';
const STAGE_FROM = '0192f000-0000-7000-8000-0000000005e1';
const STAGE_TO = '0192f000-0000-7000-8000-0000000005e2';

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${SAO_JOSE}', 'sao-jose-tl', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${PREF_B}', 'prefeitura-b-tl', 'Prefeitura B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, email, name, social_name) VALUES
  ('${ANA}', 'ana.tl@saojose.sc.gov.br', 'Ana Ribeiro', NULL),
  ('${BRUNO}', 'bruno.tl@prefb.sc.gov.br', 'Bruno Lima', 'Bruno L.');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_SJ}', '${SAO_JOSE}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${BRUNO_B}', '${PREF_B}', '${BRUNO}', 'INTERNAL', 'ACTIVE');

SET ROLE cf_owner;
CREATE TABLE test_processes (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text, title text NOT NULL,
  is_budget_confidential boolean NOT NULL DEFAULT false, stage text);
CREATE TABLE test_departments (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL);
ALTER TABLE test_processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_processes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON test_processes
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE test_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_departments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON test_departments
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
GRANT SELECT, INSERT, UPDATE ON test_processes, test_departments TO cf_app;
-- US-001 criou a FK da timeline para \`processes\`; este contêiner exercita só o projetor sobre o
-- agregado de teste, então a FK sai daqui (a projeção real com processos: tenant-leak/processes).
ALTER TABLE process_timeline_entries DROP CONSTRAINT process_timeline_entries_process_fkey;
RESET ROLE;
INSERT INTO test_departments (id, tenant_id, name) VALUES
  ('${MANUTENCAO}', '${SAO_JOSE}', 'Setor de Manutenção'),
  ('${COMPRAS_B}', '${PREF_B}', 'Compras da Prefeitura B');
`;

// Eventos com os payloads de events.md §4 (as definições reais chegam com as stories donas).
const ProcessCreated = defineDomainEvent({
  eventType: 'ProcessCreated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.looseObject({
    code: z.string().nullable(),
    title: z.string(),
    requestingDepartmentId: z.uuid(),
  }),
  routingKey: 'process.created',
});
const ProcessUpdated = defineDomainEvent({
  eventType: 'ProcessUpdated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({ changedFields: z.array(z.string()), version: z.int() }),
  routingKey: 'process.updated',
});
const ProcessItemsChanged = defineDomainEvent({
  eventType: 'ProcessItemsChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    added: z.array(z.uuid()),
    updated: z.array(z.uuid()),
    removed: z.array(z.uuid()),
    itemsCount: z.int(),
  }),
  routingKey: 'process.items_changed',
});
const CommentCreated = defineDomainEvent({
  eventType: 'CommentCreated',
  eventVersion: 1,
  aggregateType: 'Comment',
  payload: z.strictObject({ commentId: z.uuid(), targetType: z.enum(['PROCESS', 'DOCUMENT']) }),
  routingKey: 'comment.created',
});
const ProcessStageChanged = defineDomainEvent({
  eventType: 'ProcessStageChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.looseObject({ cause: z.enum(['FORWARD', 'RETURN']) }),
  routingKey: (payload) => `process.stage_changed.${payload.cause.toLowerCase()}`,
});
const ProcessDraftDiscarded = defineDomainEvent({
  eventType: 'ProcessDraftDiscarded',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({ reasonProvided: z.boolean() }),
  routingKey: 'process.draft_discarded',
});

interface EntryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly process_id: string;
  readonly occurred_at: Date;
  readonly type: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly actor_name: string | null;
  readonly actor_department_name: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly movement_id: string | null;
  readonly params: Record<string, unknown>;
  readonly visibility: string;
  readonly source_event_id: string;
}

/** Requisição autenticada no tenant (o que os guards fazem na API). */
function asUser<T>(
  tenantId: string,
  user: { id: string; membershipId: string; name: string },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'corr-us059', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'USER', userId: user.id, membershipId: user.membershipId, name: user.name },
      });
      return fn();
    },
  );
}

const ana = { id: ANA, membershipId: ANA_SJ, name: 'Ana Ribeiro' };
const bruno = { id: BRUNO, membershipId: BRUNO_B, name: 'Bruno L.' };

/** RLS recusou (direto do driver ou embrulhado pela TenantTransaction). */
function isRlsViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.message.includes('row-level security')) return true;
  }
  return false;
}

describe('TimelineProjector no PostgreSQL (US-059)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;
  let writer: OutboxWriterService;
  let projector: TimelineProjector;
  /** Gancho de teste chamado pela fonte PROCESS_STAGE (falha de banco no meio da projeção). */
  let onStageLookup: (tx: TenantTx) => Promise<void> = () => Promise.resolve();

  /** Fontes que leem as tabelas de teste no tx (RLS do tenant), como as fachadas reais farão. */
  const testSources = (): AnyTimelineLookupSource[] => [
    {
      kind: 'DEPARTMENT',
      async lookup(tx, ids) {
        const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
          SELECT id::text, name FROM test_departments WHERE id = ANY(${[...ids]}::uuid[])`;
        return new Map(rows.map((row) => [row.id, { name: row.name }]));
      },
    },
    {
      kind: 'PROCESS',
      async lookup(tx, ids) {
        const rows = await tx.$queryRaw<
          { id: string; code: string | null; is_budget_confidential: boolean }[]
        >`SELECT id::text, code, is_budget_confidential FROM test_processes
           WHERE id = ANY(${[...ids]}::uuid[])`;
        return new Map(
          rows.map((row) => [
            row.id,
            { code: row.code, isBudgetConfidential: row.is_budget_confidential },
          ]),
        );
      },
    },
    {
      kind: 'PROCESS_STAGE',
      async lookup(tx, ids) {
        await onStageLookup(tx);
        const names: Record<string, string> = { [STAGE_FROM]: 'Abertura', [STAGE_TO]: 'Análise' };
        return new Map(ids.map((id) => [id, { name: names[id] ?? '?' }]));
      },
    },
    {
      kind: 'COMMENT',
      lookup: (_tx, ids) =>
        Promise.resolve(new Map(ids.map((id) => [id, { excerpt: 'Favor revisar o item 2.' }]))),
    },
  ];

  /** Caso de uso de teste: cria o processo e grava `ProcessCreated` no mesmo tx (RN-FND-49). */
  const createProcess = (
    tenantId: string,
    user: typeof ana,
    options: {
      title?: string;
      departmentId?: string;
      confidential?: boolean;
      after?: (tx: TenantTx, event: RecordedDomainEvent) => Promise<void>;
    } = {},
  ) =>
    asUser(tenantId, user, () =>
      app.$tenantTransaction(async (tx) => {
        const id = newId();
        const code = `${String(Math.floor(Math.random() * 9000) + 1000)}/2026`;
        const title = options.title ?? 'Manutenção predial';
        await tx.$executeRaw`
          INSERT INTO test_processes (id, tenant_id, code, title, is_budget_confidential)
          VALUES (${id}::uuid, ${tenantId}::uuid, ${code}, ${title}, ${options.confidential ?? false})`;
        const event = await writer.record(
          tx,
          ProcessCreated.of({
            aggregateId: id,
            processId: id,
            payload: { code, title, requestingDepartmentId: options.departmentId ?? MANUTENCAO },
          }),
        );
        await options.after?.(tx, event);
        return { id, code, event };
      }),
    );

  const entriesOf = (processId: string) =>
    db.admin<EntryRow>(
      `SELECT * FROM process_timeline_entries WHERE process_id = $1 ORDER BY occurred_at, id`,
      [processId],
    );

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    app = db.client('cf_app');
    const registry = new SyncEventHandlerRegistry();
    const users = new IdentityUserLookupSource(
      new IdentityFacade(
        new PrismaIdentityRepository({} as never, {} as never),
        {} as never,
        {} as never,
      ),
    );
    projector = new TimelineProjector(
      registry,
      new PrismaTimelineEntryStore(),
      new TimelineLookupResolver([users, ...testSources()]),
    );
    projector.onModuleInit();
    writer = new OutboxWriterService(new PrismaOutboxStore(), registry);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db.stop();
  });

  it('[Sucesso] ProcessCreated grava PROCESS_CREATED na mesma transação, com nomes congelados', async () => {
    const { id, code, event } = await createProcess(SAO_JOSE, ana);

    const [entry, ...others] = await entriesOf(id);
    expect(others).toEqual([]);
    expect(entry).toMatchObject({
      tenant_id: SAO_JOSE,
      process_id: id,
      type: 'PROCESS_CREATED',
      actor_type: 'USER',
      actor_id: ANA,
      actor_name: 'Ana Ribeiro',
      entity_type: 'Process',
      entity_id: id,
      movement_id: null,
      params: {
        code,
        title: 'Manutenção predial',
        requestingDepartmentName: 'Setor de Manutenção',
      },
      visibility: 'STANDARD',
      source_event_id: event.eventId,
    });
    // occurredAt = instante do fato (o do evento), não o da gravação.
    expect(entry?.occurred_at.toISOString()).toBe(event.occurredAt);
  });

  it('[RN-TML-04] renomear a unidade depois não altera a entrada já gravada (FA-05)', async () => {
    const { id } = await createProcess(SAO_JOSE, ana);
    await db.admin(`UPDATE test_departments SET name = 'Manutenção (renomeada)' WHERE id = $1`, [
      MANUTENCAO,
    ]);
    try {
      const [entry] = await entriesOf(id);
      expect(entry?.params).toMatchObject({ requestingDepartmentName: 'Setor de Manutenção' });
    } finally {
      await db.admin(`UPDATE test_departments SET name = 'Setor de Manutenção' WHERE id = $1`, [
        MANUTENCAO,
      ]);
    }
  });

  it('[Sucesso] ProcessUpdated com estimatedValue de processo sigiloso → BUDGET_RESTRICTED', async () => {
    const { id } = await createProcess(SAO_JOSE, ana, { confidential: true });
    await asUser(SAO_JOSE, ana, () =>
      app.$tenantTransaction(async (tx) => {
        await writer.record(
          tx,
          ProcessUpdated.of({
            aggregateId: id,
            processId: id,
            payload: { changedFields: ['estimatedValue'], version: 2 },
          }),
        );
      }),
    );
    const updated = (await entriesOf(id)).filter((row) => row.type === 'PROCESS_UPDATED');
    expect(updated).toMatchObject([
      { visibility: 'BUDGET_RESTRICTED', params: { fields: ['estimatedValue'] } },
    ]);
  });

  it('[Validação] evento sem mapeamento não grava entrada e não interrompe a origem', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { id } = await createProcess(SAO_JOSE, ana);
    await asUser(SAO_JOSE, ana, () =>
      app.$tenantTransaction(async (tx) => {
        await writer.record(
          tx,
          ProcessDraftDiscarded.of({
            aggregateId: id,
            processId: id,
            payload: { reasonProvided: false },
          }),
        );
      }),
    );
    const outbox = await db.admin<{ event_type: string }>(
      'SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at',
      [id],
    );
    expect(outbox.map((row) => row.event_type)).toEqual([
      'ProcessCreated',
      'ProcessDraftDiscarded',
    ]);
    expect((await entriesOf(id)).map((row) => row.type)).toEqual(['PROCESS_CREATED']);
    expect(debug).toHaveBeenCalledWith(
      { event: 'timeline.event_not_mapped', eventType: 'ProcessDraftDiscarded' },
      'timeline.event_not_mapped',
    );
    debug.mockRestore();
  });

  it('[Permissão] caso de uso negado (403) antes do fato: nenhum evento nem entrada', async () => {
    const title = `negado-${newId()}`;
    const attempt = asUser(SAO_JOSE, ana, () =>
      app.$tenantTransaction(() => {
        // O AuthorizationService recusa antes de qualquer escrita (sem PROCESS_CREATE).
        throw new ApiError('PERMISSION_DENIED', { auditReasonCode: 'PROCESS_CREATE' });
      }),
    );
    await expect(attempt).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(
      await db.admin(`SELECT 1 FROM outbox_events WHERE payload ->> 'title' = $1`, [title]),
    ).toEqual([]);
    expect(
      await db.admin(`SELECT 1 FROM process_timeline_entries WHERE params ->> 'title' = $1`, [
        title,
      ]),
    ).toEqual([]);
  });

  describe('[Tenant incorreto] isolamento por RLS (suíte tenant leak)', () => {
    it('a entrada fica no tenant do evento e não é lida com app.tenant_id de outro tenant', async () => {
      const { id, event } = await createProcess(PREF_B, bruno, { departmentId: COMPRAS_B });

      const [entry] = await entriesOf(id);
      expect(entry).toMatchObject({
        tenant_id: PREF_B,
        actor_name: 'Bruno L.',
        params: { requestingDepartmentName: 'Compras da Prefeitura B' },
      });

      const seenFromSaoJose = await asUser(SAO_JOSE, ana, () =>
        app.$tenantTransaction(
          (tx) => tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM process_timeline_entries
             WHERE source_event_id = ${event.eventId}::uuid OR process_id = ${id}::uuid`,
        ),
      );
      expect(seenFromSaoJose).toEqual([]);
    });

    it('leituras auxiliares não resolvem nomes de outro tenant (unidade e usuário)', async () => {
      // Processo da Prefeitura B citando a unidade de São José: a RLS esconde o nome.
      const { id } = await createProcess(PREF_B, bruno, { departmentId: MANUTENCAO });
      const [entry] = await entriesOf(id);
      expect(entry?.params).toMatchObject({ requestingDepartmentName: null });

      // Replay do evento com ator de outro tenant: o nome do usuário não é resolvido.
      const users = new IdentityUserLookupSource(
        new IdentityFacade(
          new PrismaIdentityRepository({} as never, {} as never),
          {} as never,
          {} as never,
        ),
      );
      const names = await asUser(PREF_B, bruno, () =>
        app.$tenantTransaction((tx) => users.lookup(tx, [ANA, BRUNO])),
      );
      expect([...names.keys()]).toEqual([BRUNO]);
    });

    it('projetar no tx de um tenant um evento de outro tenant é recusado pela RLS', async () => {
      const { event } = await createProcess(PREF_B, bruno, { departmentId: COMPRAS_B });
      const forged: RecordedDomainEvent = { ...event, eventId: newId() };
      const attempt = asUser(SAO_JOSE, ana, () =>
        app.$tenantTransaction((tx) => projector.project(tx, forged)),
      );
      const error = await attempt.catch((caught: unknown) => caught);
      expect(isRlsViolation(error)).toBe(true);
      expect(
        await db.admin('SELECT 1 FROM process_timeline_entries WHERE source_event_id = $1', [
          forged.eventId,
        ]),
      ).toEqual([]);
    });
  });

  describe('[Duplicidade] reprocessamento do mesmo evento (RN-TML-03 · FA-04)', () => {
    it('replay manual não cria nova entrada: continua exatamente uma por (sourceEventId, type)', async () => {
      const { id, event } = await createProcess(SAO_JOSE, ana);
      await asUser(SAO_JOSE, ana, () =>
        app.$tenantTransaction((tx) => projector.project(tx, event)),
      );
      await asUser(SAO_JOSE, ana, () =>
        app.$tenantTransaction((tx) => projector.project(tx, event)),
      );
      const rows = await db.admin<{ count: string }>(
        `SELECT count(*)::text AS count FROM process_timeline_entries
          WHERE source_event_id = $1 AND type = 'PROCESS_CREATED'`,
        [event.eventId],
      );
      expect(rows).toEqual([{ count: '1' }]);
      expect(await entriesOf(id)).toHaveLength(1);
    });

    it('a mesma chave em duas transações concorrentes grava uma única vez', async () => {
      const { event } = await createProcess(SAO_JOSE, ana);
      const replay: RecordedDomainEvent = { ...event, eventId: newId() };
      let releaseFirst: () => void = () => undefined;
      const firstHolds = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstInserted: () => void = () => undefined;
      const inserted = new Promise<void>((resolve) => {
        firstInserted = resolve;
      });

      const first = asUser(SAO_JOSE, ana, () =>
        app.$tenantTransaction(async (tx) => {
          await projector.project(tx, replay);
          firstInserted();
          await firstHolds;
        }),
      );
      await inserted;
      // A segunda espera o commit da primeira no índice único e então não grava (DO NOTHING).
      const second = asUser(SAO_JOSE, ana, () =>
        app.$tenantTransaction((tx) => projector.project(tx, replay)),
      );
      setTimeout(releaseFirst, 200);
      await Promise.all([first, second]);

      expect(
        await db.admin('SELECT 1 FROM process_timeline_entries WHERE source_event_id = $1', [
          replay.eventId,
        ]),
      ).toHaveLength(1);
    });
  });

  it('[Concorrência] eventos distintos do mesmo processo em paralelo geram entradas distintas e ordenadas', async () => {
    const { id } = await createProcess(SAO_JOSE, ana);
    const record = (event: Parameters<OutboxWriterService['record']>[1]) =>
      asUser(SAO_JOSE, ana, () =>
        app.$tenantTransaction(async (tx) => {
          // Trava do agregado antes do evento (queues.md §5.4), como o caso de uso real.
          await tx.$executeRaw`SELECT 1 FROM test_processes WHERE id = ${id}::uuid FOR UPDATE`;
          return writer.record(tx, event);
        }),
      );
    const [items, comment] = await Promise.all([
      record(
        ProcessItemsChanged.of({
          aggregateId: id,
          processId: id,
          payload: { added: [newId()], updated: [], removed: [], itemsCount: 1 },
        }),
      ),
      record(
        CommentCreated.of({
          aggregateId: newId(),
          processId: id,
          payload: { commentId: newId(), targetType: 'PROCESS' },
        }),
      ),
    ]);

    const rows = (await entriesOf(id)).filter((row) => row.type !== 'PROCESS_CREATED');
    expect(rows.map((row) => row.type).sort()).toEqual(['COMMENT_ADDED', 'ITEMS_CHANGED']);
    const byOccurrence = [items, comment]
      .sort((x, y) => x.occurredAt.localeCompare(y.occurredAt))
      .map((event) => event.eventId);
    expect(rows.map((row) => row.source_event_id)).toEqual(byOccurrence);
    expect(rows.find((row) => row.type === 'COMMENT_ADDED')?.params).toMatchObject({
      excerpt: 'Favor revisar o item 2.',
    });
  });

  describe('[Falha de banco] e rollback conjunto (RN-TML-01)', () => {
    it('a conexão cai durante a projeção de ProcessStageChanged: 503 e nada é persistido', async () => {
      const { id } = await createProcess(SAO_JOSE, ana);
      onStageLookup = async (tx) => {
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await db.admin('SELECT pg_terminate_backend($1)', [backend?.pid]);
      };
      try {
        const attempt = asUser(SAO_JOSE, ana, () =>
          app.$tenantTransaction(async (tx) => {
            await tx.$executeRaw`UPDATE test_processes SET stage = 'ANALISE' WHERE id = ${id}::uuid`;
            await writer.record(
              tx,
              ProcessStageChanged.of({
                aggregateId: id,
                processId: id,
                payload: {
                  cause: 'FORWARD',
                  movementId: newId(),
                  fromStage: { processStageId: STAGE_FROM, key: 'ABERTURA' },
                  toStage: { processStageId: STAGE_TO, key: 'ANALISE', type: 'TASK' },
                  fromDepartmentId: MANUTENCAO,
                  toDepartmentId: MANUTENCAO,
                  toUserId: null,
                  documentIds: [],
                },
              }),
            );
          }),
        );
        const error = await attempt.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(DatabaseUnavailableError);
        expect(error).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
      } finally {
        onStageLookup = () => Promise.resolve();
      }
      const [process] = await db.admin<{ stage: string | null }>(
        'SELECT stage FROM test_processes WHERE id = $1',
        [id],
      );
      expect(process?.stage).toBeNull();
      expect(
        await db.admin(
          `SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ProcessStageChanged'`,
          [id],
        ),
      ).toEqual([]);
      expect((await entriesOf(id)).map((row) => row.type)).toEqual(['PROCESS_CREATED']);
    });

    it('falha induzida no caso de uso depois da projeção desfaz agregado, evento e timeline', async () => {
      const title = `desfeito-${newId()}`;
      await expect(
        createProcess(SAO_JOSE, ana, {
          title,
          after: () => Promise.reject(new Error('regra violada')),
        }),
      ).rejects.toThrow('regra violada');
      expect(await db.admin('SELECT 1 FROM test_processes WHERE title = $1', [title])).toEqual([]);
      expect(
        await db.admin(`SELECT 1 FROM outbox_events WHERE payload ->> 'title' = $1`, [title]),
      ).toEqual([]);
      expect(
        await db.admin(`SELECT 1 FROM process_timeline_entries WHERE params ->> 'title' = $1`, [
          title,
        ]),
      ).toEqual([]);
    });
  });

  it('[Falha de integração] sem relay/fila, a entrada é gravada e o evento fica PENDING', async () => {
    // Nenhum relay roda neste teste: a fila "domain-events" está, na prática, indisponível.
    const { id, event } = await createProcess(SAO_JOSE, ana);
    expect((await entriesOf(id)).map((row) => row.type)).toEqual(['PROCESS_CREATED']);
    const [outbox] = await db.admin<{ status: string }>(
      'SELECT status FROM outbox_events WHERE id = $1',
      [event.eventId],
    );
    expect(outbox?.status).toBe('PENDING');
  });

  describe('tabela process_timeline_entries (migração)', () => {
    it('é imutável: UPDATE e DELETE falham até para o dono; cf_app só tem INSERT/SELECT', async () => {
      const { id } = await createProcess(SAO_JOSE, ana);
      await expect(
        db.admin(`UPDATE process_timeline_entries SET actor_name = 'x' WHERE process_id = $1`, [
          id,
        ]),
      ).rejects.toThrow(/imutável/);
      await expect(
        db.admin('DELETE FROM process_timeline_entries WHERE process_id = $1', [id]),
      ).rejects.toThrow(/imutável/);
      const grants = await db.admin<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'process_timeline_entries' AND grantee = 'cf_app'
          ORDER BY privilege_type`,
      );
      expect(grants.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
    });

    it('RLS ENABLE + FORCE, unicidade (tenant_id, source_event_id, type) e índice da leitura paginada', async () => {
      const [table] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = 'process_timeline_entries'`,
      );
      expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const indexes = await db.admin<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'process_timeline_entries'`,
      );
      const definitions = Object.fromEntries(indexes.map((row) => [row.indexname, row.indexdef]));
      expect(definitions.process_timeline_entries_source_key).toMatch(
        /UNIQUE INDEX .*\(tenant_id, source_event_id, type\)/,
      );
      expect(definitions.process_timeline_entries_process_idx).toMatch(
        /\(tenant_id, process_id, occurred_at DESC, id DESC\)/,
      );
    });
  });
});

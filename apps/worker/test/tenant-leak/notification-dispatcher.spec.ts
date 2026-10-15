// NotificationDispatcher (US-111) sobre PostgreSQL real, com o papel `cf_worker` (sem BYPASSRLS):
// idempotência por (tenant, destinatário, evento, tipo) na reentrega, agrupamento de 5 min com
// trava, concorrência real (eventos quase simultâneos do mesmo grupo → uma notificação), RLS de
// `notifications` (nada da Prefeitura B é lido nem gravado), transação única (falha no meio não
// deixa notificação parcial), `notifications.emailEnabled` do tenant e os GRANTs da migração.
import type { DomainEventEnvelope, JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotificationDispatcher } from '../../src/notifications/notification-dispatcher.js';
import { NotificationStore } from '../../src/notifications/notification-store.js';
import type { NotificationContent } from '../../src/notifications/notification-templates.js';
import type { ProcessVisibility } from '../../src/notifications/recipient-resolver.js';
import { SqlNotificationDirectory } from '../../src/notifications/sql-notification-directory.js';
import type { JobHandlerContext } from '../../src/queues/run-job.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

const CARLA = '0192f0a0-0000-7000-8000-0000000c0001';
const BRUNO = '0192f0a0-0000-7000-8000-0000000c0002';
const ATOR = '0192f0a0-0000-7000-8000-0000000c0003';
const SUSPENSA = '0192f0a0-0000-7000-8000-0000000c0004';
const BETO_B = '0192f0a0-0000-7000-8000-0000000c00b1';
const UNIDADE = '0192f0a0-0000-7000-8000-0000000c0d01';
const ORGAO = '0192f0a0-0000-7000-8000-0000000c0e01';
const PROCESSO = '0192f0a0-0000-7000-8000-0000000c0f01';
const PROCESSO_B = '0192f0a0-0000-7000-8000-0000000c0f0b';
const T0 = new Date('2026-10-15T12:00:00.000Z');

let db: TestPostgres;
let worker: WorkerDatabase;
let eventSeq = 0;

function eventId(): string {
  eventSeq += 1;
  return `0192f0a0-0000-7000-8000-${(0xe00000 + eventSeq).toString(16).padStart(12, '0')}`;
}

function envelope(
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<DomainEventEnvelope<Record<string, unknown>>> = {},
): DomainEventEnvelope<Record<string, unknown>> {
  return {
    eventId: eventId(),
    eventType,
    routingKey: 'process.stage_changed.return',
    eventVersion: 1,
    occurredAt: T0.toISOString(),
    tenantId: TENANT_A,
    aggregateType: 'Process',
    aggregateId: PROCESSO,
    processId: PROCESSO,
    actor: { type: 'USER', userId: ATOR, membershipId: null },
    correlationId: 'corr-ntf-it',
    causationId: null,
    payload,
    ...overrides,
  };
}

const devolvido = (toUserId: string | null = CARLA, processId = PROCESSO) =>
  envelope(
    'ProcessStageChanged',
    { cause: 'RETURN', toUserId, toDepartmentId: UNIDADE, toStage: { type: 'TASK' } },
    { processId },
  );

const resposta = (processId = PROCESSO) =>
  envelope(
    'CommentCreated',
    { commentId: eventId(), parentId: eventId(), parentAuthorId: CARLA },
    { processId },
  );

/** `ProcessAccess` ainda não existe (US-001): nos testes, todos veem o processo. */
const seeAll: ProcessVisibility = {
  visibleTo: (_client, _processId, userIds) => Promise.resolve(new Set(userIds)),
};

function contextFor(tenantId: string): JobHandlerContext {
  const meta: JobMeta = {
    schemaVersion: 1,
    tenantId,
    actor: { type: 'USER', userId: ATOR, membershipId: null },
    correlationId: 'corr-ntf-it',
    causationId: null,
    enqueuedAt: T0.toISOString(),
  };
  return {
    meta,
    queue: 'notifications',
    jobName: 'event',
    jobId: 'job',
    attempt: 1,
    signal: new AbortController().signal,
    logger: new Logger('NotificationDispatcherIT'),
    tenantTransaction: (work) => worker.tenantTransaction(tenantId, work),
    platformTransaction: () => Promise.reject(new Error('não usado')),
  };
}

function dispatcherWith(
  options: { now?: () => Date; store?: NotificationStore; emails?: string[] } = {},
) {
  return new NotificationDispatcher({
    directory: new SqlNotificationDirectory(),
    visibility: seeAll,
    email: {
      enqueue: (notificationId) => {
        options.emails?.push(notificationId);
        return Promise.resolve();
      },
    },
    ...(options.store ? { store: options.store } : {}),
    now: options.now ?? (() => T0),
  });
}

type Row = Record<string, unknown>;

const rowsOf = (tenantId: string, recipientId?: string) =>
  db.admin<Row>(
    `SELECT id, recipient_id, type, title, body, link, process_id, source_event_id, group_key,
            group_count, grouped_event_ids, email_status::text AS email_status, read_at, created_at
       FROM notifications
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR recipient_id = $2)
      ORDER BY created_at, id`,
    [tenantId, recipientId ?? null],
  );

const digestOfB = async () =>
  (
    await db.admin<{ d: string | null }>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS d FROM notifications t WHERE tenant_id = $1`,
      [TENANT_B],
    )
  )[0]?.d;

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    INSERT INTO users (id, external_subject, email, name, status) VALUES
      ('${CARLA}', 'sub-carla-ntf', 'carla@ntf.test', 'Carla', 'ACTIVE'),
      ('${BRUNO}', 'sub-bruno-ntf', 'bruno@ntf.test', 'Bruno', 'ACTIVE'),
      ('${ATOR}', 'sub-ator-ntf', 'ator@ntf.test', 'Ator', 'ACTIVE'),
      ('${SUSPENSA}', 'sub-suspensa-ntf', 'suspensa@ntf.test', 'Suspensa', 'ACTIVE'),
      ('${BETO_B}', 'sub-beto-ntf', 'beto@ntf.test', 'Beto LEAK-B', 'ACTIVE');
    INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
      ('0192f0a0-0000-7000-8000-0000000c1001', '${TENANT_A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
      ('0192f0a0-0000-7000-8000-0000000c1002', '${TENANT_A}', '${BRUNO}', 'INTERNAL', 'ACTIVE'),
      ('0192f0a0-0000-7000-8000-0000000c1003', '${TENANT_A}', '${ATOR}', 'INTERNAL', 'ACTIVE'),
      ('0192f0a0-0000-7000-8000-0000000c1004', '${TENANT_A}', '${SUSPENSA}', 'INTERNAL', 'SUSPENDED'),
      ('0192f0a0-0000-7000-8000-0000000c10b1', '${TENANT_B}', '${BETO_B}', 'INTERNAL', 'ACTIVE');
    INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type)
      VALUES ('${ORGAO}', '${TENANT_A}', 'Prefeitura A', 'PMA', '11222333000181', 'DIRECT_ADMINISTRATION');
    INSERT INTO departments (id, tenant_id, organization_id, type, name, path, depth)
      VALUES ('${UNIDADE}', '${TENANT_A}', '${ORGAO}', 'SECTOR', 'Compras', '/${UNIDADE}/', 0);
    INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
      ('0192f0a0-0000-7000-8000-0000000c2001', '${TENANT_A}', '0192f0a0-0000-7000-8000-0000000c1001', '${UNIDADE}', true),
      ('0192f0a0-0000-7000-8000-0000000c2002', '${TENANT_A}', '0192f0a0-0000-7000-8000-0000000c1002', '${UNIDADE}', true),
      ('0192f0a0-0000-7000-8000-0000000c2003', '${TENANT_A}', '0192f0a0-0000-7000-8000-0000000c1003', '${UNIDADE}', true),
      ('0192f0a0-0000-7000-8000-0000000c2004', '${TENANT_A}', '0192f0a0-0000-7000-8000-0000000c1004', '${UNIDADE}', true);
    INSERT INTO notifications (id, tenant_id, recipient_id, type, title, body, link, process_id,
                               source_event_id, group_key)
      VALUES ('0192f0a0-0000-7000-8000-0000000c3b01', '${TENANT_B}', '${BETO_B}', 'COMMENT_REPLY',
              'Resposta LEAK-B', 'Corpo LEAK-B', '/processos/${PROCESSO_B}', '${PROCESSO_B}',
              '0192f0a0-0000-7000-8000-0000000c4b01', 'COMMENT_REPLY:${PROCESSO_B}');
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
}, 180_000);

afterAll(async () => {
  await worker.close();
  await db.stop();
});

describe('NotificationDispatcher sobre PostgreSQL (US-111)', () => {
  it('[Sucesso] devolução gera PROCESS_RETURNED para Carla com e-mail PENDING enfileirado', async () => {
    const emails: string[] = [];
    const before = await digestOfB();
    const event = devolvido();
    await expect(
      dispatcherWith({ emails }).handle({ envelope: event }, contextFor(TENANT_A)),
    ).resolves.toBe('completed');
    const rows = (await rowsOf(TENANT_A)).filter((row) => row.source_event_id === event.eventId);
    expect(rows).toEqual([
      expect.objectContaining({
        recipient_id: CARLA,
        type: 'PROCESS_RETURNED',
        title: 'Processo devolvido',
        link: `/processos/${PROCESSO}`,
        group_key: `PROCESS_RETURNED:${PROCESSO}`,
        group_count: 1,
        email_status: 'PENDING',
        read_at: null,
      }),
    ]);
    expect(emails).toEqual([rows[0]?.id]);
    expect(await digestOfB()).toBe(before);
  });

  it('[Duplicidade] reentrega do mesmo evento (at-least-once) não cria outra linha', async () => {
    const event = devolvido(BRUNO);
    const dispatcher = dispatcherWith();
    await dispatcher.handle({ envelope: event }, contextFor(TENANT_A));
    await dispatcher.handle({ envelope: event }, contextFor(TENANT_A));
    // Reentrega tardia (fora da janela de 5 min) também é reconhecida.
    await dispatcherWith({ now: () => new Date(T0.getTime() + 60 * 60_000) }).handle(
      { envelope: event },
      contextFor(TENANT_A),
    );
    const rows = (await rowsOf(TENANT_A, BRUNO)).filter(
      (row) => row.source_event_id === event.eventId,
    );
    expect(rows).toHaveLength(1);
  });

  it('[Concorrência] COMMENT_REPLY há 2 min no mesmo processo: atualiza a mesma notificação', async () => {
    const processo = '0192f0a0-0000-7000-8000-0000000c0f02';
    const first = resposta(processo);
    const second = resposta(processo);
    await dispatcherWith().handle({ envelope: first }, contextFor(TENANT_A));
    const [created] = await rowsOf(TENANT_A, CARLA).then((rows) =>
      rows.filter((row) => row.group_key === `COMMENT_REPLY:${processo}`),
    );
    // Carla leu a primeira; a resposta nova a torna não lida de novo (RN-NTF-04).
    await db.admin('UPDATE notifications SET read_at = now() WHERE id = $1', [created?.id]);

    await dispatcherWith({ now: () => new Date(T0.getTime() + 2 * 60_000) }).handle(
      { envelope: second },
      contextFor(TENANT_A),
    );
    // Reentrega do evento agregado: nada muda.
    await dispatcherWith({ now: () => new Date(T0.getTime() + 3 * 60_000) }).handle(
      { envelope: second },
      contextFor(TENANT_A),
    );
    const rows = (await rowsOf(TENANT_A, CARLA)).filter(
      (row) => row.group_key === `COMMENT_REPLY:${processo}`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: created?.id,
        source_event_id: first.eventId,
        grouped_event_ids: [second.eventId],
        group_count: 2,
        body: 'Há 2 novas respostas a comentários seus neste processo.',
        read_at: null,
        email_status: 'NOT_APPLICABLE',
      }),
    ]);
  });

  it('[Concorrência] eventos quase simultâneos do mesmo grupo → uma única notificação', async () => {
    const processo = '0192f0a0-0000-7000-8000-0000000c0f03';
    const events = Array.from({ length: 6 }, () => resposta(processo));
    await Promise.all(
      events.map((event) => dispatcherWith().handle({ envelope: event }, contextFor(TENANT_A))),
    );
    const rows = (await rowsOf(TENANT_A, CARLA)).filter(
      (row) => row.group_key === `COMMENT_REPLY:${processo}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group_count).toBe(6);
    const all = [rows[0]?.source_event_id, ...(rows[0]?.grouped_event_ids as string[])];
    expect(all.sort()).toEqual(events.map((event) => event.eventId).sort());
  });

  it('[FA-01] sem responsável: membros ativos da unidade, nunca o ator nem vínculo suspenso', async () => {
    const event = devolvido(null, '0192f0a0-0000-7000-8000-0000000c0f04');
    await dispatcherWith().handle({ envelope: event }, contextFor(TENANT_A));
    const recipients = (await rowsOf(TENANT_A))
      .filter((row) => row.source_event_id === event.eventId)
      .map((row) => row.recipient_id);
    expect(recipients.sort()).toEqual([CARLA, BRUNO].sort());
  });

  it('[RN-NTF-05] notifications.emailEnabled = false no tenant → SKIPPED', async () => {
    await db.admin(
      `INSERT INTO tenant_settings (id, tenant_id, key, value)
       VALUES ('0192f0a0-0000-7000-8000-0000000c5001', $1, 'notifications.emailEnabled', 'false')`,
      [TENANT_A],
    );
    try {
      const emails: string[] = [];
      const event = envelope('ProcessAssigned', { assignmentType: 'MANUAL', toUserId: CARLA });
      await dispatcherWith({ emails }).handle({ envelope: event }, contextFor(TENANT_A));
      const [row] = (await rowsOf(TENANT_A)).filter((r) => r.source_event_id === event.eventId);
      expect(row?.email_status).toBe('SKIPPED');
      expect(emails).toEqual([]);
    } finally {
      await db.admin(`DELETE FROM tenant_settings WHERE key = 'notifications.emailEnabled'`);
    }
  });

  it('[Falha de banco] erro no meio da transação: nenhuma notificação parcial e o job falha', async () => {
    const event = devolvido(null, '0192f0a0-0000-7000-8000-0000000c0f05');
    let calls = 0;
    // A 2ª gravação falha (como o banco caindo no meio): a 1ª, já gravada, é desfeita.
    const flaky = new (class extends NotificationStore {
      override async upsertGrouped(...args: Parameters<NotificationStore['upsertGrouped']>) {
        calls += 1;
        const outcome = await super.upsertGrouped(...args);
        if (calls === 2)
          throw Object.assign(new Error('terminating connection'), { code: '57P01' });
        return outcome;
      }
    })();
    await expect(
      dispatcherWith({ store: flaky }).handle({ envelope: event }, contextFor(TENANT_A)),
    ).rejects.toMatchObject({ code: '57P01' });
    expect(calls).toBe(2);
    expect((await rowsOf(TENANT_A)).filter((row) => row.source_event_id === event.eventId)).toEqual(
      [],
    );
    // A repetição do job (política da fila) grava normalmente.
    await dispatcherWith().handle({ envelope: event }, contextFor(TENANT_A));
    expect(
      (await rowsOf(TENANT_A)).filter((row) => row.source_event_id === event.eventId),
    ).toHaveLength(2);
  });

  it('[Tenant incorreto] job da Prefeitura A nunca lê nem agrupa com notificação de B', async () => {
    const before = await digestOfB();
    // Mesmo processo e destinatário "de B" no payload: B não é vínculo de A → nada é gravado.
    const event = envelope(
      'CommentCreated',
      { commentId: eventId(), parentId: eventId(), parentAuthorId: BETO_B },
      { processId: PROCESSO_B },
    );
    await expect(dispatcherWith().handle({ envelope: event }, contextFor(TENANT_A))).resolves.toBe(
      'skipped',
    );
    expect(await digestOfB()).toBe(before);
    // Pela RLS, o worker no tenant A não enxerga as linhas de B.
    const visible = await worker.tenantTransaction(TENANT_A, (client) =>
      client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notifications WHERE tenant_id = $1',
        [TENANT_B],
      ),
    );
    expect(visible.rows[0]?.n).toBe('0');
  });

  it('RLS/GRANT: gravar em outro tenant é recusado; a API (cf_app) não insere nem muda o conteúdo', async () => {
    const write = {
      tenantId: TENANT_B,
      recipientId: BETO_B,
      type: 'COMMENT_REPLY' as const,
      priority: 'NORMAL' as const,
      link: null,
      processId: null,
      entityType: null,
      entityId: null,
      sourceEventId: eventId(),
      groupKey: null,
      content: (): NotificationContent => ({ title: 'x', body: 'y' }),
      emailStatus: 'NOT_APPLICABLE' as const,
      now: T0,
    };
    await expect(
      worker.tenantTransaction(TENANT_A, (client) =>
        new NotificationStore().upsertGrouped(client, write),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    const app = createWorkerDatabase({ url: db.url('cf_app') });
    try {
      await expect(
        app.tenantTransaction(TENANT_B, (client) =>
          new NotificationStore().upsertGrouped(client, write),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.tenantTransaction(TENANT_B, (client) =>
          client.query("UPDATE notifications SET title = 'adulterado'"),
        ),
      ).rejects.toThrow(/permission denied/i);
      const marked = await app.tenantTransaction(TENANT_B, (client) =>
        client.query('UPDATE notifications SET read_at = now() WHERE recipient_id = $1', [BETO_B]),
      );
      expect(marked.rowCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('identidade da notificação é imutável e o link precisa ser relativo (constraints)', async () => {
    await expect(
      db.admin(
        `UPDATE notifications SET source_event_id = '0192f0a0-0000-7000-8000-0000000c9999' WHERE tenant_id = $1`,
        [TENANT_B],
      ),
    ).rejects.toThrow(/imutáveis/);
    await expect(
      db.admin(
        `INSERT INTO notifications (id, tenant_id, recipient_id, type, title, body, link, source_event_id)
         VALUES ('0192f0a0-0000-7000-8000-0000000c3b02', $1, $2, 'COMMENT_REPLY', 't', 'b',
                 'https://evil.test/x', '0192f0a0-0000-7000-8000-0000000c4b02')`,
        [TENANT_B, BETO_B],
      ),
    ).rejects.toThrow(/notifications_link_relative/);
  });
});

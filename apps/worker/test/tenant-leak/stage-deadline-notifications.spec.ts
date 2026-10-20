// Lembretes de prazo e alertas de atraso (US-114) sobre PostgreSQL real, com o papel `cf_worker`
// (sem BYPASSRLS): o job `deadlines` (US-055) varre as passagens e grava `ProcessStageDueSoon`/
// `ProcessStageOverdue` no outbox; os envelopes desses eventos alimentam o `NotificationDispatcher`
// com o diretório, as preferências e a fonte de detalhes da etapa reais. Prova quem recebe
// (responsável, titular, ambos, a mesma pessoa uma vez só, ninguém), o texto com o nome da etapa e
// as datas no fuso do tenant, a reentrega e o despacho concorrente sem duplicar, a transação única
// sob falha do banco, o e-mail PENDING com a fila fora e que nada do tenant B chega ao tenant A.
// Processos, etapas e passagens vêm por SQL com as FKs desligadas (`session_replication_role`).
import type { DomainEventEnvelope, JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DeadlineScanner } from '../../src/deadlines/deadline-scanner.js';
import { NotificationDispatcher } from '../../src/notifications/notification-dispatcher.js';
import { NotificationStore } from '../../src/notifications/notification-store.js';
import type { ProcessVisibility } from '../../src/notifications/recipient-resolver.js';
import { SqlNotificationDirectory } from '../../src/notifications/sql-notification-directory.js';
import { SqlNotificationPreferences } from '../../src/notifications/sql-notification-preferences.js';
import { SqlStageDeadlineSource } from '../../src/notifications/stage-deadline.js';
import { PermanentJobError } from '../../src/queues/job-errors.js';
import type { JobHandlerContext } from '../../src/queues/run-job.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, jobMeta, seedQueueFixtures } from '../support/queue-fixtures.js';

const FABIO = '0192f114-0000-7000-8000-0000000000f1';
const HELENA = '0192f114-0000-7000-8000-0000000000f2';
const BETO_B = '0192f114-0000-7000-8000-0000000000b1';
const ORGAO = '0192f114-0000-7000-8000-0000000000e1';
const ORGAO_B = '0192f114-0000-7000-8000-0000000000eb';
const OBRAS = '0192f114-0000-7000-8000-0000000000d1';
const SEM_TITULAR = '0192f114-0000-7000-8000-0000000000d2';
const CHEFIA_FABIO = '0192f114-0000-7000-8000-0000000000d3';
const OBRAS_B = '0192f114-0000-7000-8000-0000000000db';
const STAGE_DEF_A = '0192f114-0000-7000-8000-0000000000c1';
const STAGE_DEF_B = '0192f114-0000-7000-8000-0000000000cb';
const ANY = '0192f114-0000-7000-8000-0000000000ff';

/** Uma passagem ativa por processo; um processo por cenário (o agrupamento é por processo). */
const CASES = {
  sucesso: {
    process: '0192f114-0000-7000-8000-000000000a01',
    pass: '0192f114-0000-7000-8000-000000000b01',
  },
  semDestinatario: {
    process: '0192f114-0000-7000-8000-000000000a02',
    pass: '0192f114-0000-7000-8000-000000000b02',
  },
  semVisibilidade: {
    process: '0192f114-0000-7000-8000-000000000a03',
    pass: '0192f114-0000-7000-8000-000000000b03',
  },
  mesmaPessoa: {
    process: '0192f114-0000-7000-8000-000000000a04',
    pass: '0192f114-0000-7000-8000-000000000b04',
  },
  aVencer: {
    process: '0192f114-0000-7000-8000-000000000a05',
    pass: '0192f114-0000-7000-8000-000000000b05',
  },
  bancoFora: {
    process: '0192f114-0000-7000-8000-000000000a06',
    pass: '0192f114-0000-7000-8000-000000000b06',
  },
  filaFora: {
    process: '0192f114-0000-7000-8000-000000000a07',
    pass: '0192f114-0000-7000-8000-000000000b07',
  },
  tenantB: {
    process: '0192f114-0000-7000-8000-000000000a0b',
    pass: '0192f114-0000-7000-8000-000000000b0b',
  },
} as const;

// Segunda 19/10/2026, 12:00 em São Paulo.
const NOW = new Date('2026-10-19T15:00:00.000Z');
const endOf = (date: string) => `${date}T23:59:59.999-03:00`;

let db: TestPostgres;
let worker: WorkerDatabase;

const processSql = (id: string, tenantId: string) => `
  INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
    requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
    origin_id, pca_status, created_by_id)
  VALUES ('${id}', '${tenantId}', '${ANY}', 2026, 'Processo de obras', 'Objeto do processo de obras', '${ANY}', '${ANY}', '${ANY}',
    '${ANY}', '${ANY}', '${ANY}', 'NOT_APPLICABLE', '${ANY}');`;

const stageDefinitionSql = (id: string, tenantId: string, name: string) => `
  INSERT INTO workflow_stages (id, tenant_id, workflow_version_id, key, name, type, display_order,
    department_resolution)
  VALUES ('${id}', '${tenantId}', '${ANY}', 'ANALISE_JURIDICA', '${name}', 'TASK', 1,
    'REQUESTING_DEPARTMENT');`;

let sequence = 0;
function passSql(
  key: keyof typeof CASES,
  options: { assignee: string | null; department: string; due: string; tenantId?: string },
): string {
  sequence += 1;
  const { process, pass } = CASES[key];
  const tenantId = options.tenantId ?? TENANT_A;
  return `
  ${processSql(process, tenantId)}
  INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, department_id,
    assignee_id, entered_at, due_at, sla_days, sla_type)
  VALUES ('${pass}', '${tenantId}', '${process}', '${tenantId === TENANT_A ? STAGE_DEF_A : STAGE_DEF_B}',
    ${String(sequence)}, '${options.department}', ${options.assignee ? `'${options.assignee}'` : 'NULL'},
    '2026-10-12T12:00:00Z', '${options.due}', 5, 'BUSINESS');`;
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    INSERT INTO users (id, external_subject, email, name, status) VALUES
      ('${FABIO}', 'sub-fabio-114', 'fabio@prazo.test', 'Fábio', 'ACTIVE'),
      ('${HELENA}', 'sub-helena-114', 'helena@prazo.test', 'Helena', 'ACTIVE'),
      ('${BETO_B}', 'sub-beto-114', 'beto@prazo.test', 'Beto LEAK-B', 'ACTIVE');
    INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
      ('0192f114-0000-7000-8000-000000001001', '${TENANT_A}', '${FABIO}', 'INTERNAL', 'ACTIVE'),
      ('0192f114-0000-7000-8000-000000001002', '${TENANT_A}', '${HELENA}', 'INTERNAL', 'ACTIVE'),
      ('0192f114-0000-7000-8000-0000000010b1', '${TENANT_B}', '${BETO_B}', 'INTERNAL', 'ACTIVE');
    INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type) VALUES
      ('${ORGAO}', '${TENANT_A}', 'Prefeitura de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION'),
      ('${ORGAO_B}', '${TENANT_B}', 'Prefeitura B', 'PMB', '11444777000161', 'DIRECT_ADMINISTRATION');
    SET session_replication_role = replica;
    INSERT INTO departments (id, tenant_id, organization_id, type, name, path, depth, head_user_id) VALUES
      ('${OBRAS}', '${TENANT_A}', '${ORGAO}', 'SECRETARIAT', 'Secretaria de Obras', '/${OBRAS}/', 0, '${HELENA}'),
      ('${SEM_TITULAR}', '${TENANT_A}', '${ORGAO}', 'SECTOR', 'Sem titular', '/${SEM_TITULAR}/', 0, NULL),
      ('${CHEFIA_FABIO}', '${TENANT_A}', '${ORGAO}', 'SECTOR', 'Jurídico', '/${CHEFIA_FABIO}/', 0, '${FABIO}'),
      ('${OBRAS_B}', '${TENANT_B}', '${ORGAO_B}', 'SECRETARIAT', 'Obras B', '/${OBRAS_B}/', 0, '${BETO_B}');
    ${stageDefinitionSql(STAGE_DEF_A, TENANT_A, 'Análise jurídica')}
    ${stageDefinitionSql(STAGE_DEF_B, TENANT_B, 'Etapa LEAK-B')}
    ${passSql('sucesso', { assignee: FABIO, department: OBRAS, due: endOf('2026-10-16') })}
    ${passSql('semDestinatario', { assignee: null, department: SEM_TITULAR, due: endOf('2026-10-16') })}
    ${passSql('semVisibilidade', { assignee: FABIO, department: OBRAS, due: endOf('2026-10-16') })}
    ${passSql('mesmaPessoa', { assignee: FABIO, department: CHEFIA_FABIO, due: endOf('2026-10-16') })}
    ${passSql('aVencer', { assignee: FABIO, department: OBRAS, due: endOf('2026-10-21') })}
    ${passSql('bancoFora', { assignee: FABIO, department: OBRAS, due: endOf('2026-10-16') })}
    ${passSql('filaFora', { assignee: null, department: OBRAS, due: endOf('2026-10-16') })}
    ${passSql('tenantB', { assignee: BETO_B, department: OBRAS_B, due: endOf('2026-10-16'), tenantId: TENANT_B })}
    SET session_replication_role = origin;
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
  // O job `deadlines` (US-055) dos dois tenants produz os eventos consumidos aqui.
  const scanner = new DeadlineScanner({ database: worker, now: () => NOW });
  for (const tenantId of [TENANT_A, TENANT_B]) {
    expect(await scanner.handle({}, contextFor(tenantId, 'deadlines'))).toBe('completed');
  }
}, 180_000);

afterAll(async () => {
  await worker.close();
  await db.stop();
});

function contextFor(tenantId: string, queue: 'deadlines' | 'notifications' = 'notifications') {
  const meta: JobMeta = jobMeta(tenantId, { correlationId: 'scheduler:deadlines-tick' });
  const logger = new Logger(`US-114:${queue}`);
  return {
    meta,
    queue,
    jobName: queue === 'deadlines' ? 'scan-tenant' : 'event',
    jobId: 'job',
    attempt: 1,
    maxAttempts: 5,
    signal: new AbortController().signal,
    logger,
    tenantTransaction: (work) => worker.tenantTransaction(tenantId, work),
    platformTransaction: () => Promise.reject(new Error('não usado')),
  } satisfies JobHandlerContext;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  routing_key: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  process_id: string;
  payload: Record<string, unknown>;
  metadata: {
    actor: DomainEventEnvelope['actor'];
    correlationId: string;
    causationId: string | null;
  };
  occurred_at: Date;
}

const outbox = () =>
  db.admin<OutboxRow>(
    `SELECT id, tenant_id, event_type, routing_key, event_version, aggregate_type, aggregate_id,
            process_id, payload, metadata, occurred_at
       FROM outbox_events
      WHERE event_type IN ('ProcessStageDueSoon', 'ProcessStageOverdue')
      ORDER BY id`,
  );

/** O envelope que o relay publica e o fan-out entrega à fila `notifications` (events.md §3). */
async function eventOf(
  key: keyof typeof CASES,
): Promise<DomainEventEnvelope<Record<string, unknown>>> {
  const row = (await outbox()).find((item) => item.payload.processStageId === CASES[key].pass);
  if (!row) throw new Error(`sem evento para ${key}`);
  return {
    eventId: row.id,
    eventType: row.event_type,
    routingKey: row.routing_key,
    eventVersion: row.event_version,
    occurredAt: row.occurred_at.toISOString(),
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    processId: row.process_id,
    actor: row.metadata.actor,
    correlationId: row.metadata.correlationId,
    causationId: row.metadata.causationId,
    payload: row.payload,
  };
}

/** `ProcessAccess`/perfis estão fora deste teste (cobertos em process-visibility.spec.ts). */
const visibility: ProcessVisibility = {
  visibleTo: (_client, processId, userIds) =>
    Promise.resolve(
      new Set(
        userIds.filter(
          (userId) => !(processId === CASES.semVisibilidade.process && userId === FABIO),
        ),
      ),
    ),
};

function dispatcherWith(
  options: { emails?: string[]; store?: NotificationStore; failEmail?: () => boolean } = {},
) {
  return new NotificationDispatcher({
    directory: new SqlNotificationDirectory(),
    preferences: new SqlNotificationPreferences(),
    stageDeadlines: new SqlStageDeadlineSource(),
    visibility,
    email: {
      enqueue: (notificationId) => {
        if (options.failEmail?.()) return Promise.reject(new Error('fila email indisponível'));
        options.emails?.push(notificationId);
        return Promise.resolve();
      },
    },
    ...(options.store ? { store: options.store } : {}),
    now: () => NOW,
  });
}

async function dispatch(
  key: keyof typeof CASES,
  options: Parameters<typeof dispatcherWith>[0] = {},
  tenantId: string = TENANT_A,
) {
  const event = await eventOf(key);
  const dispatcher = dispatcherWith(options);
  // O payload do job é validado como na fila (envelope do outbox é aceito como está).
  expect(dispatcher.payloadSchema.safeParse({ envelope: event }).success).toBe(true);
  return dispatcher.handle({ envelope: event }, contextFor(tenantId));
}

const rowsOf = async (key: keyof typeof CASES) => {
  const event = await eventOf(key);
  return db.admin<{
    tenant_id: string;
    recipient_id: string;
    type: string;
    title: string;
    body: string;
    link: string;
    entity_type: string;
    entity_id: string;
    email_status: string;
  }>(
    `SELECT tenant_id, recipient_id, type, title, body, link, entity_type, entity_id,
            email_status::text AS email_status
       FROM notifications WHERE source_event_id = $1 ORDER BY recipient_id`,
    [event.eventId],
  );
};

const recipientsOf = async (key: keyof typeof CASES) =>
  (await rowsOf(key)).map((row) => [row.recipient_id, row.type, row.email_status]);

describe('Lembretes de prazo e alertas de atraso sobre PostgreSQL (US-114)', () => {
  it('[Sucesso] atraso notifica Fábio (responsável) e Helena (titular) por in-app e e-mail', async () => {
    const emails: string[] = [];
    await expect(dispatch('sucesso', { emails })).resolves.toBe('completed');
    const rows = await rowsOf('sucesso');
    expect(rows.map((row) => [row.recipient_id, row.type, row.email_status])).toEqual(
      [FABIO, HELENA].sort().map((userId) => [userId, 'STAGE_OVERDUE', 'PENDING']),
    );
    expect(emails).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT_A,
      title: 'Prazo da etapa vencido',
      link: `/processos/${CASES.sucesso.process}`,
      entity_type: 'ProcessStage',
      entity_id: CASES.sucesso.pass,
    });
    // Nome da etapa e datas no fuso do tenant (America/Sao_Paulo): venceu na sexta 16/10 e o
    // atraso foi registrado pelo job às 12:00 da segunda.
    expect(rows[0]?.body).toBe(
      'O prazo da etapa “Análise jurídica” terminou em 16/10/2026; o atraso foi registrado em 19/10/2026 às 12:00. Abra o processo para regularizar.',
    );
  });

  it('[Sucesso] vencimento próximo vai só ao responsável, sem e-mail por padrão', async () => {
    const emails: string[] = [];
    await expect(dispatch('aVencer', { emails })).resolves.toBe('completed');
    expect(await recipientsOf('aVencer')).toEqual([[FABIO, 'STAGE_DUE_SOON', 'NOT_APPLICABLE']]);
    expect(emails).toEqual([]);
    expect((await rowsOf('aVencer'))[0]?.body).toBe(
      'O prazo da etapa “Análise jurídica” termina em 21/10/2026. Abra o processo para dar andamento.',
    );
  });

  it('[Validação] sem responsável e unidade sem titular: nenhuma notificação, log warn', async () => {
    const context = contextFor(TENANT_A);
    const warn = vi.spyOn(context.logger, 'warn');
    const event = await eventOf('semDestinatario');
    await expect(dispatcherWith().handle({ envelope: event }, context)).resolves.toBe('skipped');
    expect(await rowsOf('semDestinatario')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.deadline_recipient_missing',
        processStageId: CASES.semDestinatario.pass,
        notificationType: 'STAGE_OVERDUE',
      }),
    );
  });

  it('[Permissão] Fábio sem visibilidade do processo não recebe; Helena recebe normalmente', async () => {
    await expect(dispatch('semVisibilidade')).resolves.toBe('completed');
    expect(await recipientsOf('semVisibilidade')).toEqual([[HELENA, 'STAGE_OVERDUE', 'PENDING']]);
  });

  it('[Tenant incorreto] a etapa atrasada de B só notifica B; nada de B chega a usuários de A', async () => {
    await expect(dispatch('tenantB', {}, TENANT_B)).resolves.toBe('completed');
    const rows = await rowsOf('tenantB');
    expect(rows.map((row) => [row.tenant_id, row.recipient_id])).toEqual([[TENANT_B, BETO_B]]);
    expect(rows[0]?.body).toContain('Etapa LEAK-B');
    const leaked = await db.admin(
      `SELECT id FROM notifications
        WHERE tenant_id = $1 AND (body LIKE '%LEAK-B%' OR process_id = $2 OR recipient_id = $3)`,
      [TENANT_A, CASES.tenantB.process, BETO_B],
    );
    expect(leaked).toEqual([]);
    // O evento de B entregue a um job de A é recusado (nunca despachado com a RLS de A).
    const eventB = await eventOf('tenantB');
    await expect(
      dispatcherWith().handle({ envelope: eventB }, contextFor(TENANT_A)),
    ).rejects.toBeInstanceOf(PermanentJobError);
    // V-03: a passagem de B não é legível pela RLS de A.
    const details = await worker.tenantTransaction(TENANT_A, (client) =>
      new SqlStageDeadlineSource().details(client, TENANT_B, CASES.tenantB.pass),
    );
    expect(details.stageName).toBeNull();
  });

  it('[Duplicidade] reentrega e novo ciclo do job 15 min depois não criam outra notificação', async () => {
    const before = await rowsOf('sucesso');
    expect(before).toHaveLength(2);
    await expect(dispatch('sucesso')).resolves.toBe('completed');
    const eventsBefore = await outbox();
    const later = new DeadlineScanner({
      database: worker,
      now: () => new Date(NOW.getTime() + 15 * 60_000),
    });
    expect(await later.handle({}, contextFor(TENANT_A, 'deadlines'))).toBe('completed');
    expect(await outbox()).toEqual(eventsBefore);
    expect(await rowsOf('sucesso')).toEqual(before);
    expect(
      await db.admin(
        `SELECT id FROM notifications WHERE recipient_id = $1 AND type = 'STAGE_OVERDUE'
            AND process_id = $2`,
        [FABIO, CASES.sucesso.process],
      ),
    ).toHaveLength(1);
  });

  it('[Concorrência] Fábio responsável e titular: uma notificação, mesmo com despachos simultâneos', async () => {
    const event = await eventOf('mesmaPessoa');
    const results = await Promise.all([
      dispatcherWith().handle({ envelope: event }, contextFor(TENANT_A)),
      dispatcherWith().handle({ envelope: event }, contextFor(TENANT_A)),
    ]);
    expect(results).toContain('completed');
    expect(await recipientsOf('mesmaPessoa')).toEqual([[FABIO, 'STAGE_OVERDUE', 'PENDING']]);
  });

  it('[Falha de banco] falha no meio do despacho: nada gravado, o retry da fila entrega aos dois', async () => {
    class FailingStore extends NotificationStore {
      calls = 0;
      override upsertGrouped(...args: Parameters<NotificationStore['upsertGrouped']>) {
        this.calls += 1;
        if (this.calls === 2) {
          return Promise.reject(
            Object.assign(new Error('terminating connection'), { code: '57P01' }),
          );
        }
        return super.upsertGrouped(...args);
      }
    }
    await expect(dispatch('bancoFora', { store: new FailingStore() })).rejects.toThrow(
      'terminating connection',
    );
    expect(await rowsOf('bancoFora')).toEqual([]);
    await expect(dispatch('bancoFora')).resolves.toBe('completed');
    expect((await recipientsOf('bancoFora')).map(([userId]) => userId)).toEqual(
      [FABIO, HELENA].sort(),
    );
  });

  it('[Falha de integração] fila email fora: in-app criada e e-mail PENDING até a fila voltar', async () => {
    await expect(dispatch('filaFora', { failEmail: () => true })).rejects.toThrow(
      'fila email indisponível',
    );
    expect(await recipientsOf('filaFora')).toEqual([[HELENA, 'STAGE_OVERDUE', 'PENDING']]);
    const emails: string[] = [];
    await expect(dispatch('filaFora', { emails })).resolves.toBe('completed');
    expect(await recipientsOf('filaFora')).toEqual([[HELENA, 'STAGE_OVERDUE', 'PENDING']]);
    expect(emails).toHaveLength(1);
  });
});

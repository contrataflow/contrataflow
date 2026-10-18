// Job `deadlines` (US-055 · RN-TRAM-81..85) sobre PostgreSQL real, com o papel `cf_worker` (sem
// BYPASSRLS): a varredura de A usa só o calendário de A (o feriado municipal de B na mesma semana
// não entra na contagem), marca `overdueSince`/`dueSoonNotifiedAt` só das passagens de A, grava a
// timeline `STAGE_OVERDUE` e os eventos `PENDING` no outbox na mesma transação, não reemite no
// ciclo seguinte e, com duas instâncias no mesmo ciclo, só uma obtém a trava. Processos, etapas e
// passagens vêm por SQL com as FKs desligadas (`session_replication_role`): o que se prova aqui é
// o job, não o agregado.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DeadlineScanner } from '../../src/deadlines/deadline-scanner.js';
import type { HandlerResult, JobHandlerContext } from '../../src/queues/run-job.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, jobMeta, seedQueueFixtures } from '../support/queue-fixtures.js';

// Uma passagem ativa por processo (índice único parcial): um processo por passagem.
const PROCESS_A = '0192f055-0000-7000-8000-0000000000a1';
const PROCESS_A2 = '0192f055-0000-7000-8000-0000000000a3';
const PROCESS_A3 = '0192f055-0000-7000-8000-0000000000a4';
const PROCESS_B = '0192f055-0000-7000-8000-0000000000b1';
const STAGE_DEF_A = '0192f055-0000-7000-8000-0000000000a2';
const STAGE_DEF_B = '0192f055-0000-7000-8000-0000000000b2';
const LATE_A = '0192f055-0000-7000-8000-0000000000d1';
const WEDNESDAY_A = '0192f055-0000-7000-8000-0000000000d2';
const FRIDAY_A = '0192f055-0000-7000-8000-0000000000d3';
const LATE_B = '0192f055-0000-7000-8000-0000000000d4';
const DEPARTMENT = '0192f055-0000-7000-8000-0000000000e1';
const ANY = '0192f055-0000-7000-8000-0000000000ff';
// Segunda 19/10/2026, 12:00 em São Paulo.
const NOW = new Date('2026-10-19T15:00:00.000Z');
const endOf = (date: string) => `${date}T23:59:59.999-03:00`;

let db: TestPostgres;
let worker: WorkerDatabase;

const processSql = (id: string, tenantId: string) => `
  INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
    requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
    origin_id, pca_status, created_by_id)
  VALUES ('${id}', '${tenantId}', '${ANY}', 2026, 'Processo', 'Objeto', '${ANY}', '${ANY}', '${ANY}',
    '${ANY}', '${ANY}', '${ANY}', 'NOT_APPLICABLE', '${ANY}');`;

const stageDefinitionSql = (id: string, tenantId: string) => `
  INSERT INTO workflow_stages (id, tenant_id, workflow_version_id, key, name, type, display_order,
    department_resolution)
  VALUES ('${id}', '${tenantId}', '${ANY}', 'estudos_preliminares', 'Estudos preliminares', 'TASK',
    1, 'REQUESTING_DEPARTMENT');`;

let sequence = 0;
const passSql = (id: string, tenantId: string, processId: string, stageId: string, due: string) => {
  sequence += 1;
  return `
  INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, department_id,
    entered_at, due_at, sla_days, sla_type)
  VALUES ('${id}', '${tenantId}', '${processId}', '${stageId}', ${String(sequence)}, '${DEPARTMENT}',
    '2026-10-12T12:00:00Z', '${due}', 5, 'BUSINESS');`;
};

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    SET session_replication_role = replica;
    ${processSql(PROCESS_A, TENANT_A)}
    ${processSql(PROCESS_A2, TENANT_A)}
    ${processSql(PROCESS_A3, TENANT_A)}
    ${processSql(PROCESS_B, TENANT_B)}
    ${stageDefinitionSql(STAGE_DEF_A, TENANT_A)}
    ${stageDefinitionSql(STAGE_DEF_B, TENANT_B)}
    ${passSql(LATE_A, TENANT_A, PROCESS_A, STAGE_DEF_A, endOf('2026-10-16'))}
    ${passSql(WEDNESDAY_A, TENANT_A, PROCESS_A2, STAGE_DEF_A, endOf('2026-10-21'))}
    ${passSql(FRIDAY_A, TENANT_A, PROCESS_A3, STAGE_DEF_A, endOf('2026-10-23'))}
    ${passSql(LATE_B, TENANT_B, PROCESS_B, STAGE_DEF_B, endOf('2026-10-16'))}
    SET session_replication_role = origin;
    INSERT INTO holidays (id, tenant_id, date, name, scope) VALUES
      (gen_random_uuid(), '${TENANT_A}', '2026-10-22', 'Feriado nacional de teste', 'NATIONAL'),
      (gen_random_uuid(), '${TENANT_B}', '2026-10-20', 'Aniversário da cidade B', 'MUNICIPAL');
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

function contextFor(tenantId: string): JobHandlerContext {
  return {
    meta: jobMeta(tenantId, { correlationId: 'scheduler:deadlines-tick' }),
    queue: 'deadlines',
    jobName: 'scan-tenant',
    jobId: `deadlines.${tenantId}`,
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    logger: new Logger('deadlines:scan-tenant'),
    tenantTransaction: (work) => worker.tenantTransaction(tenantId, work),
    platformTransaction: () => Promise.reject(new Error('sem plataforma')),
  };
}

const passState = (id: string) =>
  db.admin<{ overdue: boolean; overdue_notified: boolean; due_soon: boolean }>(
    `SELECT overdue_since IS NOT NULL AS overdue, overdue_notified_at IS NOT NULL AS overdue_notified,
            due_soon_notified_at IS NOT NULL AS due_soon
       FROM process_stages WHERE id = $1`,
    [id],
  );

const events = () =>
  db.admin<{
    tenant_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    status: string;
  }>(
    `SELECT tenant_id, event_type, payload, status::text AS status FROM outbox_events
      WHERE event_type IN ('ProcessStageDueSoon', 'ProcessStageOverdue')
      ORDER BY event_type, payload->>'processStageId'`,
  );

describe('DeadlineScanner sobre PostgreSQL (US-055)', () => {
  it('[Tenant incorreto] varre só A, com o calendário de A; o feriado municipal de B não entra no cálculo', async () => {
    const scanner = new DeadlineScanner({ database: worker, now: () => NOW });
    expect(await scanner.handle({}, contextFor(TENANT_A))).toBe('completed');

    expect(await passState(LATE_A)).toEqual([
      { overdue: true, overdue_notified: true, due_soon: false },
    ]);
    expect(await passState(WEDNESDAY_A)).toEqual([
      { overdue: false, overdue_notified: false, due_soon: true },
    ]);
    // Com o feriado de B (terça), a sexta também "venceria em breve" — não pode.
    expect(await passState(FRIDAY_A)).toEqual([
      { overdue: false, overdue_notified: false, due_soon: false },
    ]);
    expect(await passState(LATE_B)).toEqual([
      { overdue: false, overdue_notified: false, due_soon: false },
    ]);

    expect(await events()).toEqual([
      {
        tenant_id: TENANT_A,
        event_type: 'ProcessStageDueSoon',
        payload: expect.objectContaining({
          processStageId: WEDNESDAY_A,
          stageKey: 'estudos_preliminares',
          businessDaysLeft: 2,
          departmentId: DEPARTMENT,
        }) as unknown,
        status: 'PENDING',
      },
      {
        tenant_id: TENANT_A,
        event_type: 'ProcessStageOverdue',
        payload: expect.objectContaining({
          processStageId: LATE_A,
          overdueSince: NOW.toISOString(),
        }) as unknown,
        status: 'PENDING',
      },
    ]);
    expect(
      await db.admin(
        `SELECT type, actor_type::text AS actor_type, entity_type, entity_id, params
           FROM process_timeline_entries WHERE type = 'STAGE_OVERDUE'`,
      ),
    ).toEqual([
      {
        type: 'STAGE_OVERDUE',
        actor_type: 'SYSTEM',
        entity_type: 'ProcessStage',
        entity_id: LATE_A,
        params: {
          stageName: 'Estudos preliminares',
          stageKey: 'estudos_preliminares',
          dueAt: new Date(endOf('2026-10-16')).toISOString(),
        },
      },
    ]);
    expect(
      await db.admin<{ id: string; overdue: boolean }>(
        'SELECT id, overdue_since IS NOT NULL AS overdue FROM processes ORDER BY id',
      ),
    ).toEqual([
      { id: PROCESS_A, overdue: true },
      { id: PROCESS_A2, overdue: false },
      { id: PROCESS_A3, overdue: false },
      { id: PROCESS_B, overdue: false },
    ]);
  });

  it('[Duplicidade] o ciclo seguinte não reemite aviso nem atraso para as mesmas passagens', async () => {
    const before = await events();
    const later = new DeadlineScanner({
      database: worker,
      now: () => new Date(NOW.getTime() + 15 * 60_000),
    });
    expect(await later.handle({}, contextFor(TENANT_A))).toBe('completed');
    expect(await events()).toEqual(before);
  });

  it('[Concorrência] duas instâncias no mesmo ciclo: só uma obtém a trava e processa o lote de B', async () => {
    const second = new DeadlineScanner({ database: worker, now: () => NOW });
    let secondResult: HandlerResult | undefined;
    // A primeira instância segura a trava enquanto a segunda tenta o mesmo ciclo.
    const first = new DeadlineScanner({
      now: () => NOW,
      database: {
        withAdvisoryLock: (key, work) =>
          worker.withAdvisoryLock(key, async () => {
            secondResult = await second.handle({}, contextFor(TENANT_B));
            return work();
          }),
      },
    });

    expect(await first.handle({}, contextFor(TENANT_B))).toBe('completed');
    expect(secondResult).toBe('skipped');
    const fromB = (await events()).filter((event) => event.tenant_id === TENANT_B);
    expect(fromB.map((event) => event.event_type)).toEqual(['ProcessStageOverdue']);
  });
});

import { DOMAIN_EVENT_DEFINITIONS } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';
import type { AdvisoryLockResult } from '#shared/database/worker-database.js';

import { DeadlineScanner } from './deadline-scanner.js';
import type { JobHandlerContext } from '../queues/run-job.js';

const TENANT = '0192f055-0000-7000-8000-00000000000a';
const PROCESS = '0192f055-0000-7000-8000-0000000000b1';
const DEPARTMENT = '0192f055-0000-7000-8000-0000000000c1';
const ASSIGNEE = '0192f055-0000-7000-8000-0000000000c2';
// Segunda 19/10/2026, 12:00 em São Paulo; feriado nacional na quinta 22/10.
const NOW = new Date('2026-10-19T15:00:00.000Z');
const endOf = (date: string) => new Date(`${date}T23:59:59.999-03:00`);

interface FakeStage {
  readonly id: string;
  status: 'ACTIVE' | 'COMPLETED';
  dueAt: Date | null;
  pausedAt: Date | null;
  assigneeId: string | null;
  overdueSince: Date | null;
  overdueNotifiedAt: Date | null;
  dueSoonNotifiedAt: Date | null;
}

let sequence = 0;
function stage(overrides: Partial<FakeStage> = {}): FakeStage {
  sequence += 1;
  return {
    id: `0192f055-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    status: 'ACTIVE',
    dueAt: null,
    pausedAt: null,
    assigneeId: ASSIGNEE,
    overdueSince: null,
    overdueNotifiedAt: null,
    dueSoonNotifiedAt: null,
    ...overrides,
  };
}

interface OutboxRow {
  readonly eventType: string;
  readonly routingKey: string;
  readonly payload: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly status: 'PENDING';
}

/**
 * Banco falso do tenant: avalia as condições das instruções do scanner sobre as passagens em
 * memória — o que se prova é a regra (filtros, marcas e eventos), não o SQL em si (coberto pelo
 * teste sobre PostgreSQL em `test/tenant-leak`).
 */
function fakeDatabase(stages: FakeStage[], settings: Record<string, unknown> = {}) {
  const outbox: OutboxRow[] = [];
  const timeline: { params: Record<string, unknown>; sourceEventId: string }[] = [];
  const processesMarked: unknown[][] = [];
  let failOn: RegExp | null = null;
  const rowOf = (s: FakeStage) => ({
    id: s.id,
    process_id: PROCESS,
    due_at: s.dueAt,
    assignee_id: s.assigneeId,
    department_id: DEPARTMENT,
    stage_key: 'estudos_preliminares',
    stage_name: 'Estudos preliminares',
  });
  const eligible = (s: FakeStage) => s.status === 'ACTIVE' && s.pausedAt === null && s.dueAt;
  const dueOf = (s: FakeStage) => s.dueAt?.getTime() ?? Number.NaN;
  const query = (sql: string, params: readonly unknown[] = []) => {
    if (failOn?.test(sql)) return Promise.reject(new Error('connection terminated'));
    let rows: object[] = [];
    if (sql.includes('FROM tenants')) rows = [{ timezone: 'America/Sao_Paulo' }];
    else if (sql.includes('FROM tenant_settings')) {
      rows = Object.entries(settings).map(([key, value]) => ({ key, value }));
    } else if (sql.includes('FROM holidays')) {
      rows = [{ date: '2026-10-22', scope: 'NATIONAL', is_active: true }];
    } else if (sql.includes('count(*)')) {
      rows = [{ count: String(stages.filter(eligible).length) }];
    } else if (sql.includes('overdue_notified_at = $2')) {
      const now = params[1] as Date;
      const limit = params[2] as number;
      const picked = stages
        .filter((s) => eligible(s) && dueOf(s) < now.getTime() && s.overdueSince === null)
        .filter((s) => s.overdueNotifiedAt === null)
        .slice(0, limit);
      for (const s of picked) {
        s.overdueSince = now;
        s.overdueNotifiedAt = now;
      }
      rows = picked.map(rowOf);
    } else if (sql.includes('due_soon_notified_at = $2')) {
      const [, now, before, limit] = params as [string, Date, Date, number];
      const picked = stages
        .filter((s) => eligible(s) && dueOf(s) >= now.getTime() && dueOf(s) < before.getTime())
        .filter((s) => s.dueSoonNotifiedAt === null && s.overdueSince === null)
        .slice(0, limit);
      for (const s of picked) s.dueSoonNotifiedAt = now;
      rows = picked.map(rowOf);
    } else if (sql.includes('UPDATE processes')) {
      processesMarked.push([...params]);
    } else if (sql.includes('INSERT INTO outbox_events')) {
      outbox.push({
        eventType: params[2] as string,
        routingKey: params[3] as string,
        payload: JSON.parse(params[7] as string) as Record<string, unknown>,
        metadata: JSON.parse(params[8] as string) as Record<string, unknown>,
        status: 'PENDING',
      });
    } else if (sql.includes('INSERT INTO process_timeline_entries')) {
      timeline.push({
        params: JSON.parse(params[5] as string) as Record<string, unknown>,
        sourceEventId: params[6] as string,
      });
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  };
  const client = { query } as unknown as SqlClient;
  return {
    client,
    outbox,
    timeline,
    processesMarked,
    failWhen(pattern: RegExp | null) {
      failOn = pattern;
    },
  };
}

/** Trava consultiva em memória (como `pg_try_advisory_lock`: quem chega com ela tomada não espera). */
function memoryLocks() {
  const held = new Set<string>();
  return {
    async withAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<AdvisoryLockResult<T>> {
      if (held.has(key)) return { acquired: false };
      held.add(key);
      try {
        return { acquired: true, result: await work() };
      } finally {
        held.delete(key);
      }
    },
  };
}

function contextOf(client: SqlClient, tenantId: string | null = TENANT): JobHandlerContext {
  return {
    meta: {
      schemaVersion: 1,
      tenantId,
      actor: { type: 'SYSTEM', userId: null, membershipId: null },
      correlationId: 'scheduler:deadlines-tick',
      causationId: null,
      enqueuedAt: NOW.toISOString(),
    },
    queue: 'deadlines',
    jobName: 'scan-tenant',
    jobId: `deadlines.${TENANT}.1`,
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    logger: new Logger('deadlines:scan-tenant'),
    tenantTransaction: (work) => work(client),
    platformTransaction: () => Promise.reject(new Error('sem plataforma')),
  };
}

function scanner(options: { batchSize?: number; now?: () => Date } = {}) {
  return new DeadlineScanner({ database: memoryLocks(), now: () => NOW, ...options });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DeadlineScanner — deadlines.scan-tenant (US-055)', () => {
  it('[Sucesso] Job detecta o atraso e emite o evento uma única vez', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const late = stage({ dueAt: endOf('2026-10-16') });
    const db = fakeDatabase([late]);

    expect(await scanner().handle({}, contextOf(db.client))).toBe('completed');

    expect(late.overdueSince).toEqual(NOW);
    expect(late.overdueNotifiedAt).toEqual(NOW);
    expect(db.outbox).toEqual([
      {
        eventType: 'ProcessStageOverdue',
        routingKey: 'process.stage_overdue',
        payload: {
          processStageId: late.id,
          stageKey: 'estudos_preliminares',
          dueAt: endOf('2026-10-16').toISOString(),
          assigneeId: ASSIGNEE,
          departmentId: DEPARTMENT,
          overdueSince: NOW.toISOString(),
        },
        metadata: {
          actor: { type: 'SYSTEM', userId: null, membershipId: null },
          correlationId: 'scheduler:deadlines-tick',
          causationId: null,
        },
        status: 'PENDING',
      },
    ]);
    // O payload respeita o contrato registrado do evento.
    expect(() =>
      DOMAIN_EVENT_DEFINITIONS.ProcessStageOverdue?.resolve(db.outbox[0]?.payload),
    ).not.toThrow();
    // `processes.overdue_since` (desnormalizado) e a timeline `STAGE_OVERDUE` na mesma transação.
    expect(db.processesMarked).toEqual([[TENANT, NOW, [PROCESS]]]);
    expect(db.timeline).toEqual([
      {
        params: {
          stageName: 'Estudos preliminares',
          stageKey: 'estudos_preliminares',
          dueAt: endOf('2026-10-16').toISOString(),
        },
        sourceEventId: expect.any(String) as string,
      },
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'process.deadlines_job_run',
        tenantId: TENANT,
        scanned: 1,
        overdueEmitted: 1,
        dueSoonEmitted: 0,
        lockAcquired: true,
      }),
    );

    // Ciclo seguinte: nada de novo para a mesma etapa.
    await scanner({ now: () => new Date(NOW.getTime() + 15 * 60_000) }).handle(
      {},
      contextOf(db.client),
    );
    expect(db.outbox).toHaveLength(1);
    expect(late.overdueSince).toEqual(NOW);
  });

  it('vencimento próximo: 2 dias úteis ou menos (feriado de quinta não conta) emite ProcessStageDueSoon com businessDaysLeft', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const wednesday = stage({ dueAt: endOf('2026-10-21'), assigneeId: null });
    const thursday = stage({ dueAt: endOf('2026-10-22') });
    const friday = stage({ dueAt: endOf('2026-10-23') });
    const db = fakeDatabase([wednesday, thursday, friday]);

    await scanner().handle({}, contextOf(db.client));

    expect(db.outbox.map((event) => [event.eventType, event.payload])).toEqual([
      [
        'ProcessStageDueSoon',
        {
          processStageId: wednesday.id,
          stageKey: 'estudos_preliminares',
          dueAt: endOf('2026-10-21').toISOString(),
          assigneeId: null,
          departmentId: DEPARTMENT,
          businessDaysLeft: 2,
        },
      ],
      [
        'ProcessStageDueSoon',
        expect.objectContaining({ processStageId: thursday.id, businessDaysLeft: 2 }),
      ],
    ]);
    expect(friday.dueSoonNotifiedAt).toBeNull();
    expect(db.timeline).toEqual([]);
    for (const event of db.outbox) {
      expect(() =>
        DOMAIN_EVENT_DEFINITIONS.ProcessStageDueSoon?.resolve(event.payload),
      ).not.toThrow();
    }
  });

  it('[Duplicidade] Execuções repetidas do job não duplicam o aviso de vencimento próximo', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const notified = stage({
      dueAt: endOf('2026-10-21'),
      dueSoonNotifiedAt: new Date(NOW.getTime() - 60_000),
    });
    const db = fakeDatabase([notified]);

    await scanner().handle({}, contextOf(db.client));
    await scanner().handle({}, contextOf(db.client));

    expect(db.outbox).toEqual([]);
  });

  it('RN-TRAM-81: ignora passagens pausadas, encerradas e sem prazo (FA-01)', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const paused = stage({ dueAt: endOf('2026-10-16'), pausedAt: endOf('2026-10-10') });
    const closed = stage({ dueAt: endOf('2026-10-16'), status: 'COMPLETED' });
    const withoutDeadline = stage();
    const db = fakeDatabase([paused, closed, withoutDeadline]);

    await scanner().handle({}, contextOf(db.client));

    expect(db.outbox).toEqual([]);
    expect(paused.overdueSince).toBeNull();
  });

  it('FA-05: warnBeforeBusinessDays = 0 suprime o aviso antecipado, mas o atraso segue detectado', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const soon = stage({ dueAt: endOf('2026-10-20') });
    const late = stage({ dueAt: endOf('2026-10-16') });
    const db = fakeDatabase([soon, late], { 'deadlines.warnBeforeBusinessDays': 0 });

    await scanner().handle({}, contextOf(db.client));

    expect(db.outbox.map((event) => event.eventType)).toEqual(['ProcessStageOverdue']);
    expect(soon.dueSoonNotifiedAt).toBeNull();
  });

  it('lotes curtos: pagina o volume em transações de até batchSize passagens', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const stages = Array.from({ length: 5 }, () => stage({ dueAt: endOf('2026-10-16') }));
    const db = fakeDatabase(stages);
    const context = contextOf(db.client);
    const transactions = vi.spyOn(context, 'tenantTransaction');

    await scanner({ batchSize: 2 }).handle({}, context);

    expect(db.outbox).toHaveLength(5);
    // Calendário + 3 lotes de atraso (2, 2, 1) + 1 lote de aviso vazio.
    expect(transactions).toHaveBeenCalledTimes(5);
  });

  it('[Concorrência] Duas instâncias no mesmo ciclo: só uma obtém a trava e processa; nenhuma etapa é notificada duas vezes', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const late = stage({ dueAt: endOf('2026-10-16') });
    const db = fakeDatabase([late]);
    const locks = memoryLocks();
    const first = new DeadlineScanner({ database: locks, now: () => NOW });
    const second = new DeadlineScanner({ database: locks, now: () => NOW });

    const results = await Promise.all([
      first.handle({}, contextOf(db.client)),
      second.handle({}, contextOf(db.client)),
    ]);

    expect([...results].sort()).toEqual(['completed', 'skipped']);
    expect(db.outbox).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith({
      event: 'process.deadlines_lock_skipped',
      tenantId: TENANT,
    });
  });

  it('[Falha de banco] Banco indisponível: o ciclo falha sem marcar e o seguinte reavalia normalmente', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const late = stage({ dueAt: endOf('2026-10-16') });
    const db = fakeDatabase([late]);
    db.failWhen(/FROM process_stages/);

    await expect(scanner().handle({}, contextOf(db.client))).rejects.toThrow(
      'connection terminated',
    );
    expect(late.overdueSince).toBeNull();
    expect(db.outbox).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'process.deadlines_job_failed',
        tenantId: TENANT,
        errorCode: 'TRANSIENT',
      }),
    );

    db.failWhen(null);
    await scanner().handle({}, contextOf(db.client));
    expect(late.overdueSince).toEqual(NOW);
    expect(db.outbox).toHaveLength(1);
  });

  it('job sem tenant é ignorado', async () => {
    const db = fakeDatabase([]);
    expect(await scanner().handle({}, contextOf(db.client, null))).toBe('skipped');
  });
});

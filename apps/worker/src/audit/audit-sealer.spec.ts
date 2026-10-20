import { createHash } from 'node:crypto';

import type { JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';

import {
  AuditSealer,
  GENESIS_CHAIN_HASH,
  SEAL_GRACE_MS,
  chainHashOf,
  periodDigest,
} from './audit-sealer.js';
import { rowHashOf } from '../admin/platform-audit.js';
import type { AuditRow } from '../admin/platform-audit.js';
import { PermanentJobError } from '../queues/job-errors.js';
import { runJob } from '../queues/run-job.js';
import type { JobHandlerContext, RunnableJob } from '../queues/run-job.js';
import { MemoryDeadLetter, RecordingQueueMetrics } from '../queues/testing.js';

const TENANT = '0192f074-0000-7000-8000-00000000000a';
const NOW = new Date('2026-10-05T15:05:00.000Z');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Vetores fixos — os mesmos de `apps/api/src/modules/audit/domain/audit-seal.spec.ts`. */
const DIGEST_AB = 'fa0dafbf43f1f551e536353e9d1a942a8e86e41a0b58dfeaf264ef217f6b862a';
const CHAIN_GENESIS_AB = '550ad8ae79c5f931e3ebdd72f09a1b7f05b13af5d5bbe6d3e7e4d1bf452aa6f7';

interface Scenario {
  /** Último selo do tenant (`null` = nenhum). */
  last: { id: string; period_start: Date; chain_hash: string } | null;
  /** Horários com atividade (sem `audit.seal`) ainda não selados, em ordem. */
  pending: Date[];
  rowsOf: (periodStart: Date) => { id: string; row_hash: string }[];
  conflict?: boolean;
  failOn?: RegExp;
}

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Cliente SQL roteirizado: responde pelas instruções do `AuditSealer` e registra o que recebeu. */
function scriptedClient(scenario: Scenario, calls: Recorded[]): SqlClient {
  return {
    query: (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (scenario.failOn?.test(sql)) {
        return Promise.reject(Object.assign(new Error('Connection terminated'), { code: '08006' }));
      }
      const result = (rows: object[], rowCount = rows.length) =>
        Promise.resolve({ rows: rows as never[], rowCount });
      if (sql.includes('pg_advisory_xact_lock')) return result([{}]);
      if (sql.includes('FROM audit_seals')) return result(scenario.last ? [scenario.last] : []);
      if (sql.includes('min(occurred_at)')) {
        const from = params[1] as Date | null;
        const limit = params[2] as Date;
        const at = scenario.pending.find(
          (candidate) => (from === null || candidate >= from) && candidate < limit,
        );
        return result([{ at: at ?? null }]);
      }
      if (sql.includes('SELECT id::text, row_hash')) {
        return result(scenario.rowsOf(params[1] as Date));
      }
      if (sql.includes('INSERT INTO audit_seals')) {
        if (scenario.conflict) return result([], 0);
        scenario.last = {
          id: params[0] as string,
          period_start: params[2] as Date,
          chain_hash: params[9] as string,
        };
        return result([], 1);
      }
      if (sql.includes('INSERT INTO audit_logs')) return result([], 1);
      return Promise.reject(new Error(`SQL inesperado: ${sql}`));
    },
  };
}

function meta(): JobMeta {
  return {
    schemaVersion: 1,
    tenantId: TENANT,
    actor: { type: 'SYSTEM', userId: null, membershipId: null },
    correlationId: 'scheduler:audit-seal-tick',
    causationId: null,
    enqueuedAt: NOW.toISOString(),
  };
}

function contextOf(
  client: SqlClient,
  overrides: Partial<JobHandlerContext> = {},
): JobHandlerContext & { logger: Logger } {
  return {
    meta: meta(),
    queue: 'audit-seal',
    jobName: 'seal-tenant',
    jobId: `audit-seal.${TENANT}.1`,
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    logger: new Logger('audit-seal:seal-tenant'),
    tenantTransaction: (work) => work(client),
    platformTransaction: () => Promise.reject(new Error('sem plataforma')),
    ...overrides,
  };
}

const rows = (count: number, salt: string) =>
  Array.from({ length: count }, (_, index) => ({
    id: `0192f074-0000-7000-8000-${salt.padStart(4, '0')}${String(index).padStart(8, '0')}`,
    row_hash: sha(`${salt}-${String(index)}`),
  }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditSealer (US-074)', () => {
  it('digest e chainHash seguem os vetores fixos (mesma definição da API)', () => {
    expect(periodDigest(['a'.repeat(64), 'b'.repeat(64)])).toBe(DIGEST_AB);
    expect(chainHashOf(GENESIS_CHAIN_HASH, DIGEST_AB)).toBe(CHAIN_GENESIS_AB);
  });

  it('[Sucesso] sela 14:00–14:59 com 10 registros encadeando em H0 e audita audit.seal depois do período', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const h0 = sha('H0');
    const period = new Date('2026-10-05T14:00:00.000Z');
    const ten = rows(10, '14');
    const calls: Recorded[] = [];
    const client = scriptedClient(
      {
        last: {
          id: '0192f074-0000-7000-8000-0000000000a0',
          period_start: new Date('2026-10-05T13:00:00Z'),
          chain_hash: h0,
        },
        pending: [new Date('2026-10-05T14:03:00Z')],
        rowsOf: () => ten,
      },
      calls,
    );
    const sealer = new AuditSealer({ now: () => NOW });

    await expect(sealer.handle({}, contextOf(client))).resolves.toBe('completed');

    const insertSeal = calls.find((call) => call.sql.includes('INSERT INTO audit_seals'));
    const digest = sha(ten.map((row) => row.row_hash).join(''));
    expect(insertSeal?.params).toEqual([
      expect.any(String),
      TENANT,
      period,
      new Date('2026-10-05T14:59:59.999Z'),
      ten[0]?.id,
      ten[9]?.id,
      10,
      digest,
      '0192f074-0000-7000-8000-0000000000a0',
      sha(h0 + digest),
      NOW,
    ]);
    expect(insertSeal?.sql).toContain('ON CONFLICT (tenant_id, period_start) DO NOTHING');
    // RN-AUD-14 + RN-AUD-01: o audit.seal vai no mesmo tx, com occurredAt = agora (período seguinte).
    const audit = calls.find((call) => call.sql.includes('INSERT INTO audit_logs'));
    const [
      id,
      occurredAt,
      tenantId,
      actorName,
      action,
      category,
      result,
      entityType,
      entityId,
      metadata,
      correlationId,
      rowHash,
    ] = audit?.params as [
      string,
      Date,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    expect(occurredAt.getTime()).toBeGreaterThan(new Date('2026-10-05T14:59:59.999Z').getTime());
    expect({ action, category, result, entityType, actorName }).toEqual({
      action: 'audit.seal',
      category: 'SYSTEM',
      result: 'SUCCESS',
      entityType: 'AuditSeal',
      actorName: 'audit-seal:seal-tenant',
    });
    expect(entityId).toBe(insertSeal?.params[0]);
    expect(JSON.parse(metadata)).toEqual({
      periodStart: '2026-10-05T14:00:00.000Z',
      periodEnd: '2026-10-05T14:59:59.999Z',
      recordCount: 10,
      digest,
    });
    const row: AuditRow = {
      id,
      occurredAt,
      tenantId,
      actorType: 'SYSTEM',
      actorUserId: null,
      actorName,
      actorMembershipId: null,
      onBehalfOfUserId: null,
      action: 'audit.seal',
      category,
      result: 'SUCCESS',
      entityType,
      entityId,
      processId: null,
      changes: null,
      metadata: JSON.parse(metadata) as AuditRow['metadata'],
      reasonCode: null,
      ip: null,
      userAgent: null,
      correlationId,
      requestId: null,
      sessionIdHash: null,
    };
    expect(rowHash).toBe(rowHashOf(row));
    expect(calls[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(calls[0]?.params).toEqual([`cf:audit-seal:${TENANT}`]);
  });

  it('o primeiro selo do tenant encadeia nos 64 zeros e sem anterior', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: Recorded[] = [];
    const two = [
      { id: '0192f074-0000-7000-8000-000000000001', row_hash: 'a'.repeat(64) },
      { id: '0192f074-0000-7000-8000-000000000002', row_hash: 'b'.repeat(64) },
    ];
    const client = scriptedClient(
      { last: null, pending: [new Date('2026-10-05T09:10:00Z')], rowsOf: () => two },
      calls,
    );
    await new AuditSealer({ now: () => NOW }).handle({}, contextOf(client));
    const insert = calls.find((call) => call.sql.includes('INSERT INTO audit_seals'));
    expect(insert?.params[7]).toBe(DIGEST_AB);
    expect(insert?.params[8]).toBeNull();
    expect(insert?.params[9]).toBe(CHAIN_GENESIS_AB);
    // Sem selo anterior a busca começa do início da trilha.
    const next = calls.find((call) => call.sql.includes('min(occurred_at)'));
    expect(next?.params[1]).toBeNull();
  });

  it('FA-01/FA-03: sela em ordem cada hora pendente, pulando lacunas, até ficar em dia', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: Recorded[] = [];
    const scenario: Scenario = {
      last: null,
      pending: [
        new Date('2026-10-05T10:20:00Z'),
        new Date('2026-10-05T13:01:00Z'),
        new Date('2026-10-05T14:59:00Z'),
        // Hora corrente (aberta): não é selada.
        new Date('2026-10-05T15:01:00Z'),
      ],
      rowsOf: (start) => rows(2, String(start.getUTCHours())),
    };
    await new AuditSealer({ now: () => NOW }).handle(
      {},
      contextOf(scriptedClient(scenario, calls)),
    );
    const seals = calls.filter((call) => call.sql.includes('INSERT INTO audit_seals'));
    expect(seals.map((call) => (call.params[2] as Date).toISOString())).toEqual([
      '2026-10-05T10:00:00.000Z',
      '2026-10-05T13:00:00.000Z',
      '2026-10-05T14:00:00.000Z',
    ]);
    // Cada selo aponta para o anterior (cadeia contínua mesmo com a lacuna 11h–12h).
    expect(seals[1]?.params[8]).toBe(seals[0]?.params[0]);
    expect(seals[2]?.params[8]).toBe(seals[1]?.params[0]);
    expect(seals[1]?.params[9]).toBe(
      chainHashOf(seals[0]?.params[9] as string, seals[1]?.params[7] as string),
    );
    expect(
      log.mock.calls.filter(
        ([entry]) => (entry as { event?: string }).event === 'audit.seal_created',
      ),
    ).toHaveLength(3);
  });

  it('a folga após a hora: às 15:01 a hora 14 ainda não é selada', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: Recorded[] = [];
    const client = scriptedClient(
      { last: null, pending: [new Date('2026-10-05T14:30:00Z')], rowsOf: () => rows(1, '14') },
      calls,
    );
    const at = new Date(new Date('2026-10-05T15:00:00Z').getTime() + SEAL_GRACE_MS - 1);
    await new AuditSealer({ now: () => at }).handle({}, contextOf(client));
    expect(calls.some((call) => call.sql.includes('INSERT INTO audit_seals'))).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.seal_skipped_empty', tenantId: TENANT }),
    );
  });

  it('RN-AUD-12: sem atividade não grava selo nem auditoria', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: Recorded[] = [];
    const client = scriptedClient({ last: null, pending: [], rowsOf: () => [] }, calls);
    await expect(new AuditSealer({ now: () => NOW }).handle({}, contextOf(client))).resolves.toBe(
      'completed',
    );
    expect(calls.filter((call) => call.sql.startsWith('INSERT'))).toEqual([]);
    // A busca ignora o próprio audit.seal (senão cada selo geraria o seguinte para sempre).
    expect(calls.find((call) => call.sql.includes('min(occurred_at)'))?.sql).toContain(
      "action <> 'audit.seal'",
    );
  });

  it('[Duplicidade] conflito no INSERT: no-op silencioso, sem audit.seal', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: Recorded[] = [];
    const client = scriptedClient(
      {
        last: null,
        pending: [new Date('2026-10-05T14:30:00Z')],
        rowsOf: () => rows(1, '14'),
        conflict: true,
      },
      calls,
    );
    await expect(new AuditSealer({ now: () => NOW }).handle({}, contextOf(client))).resolves.toBe(
      'completed',
    );
    expect(calls.some((call) => call.sql.includes('INSERT INTO audit_logs'))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.seal_duplicate' }));
  });

  it('limita os períodos por execução e avisa do atraso', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const calls: Recorded[] = [];
    const pending = [0, 1, 2, 3].map((hour) => new Date(Date.UTC(2026, 9, 5, hour, 10)));
    const client = scriptedClient({ last: null, pending, rowsOf: () => rows(1, '1') }, calls);
    await new AuditSealer({ now: () => NOW, maxPeriodsPerRun: 2 }).handle({}, contextOf(client));
    expect(calls.filter((call) => call.sql.includes('INSERT INTO audit_seals'))).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.seal_backlog' }));
  });

  it('job sem tenant não sela nada', async () => {
    const client = scriptedClient({ last: null, pending: [], rowsOf: () => [] }, []);
    const context = contextOf(client, { meta: { ...meta(), tenantId: null } });
    await expect(new AuditSealer().handle({}, context)).resolves.toBe('skipped');
  });

  it('[Falha de banco] falha no meio do período: relança para retry e loga audit.seal_retry', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const calls: Recorded[] = [];
    const client = scriptedClient(
      {
        last: null,
        pending: [new Date('2026-10-05T14:30:00Z')],
        rowsOf: () => rows(1, '14'),
        failOn: /INSERT INTO audit_logs/,
      },
      calls,
    );
    await expect(
      new AuditSealer({ now: () => NOW }).handle(
        {},
        contextOf(client, { attempt: 1, maxAttempts: 3 }),
      ),
    ).rejects.toThrow('Connection terminated');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.seal_retry', attempt: 1, maxAttempts: 3 }),
    );
  });

  it('erro permanente vai direto a audit.seal_failed', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client: SqlClient = {
      query: () => Promise.reject(new PermanentJobError('INVARIANT', 'quebrado')),
    };
    await expect(
      new AuditSealer({ now: () => NOW }).handle({}, contextOf(client, { attempt: 1 })),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.seal_failed', alert: true }),
    );
  });

  it('[Falha de integração] 3ª tentativa falha: dead letter + error audit.seal_failed com alerta', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const down = Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
    const database: WorkerDatabase = {
      tenantTransaction: () => Promise.reject(down),
      platformTransaction: () => Promise.reject(down),
      withAdvisoryLock: () => Promise.reject(down),
      close: () => Promise.resolve(),
    };
    const deadLetter = new MemoryDeadLetter();
    const job: RunnableJob = {
      id: `audit-seal.${TENANT}.1`,
      name: 'seal-tenant',
      queueName: 'audit-seal',
      data: { meta: meta(), payload: {} },
      attemptsMade: 2,
      opts: { attempts: 3, backoff: { type: 'cf-exponential-jitter', delay: 5_000 } },
      timestamp: NOW.getTime(),
    };
    await expect(
      runJob(job, new AuditSealer({ now: () => NOW }), {
        deadLetter,
        metrics: new RecordingQueueMetrics(),
        timeoutMs: 60_000,
        postpone: () => Promise.resolve(),
        database,
      }),
    ).rejects.toBe(down);
    expect([...deadLetter.records.values()]).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ class: 'TRANSIENT_EXHAUSTED' }) as unknown,
        source: expect.objectContaining({ queue: 'audit-seal', jobName: 'seal-tenant' }) as unknown,
      }),
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.seal_failed',
        alert: true,
        tenantId: TENANT,
        attempt: 3,
      }),
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker.job_dead_lettered', queue: 'audit-seal' }),
    );
  });
});

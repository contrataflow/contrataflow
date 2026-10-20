// Varredura de encerramentos de sessão contra Redis e PostgreSQL reais (US-088 · RN-IAM-28): o
// adaptador `RedisSessionRegistry` com o protocolo do BFF (`endSession`, trava, conjunto de prazos),
// o `RecordSessionEndingsCommand` por cima e, de ponta a ponta, o `AuditTrailSessionRecorder` com o
// `AuditService` gravando `audit_logs` no horário do fato (`oncePerSession`).
// `pnpm --filter @contrataflow/api test:integration`.
//
// O estado do Redis é montado e conferido com `redis-cli` dentro do contêiner: ioredis só é
// importável em `modules/platform` (lint `no-direct-redis`).
import { createHash } from 'node:crypto';

import { sessionKeyspace } from '@contrataflow/types';
import type { SessionHeader, SessionTombstone } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import { AuditService } from '#modules/audit/application/audit.service.js';
import { PrismaAuditLogStore } from '#modules/audit/infrastructure/prisma-audit-log.store.js';
import { PrismaAuditTransactions } from '#modules/audit/infrastructure/prisma-audit-transactions.js';
import type { SessionAuditPort } from '#modules/identity/application/ports.js';
import { RecordSessionEndingsCommand } from '#modules/identity/application/record-session-endings.command.js';
import { AuditTrailSessionRecorder } from '#modules/identity/infrastructure/audit-trail-session.recorder.js';
import { RedisSessionRegistry } from '#modules/platform/infrastructure/redis/redis-session-registry.js';
import { InMemoryAuditSamplingStore } from '#shared/audit/sampling-store.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

/** Mesma imagem do Compose local (infra/docker-compose.yml). */
const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TENANT_A = FAKE_TENANTS.prefeituraA.id;
const TENANT_B = FAKE_TENANTS.prefeituraB.id;
const CLAUDIA = '0192f000-0000-7000-8000-0000000000c1';
const CLAUDIA_MEMBERSHIP = '0192f000-0000-7000-8000-0000000001c1';
const DIEGO = '0192f000-0000-7000-8000-0000000000d1';
const DIEGO_MEMBERSHIP = '0192f000-0000-7000-8000-0000000001d1';

const keys = sessionKeyspace('test');

function sessionKey(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/**
 * Sessão da Cláudia como o BFF a grava: cabeçalho + tokens cifrados. Por padrão a ociosidade se
 * esgotou há 30 s (ninguém voltou) — recente o bastante para cair na partição do mês corrente.
 */
function claudia(key: string, now: number, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    key,
    userId: CLAUDIA,
    displayName: 'Cláudia Ramos',
    activeTenantId: TENANT_A,
    membershipId: CLAUDIA_MEMBERSHIP,
    createdAt: now - 2 * HOUR,
    lastSeenAt: now - 30 * MINUTE - 30_000,
    idleExpiresAt: now - 30_000,
    absoluteExpiresAt: now + 10 * HOUR,
    idleMinutes: 30,
    ...overrides,
  };
}

function currentPartition(at = new Date()): string {
  return `audit_logs_${at.getUTCFullYear()}_${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface SessionAuditRow {
  readonly tenant_id: string | null;
  readonly action: string;
  readonly actor_type: string;
  readonly actor_user_id: string | null;
  readonly actor_membership_id: string | null;
  readonly actor_name: string | null;
  readonly occurred_at: Date;
  readonly session_id_hash: string | null;
  readonly ip: string | null;
  readonly metadata: Record<string, unknown>;
}

describe('varredura de sessões com Redis e PostgreSQL reais', () => {
  let redis: StartedTestContainer;
  let db: TestDatabase;
  let registry: RedisSessionRegistry;
  /** Varredura com a auditoria fake: isola o comportamento do Redis. */
  let command: RecordSessionEndingsCommand;
  /** Varredura de ponta a ponta: recorder + AuditService + `audit_logs` no PostgreSQL. */
  let endToEnd: RecordSessionEndingsCommand;
  const ended: SessionTombstone[] = [];
  let auditFailures = 0;
  let redisStopped = false;

  const fakeAudit: SessionAuditPort = {
    sessionStarted: () => Promise.resolve(),
    tenantSwitched: () => Promise.resolve(),
    sessionEnded: (tombstone) => {
      ended.push(tombstone);
      if (auditFailures > 0) {
        auditFailures -= 1;
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      }
      return Promise.resolve('recorded');
    },
  };

  async function cli(...args: string[]): Promise<string> {
    const result = await redis.exec(['redis-cli', ...args]);
    if (result.exitCode !== 0) throw new Error(`redis-cli ${args[0] ?? ''}: ${result.output}`);
    return result.output.trim();
  }

  /** Grava a sessão viva como o BFF: registro com tokens cifrados + prazo no conjunto. */
  async function seedLive(header: SessionHeader): Promise<void> {
    const record = JSON.stringify({ ...header, sealedTokens: 'v1.tokens-cifrados' });
    await cli('SET', keys.record(header.key), record);
    await cli('ZADD', keys.expiry, String(header.idleExpiresAt), header.key);
  }

  const exists = async (key: string) => (await cli('EXISTS', key)) === '1';
  const scheduled = async (key: string) => (await cli('ZSCORE', keys.expiry, key)) !== '';
  const auditRows = (key: string) =>
    db.admin<SessionAuditRow>(
      `SELECT tenant_id, action, actor_type, actor_user_id, actor_membership_id, actor_name,
              occurred_at, session_id_hash, host(ip) AS ip, metadata
         FROM audit_logs WHERE session_id_hash = $1 ORDER BY occurred_at`,
      [key],
    );

  beforeAll(async () => {
    [redis, db] = await Promise.all([
      new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
      startTestDatabase(),
    ]);
    registry = new RedisSessionRegistry(
      `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      'test',
    );
    registry.onApplicationBootstrap();
    command = new RecordSessionEndingsCommand(registry, fakeAudit, () => new Date());

    const app = db.client('cf_app');
    const audit = new AuditService(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: db.url('cf_app'),
        REDIS_CACHE_URL: 'redis://127.0.0.1:1',
        OIDC_ISSUER_URL: 'https://issuer.test/',
      }),
      new PrismaAuditLogStore(),
      new PrismaAuditTransactions(new TenantTransaction(app), new PlatformTransaction(app)),
      new InMemoryAuditSamplingStore(),
      () => new Date(),
    );
    endToEnd = new RecordSessionEndingsCommand(
      registry,
      new AuditTrailSessionRecorder(audit),
      () => new Date(),
    );
    // A conexão abre em segundo plano; sem fila offline, o 1º comando precisa esperar por ela.
    await vi.waitFor(() => registry.due(0, 1), { timeout: 10_000, interval: 100 });
  });

  afterAll(async () => {
    registry.onModuleDestroy();
    if (!redisStopped) await redis.stop();
    await db.stop();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    ended.length = 0;
    auditFailures = 0;
    // A trava dura 50 s: cada teste começa um ciclo novo.
    if (!redisStopped) await cli('DEL', keys.sweepLock);
  });

  const quiet = () => ({
    log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
    debug: vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
  });

  describe('Redis (auditoria fake)', () => {
    it('[Sucesso] sessão ociosa nunca mais acessada: encerra com o horário do limite e apaga tudo do Redis', async () => {
      quiet();
      const key = sessionKey('ociosa');
      const header = claudia(key, Date.now(), { idleExpiresAt: Date.now() - 30 * MINUTE });
      await seedLive(header);

      await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({
        key,
        reason: 'IDLE',
        occurredAt: header.idleExpiresAt,
        activeTenantId: TENANT_A,
        membershipId: CLAUDIA_MEMBERSHIP,
        idleMinutes: 30,
      });
      expect(await exists(keys.record(key))).toBe(false);
      expect(await exists(keys.ended(key))).toBe(false);
      expect(await scheduled(key)).toBe(false);
    });

    it('logout do BFF: o registro de encerramento não tem tokens e some depois da auditoria', async () => {
      quiet();
      const key = sessionKey('logout');
      const now = Date.now();
      const header = claudia(key, now, { idleExpiresAt: now + 10 * MINUTE });
      await seedLive(header);

      await expect(
        registry.end({
          header,
          reason: 'LOGOUT',
          occurredAt: now - MINUTE,
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
        }),
      ).resolves.toBe(true);
      // Segundo encerramento da mesma sessão (logout repetido): só o primeiro vence.
      await expect(
        registry.end({ header, reason: 'SESSION_LIMIT', occurredAt: now }),
      ).resolves.toBe(false);

      expect(await exists(keys.record(key))).toBe(false);
      const tombstone = await cli('GET', keys.ended(key));
      expect(tombstone).not.toContain('sealedTokens');
      expect(tombstone).not.toContain('tokens-cifrados');
      expect(await cli('PTTL', keys.ended(key))).toMatch(/^\d+$/);

      await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

      expect(ended[0]).toMatchObject({
        reason: 'LOGOUT',
        occurredAt: now - MINUTE,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      });
      expect(await exists(keys.ended(key))).toBe(false);
      expect(await scheduled(key)).toBe(false);
    });

    it('sessão acessada depois é só reagendada no conjunto de prazos', async () => {
      quiet();
      const key = sessionKey('acessada');
      const now = Date.now();
      // Prazo antigo no conjunto (vencido), mas o BFF já estendeu a ociosidade do registro.
      const header = claudia(key, now, { idleExpiresAt: now + 20 * MINUTE });
      await seedLive(header);
      await cli('ZADD', keys.expiry, String(now - MINUTE), key);

      await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 0 });

      expect(ended).toHaveLength(0);
      expect(await exists(keys.record(key))).toBe(true);
      expect(Number(await cli('ZSCORE', keys.expiry, key))).toBe(header.idleExpiresAt);
    });

    it('a trava da varredura é de uma réplica por ciclo e expira em até 50 s', async () => {
      await expect(registry.acquireSweepLock(50_000)).resolves.toBe(true);
      await expect(registry.acquireSweepLock(50_000)).resolves.toBe(false);
      const ttl = Number(await cli('PTTL', keys.sweepLock));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(50_000);
      quiet();
      const key = sessionKey('trava');
      await seedLive(claudia(key, Date.now()));
      // Outra réplica está no ciclo: esta não faz nada e a sessão fica para o próximo.
      await expect(command.run()).resolves.toEqual({ processed: 0, recorded: 0, deferred: 0 });
      expect(await exists(keys.record(key))).toBe(true);
      await cli('DEL', keys.sweepLock);
      await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });
    });

    it('[Falha de banco] auditoria falha: o registro de encerramento fica e é refeito com o horário original', async () => {
      const { warn } = quiet();
      const key = sessionKey('banco-fora');
      const header = claudia(key, Date.now());
      await seedLive(header);
      auditFailures = 1;

      await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 1 });
      expect(await exists(keys.ended(key))).toBe(true);
      expect(await scheduled(key)).toBe(true);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(key);

      await cli('DEL', keys.sweepLock);
      await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });
      expect(ended.map((tombstone) => tombstone.occurredAt)).toEqual([
        header.idleExpiresAt,
        header.idleExpiresAt,
      ]);
      expect(await exists(keys.ended(key))).toBe(false);
      expect(await scheduled(key)).toBe(false);
    });
  });

  describe('de ponta a ponta no PostgreSQL (RLS)', () => {
    it('[Sucesso] grava auth.session_expired na instituição da sessão, no horário do fato, e limpa o Redis', async () => {
      quiet();
      const key = sessionKey('fim-a-fim');
      const header = claudia(key, Date.now());
      await seedLive(header);

      await expect(endToEnd.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

      const rows = await auditRows(key);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: TENANT_A,
        action: 'auth.session_expired',
        actor_type: 'USER',
        actor_user_id: CLAUDIA,
        actor_membership_id: CLAUDIA_MEMBERSHIP,
        actor_name: 'Cláudia Ramos',
        session_id_hash: key,
        ip: null,
        metadata: { reason: 'IDLE', idleMinutes: 30 },
      });
      // O horário do fato (limite de ociosidade), não o da varredura.
      expect(rows[0]?.occurred_at.getTime()).toBe(header.idleExpiresAt);
      expect(await exists(keys.ended(key))).toBe(false);
      expect(await scheduled(key)).toBe(false);
    });

    it('logout grava auth.session_end com o IP e o user-agent do encerramento', async () => {
      quiet();
      const key = sessionKey('logout-fim-a-fim');
      const now = Date.now();
      const header = claudia(key, now, { idleExpiresAt: now + 10 * MINUTE });
      await seedLive(header);
      await registry.end({
        header,
        reason: 'LOGOUT',
        occurredAt: now - 5_000,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      });

      await expect(endToEnd.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

      const rows = await auditRows(key);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'auth.session_end',
        ip: '203.0.113.7',
        metadata: { reason: 'LOGOUT', sessionAgeMinutes: 120 },
      });
      expect(rows[0]?.occurred_at.getTime()).toBe(now - 5_000);
    });

    it('[Tenant incorreto] cada sessão é auditada só na própria instituição', async () => {
      quiet();
      const claudiaKey = sessionKey('tenant-claudia');
      const diegoKey = sessionKey('tenant-diego');
      const now = Date.now();
      await seedLive(claudia(claudiaKey, now));
      await seedLive(
        claudia(diegoKey, now, {
          userId: DIEGO,
          displayName: 'Diego Alves',
          activeTenantId: TENANT_B,
          membershipId: DIEGO_MEMBERSHIP,
        }),
      );

      await expect(endToEnd.run()).resolves.toEqual({ processed: 2, recorded: 2, deferred: 0 });

      expect(
        (await auditRows(claudiaKey)).map((row) => [row.tenant_id, row.actor_user_id]),
      ).toEqual([[TENANT_A, CLAUDIA]]);
      expect((await auditRows(diegoKey)).map((row) => [row.tenant_id, row.actor_user_id])).toEqual([
        [TENANT_B, DIEGO],
      ]);
    });

    it('sessão sem instituição ativa não gera auditoria de tenant e é removida do Redis', async () => {
      quiet();
      const key = sessionKey('sem-instituicao');
      await seedLive(claudia(key, Date.now(), { activeTenantId: null, membershipId: null }));

      await expect(endToEnd.run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 0 });

      expect(await auditRows(key)).toHaveLength(0);
      expect(await exists(keys.ended(key))).toBe(false);
      expect(await scheduled(key)).toBe(false);
    });

    it('[Duplicidade] falha ao apagar o registro depois do commit: o ciclo seguinte não grava de novo', async () => {
      quiet();
      const key = sessionKey('duplicidade');
      await seedLive(claudia(key, Date.now()));
      vi.spyOn(registry, 'forget').mockRejectedValueOnce(new Error('Connection is closed.'));

      await endToEnd.run();
      expect(await auditRows(key)).toHaveLength(1);
      expect(await exists(keys.ended(key))).toBe(true);

      await cli('DEL', keys.sweepLock);
      await expect(endToEnd.run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 0 });
      expect(await auditRows(key)).toHaveLength(1);
      expect(await exists(keys.ended(key))).toBe(false);
      expect(await scheduled(key)).toBe(false);
    });

    it('[Falha de banco] partição indisponível: o registro de encerramento fica e grava depois com o horário original', async () => {
      quiet();
      const key = sessionKey('banco-fora-fim-a-fim');
      const header = claudia(key, Date.now());
      await seedLive(header);
      const partition = currentPartition(new Date(header.idleExpiresAt));
      const bounds = (
        await db.admin<{ bound: string }>(
          'SELECT pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c WHERE c.relname = $1',
          [partition],
        )
      )[0]?.bound;
      await db.admin(`ALTER TABLE audit_logs DETACH PARTITION ${partition}`);
      try {
        await expect(endToEnd.run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 1 });
        expect(await exists(keys.ended(key))).toBe(true);
        expect(await scheduled(key)).toBe(true);
      } finally {
        await db.admin(`ALTER TABLE audit_logs ATTACH PARTITION ${partition} ${String(bounds)}`);
      }

      await cli('DEL', keys.sweepLock);
      await expect(endToEnd.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });
      const rows = await auditRows(key);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.occurred_at.getTime()).toBe(header.idleExpiresAt);
      expect(await exists(keys.ended(key))).toBe(false);
    });
  });

  // Por último: derruba o Redis.
  describe('Redis fora', () => {
    it('[Falha de integração] o ciclo termina sem lançar e registra o aviso', async () => {
      const { warn } = quiet();
      await redis.stop();
      redisStopped = true;

      await expect(command.run()).resolves.toEqual({ processed: 0, recorded: 0, deferred: 0 });

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth.session_sweep_failed' }),
        'auth.session_sweep_failed',
      );
    });
  });
});

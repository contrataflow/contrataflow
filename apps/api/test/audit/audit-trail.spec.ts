// Auditoria transacional contra PostgreSQL e Redis reais (US-073 · Gherkin "Registrar auditoria
// transacional"): migrações reais, a aplicação como `cf_app` (RLS) e o pipeline HTTP com identidade
// fake. `pnpm --filter @contrataflow/api test:integration`.
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import { AuditService } from '#modules/audit/application/audit.service.js';
import { EnsureAuditPartitionsJob } from '#modules/audit/application/ensure-audit-partitions.job.js';
import {
  AUDIT_LOG_STORE,
  AUDIT_PARTITIONS,
  AUDIT_TRANSACTIONS,
} from '#modules/audit/application/ports.js';
import { rowHashOf } from '#modules/audit/domain/audit-record.js';
import type { AuditRecord } from '#modules/audit/domain/audit-record.js';
import { PrismaAuditLogStore } from '#modules/audit/infrastructure/prisma-audit-log.store.js';
import {
  PrismaAuditPartitions,
  PrismaAuditTransactions,
} from '#modules/audit/infrastructure/prisma-audit-transactions.js';
import { RedisAuditSamplingStore } from '#modules/platform/infrastructure/redis/redis-audit-sampling.store.js';
import { RedisClient } from '#modules/platform/infrastructure/redis/redis.client.js';
import { InMemoryAuditSamplingStore } from '#shared/audit/sampling-store.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import { createTestApi, testConfig } from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { AuditProbeController } from '../support/audit-probe.controller.js';

/** Mesma imagem do Compose local (infra/docker-compose.yml). */
const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const ANA = FAKE_USERS.ana;
const DOCUMENT = '0192f000-0000-7000-8000-0000000000d1';

interface AuditRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly tenant_id: string | null;
  readonly actor_type: AuditRecord['actorType'];
  readonly actor_user_id: string | null;
  readonly actor_name: string | null;
  readonly actor_membership_id: string | null;
  readonly on_behalf_of_user_id: string | null;
  readonly action: AuditRecord['action'];
  readonly category: AuditRecord['category'];
  readonly result: AuditRecord['result'];
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly process_id: string | null;
  readonly changes: AuditRecord['changes'];
  readonly metadata: AuditRecord['metadata'];
  readonly reason_code: string | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly correlation_id: string | null;
  readonly request_id: string | null;
  readonly session_id_hash: string | null;
  readonly row_hash: string;
  readonly partition: string;
}

/** O registro como está no banco (o `rowHash` tem de ser verificável a partir dele). */
function fromRow(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    tenantId: row.tenant_id,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorMembershipId: row.actor_membership_id,
    onBehalfOfUserId: row.on_behalf_of_user_id,
    action: row.action,
    category: row.category,
    result: row.result,
    entityType: row.entity_type,
    entityId: row.entity_id,
    processId: row.process_id,
    changes: row.changes,
    metadata: row.metadata,
    reasonCode: row.reason_code,
    ip: row.ip,
    userAgent: row.user_agent,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    sessionIdHash: row.session_id_hash,
  };
}

const SELECT_ROWS = `SELECT a.*, host(a.ip) AS ip, a.tableoid::regclass::text AS partition
  FROM audit_logs a`;

function currentPartition(at = new Date()): string {
  return `audit_logs_${at.getUTCFullYear()}_${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Contexto de requisição da Ana no tenant (o que o pipeline monta). */
function asAna<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'corr-it', ip: '203.0.113.7', userAgent: 'it' },
    () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'USER', userId: ANA.id, membershipId: null, name: 'Ana Souza' },
      });
      return fn();
    },
  );
}

describe('auditoria transacional no PostgreSQL (US-073)', () => {
  let db: TestDatabase;
  let redis: StartedTestContainer;
  let redisUrl: string;
  let app: TenantPrismaClient;
  let api: TestApi;
  let redisStopped = false;

  const rows = (where = 'TRUE', params: unknown[] = []) =>
    db.admin<AuditRow>(`${SELECT_ROWS} WHERE ${where} ORDER BY a.occurred_at, a.id`, params);

  beforeAll(async () => {
    [db, redis] = await Promise.all([
      startTestDatabase(),
      new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
    ]);
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    app = db.client('cf_app');
    const platform = new PlatformTransaction(app);
    api = await createTestApi({
      stores: 'redis',
      config: testConfig({
        DATABASE_URL: db.url('cf_app'),
        DATABASE_POOL_SIZE: '20',
        REDIS_CACHE_URL: redisUrl,
        TRUSTED_PROXY_CIDRS: '127.0.0.1,::1',
        AUDIT_ACCESS_DENIED_SAMPLING_MAX_PER_WINDOW: '3',
        AUDIT_ACCESS_DENIED_SAMPLING_WINDOW_SECONDS: '3600',
      }),
      controllers: [AuditProbeController],
      // A identidade continua fake (tokens HS256); a trilha é a real, no PostgreSQL.
      providers: [
        { token: AUDIT_LOG_STORE, value: new PrismaAuditLogStore() },
        {
          token: AUDIT_TRANSACTIONS,
          value: new PrismaAuditTransactions(new TenantTransaction(app), platform),
        },
        { token: AUDIT_PARTITIONS, value: new PrismaAuditPartitions(platform) },
      ],
    });
  });

  afterAll(async () => {
    await api.close();
    if (!redisStopped) await redis.stop();
    await db.stop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const quiet = () => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  };

  const createProcess = (body: Record<string, unknown>, tenantId: string = A) =>
    request(api.server)
      .post('/api/v1/_test/audit/processes')
      .set('Authorization', api.bearer(ANA.subject))
      .set('X-Tenant-Id', tenantId)
      .set('X-Forwarded-For', '203.0.113.9')
      .set('User-Agent', 'Navegador/1.0')
      .set('X-CF-Session-Id-Hash', 'c'.repeat(64))
      .send(body);

  const outboxTotal = async () =>
    Number(
      (await db.admin<{ total: string }>('SELECT count(*) AS total FROM outbox_events'))[0]?.total,
    );

  const outboxCount = async (aggregateId: string) =>
    Number(
      (
        await db.admin<{ total: string }>(
          'SELECT count(*) AS total FROM outbox_events WHERE aggregate_id = $1',
          [aggregateId],
        )
      )[0]?.total,
    );

  it('[Sucesso] a ação de negócio gera exatamente um AuditLog íntegro na mesma transação', async () => {
    quiet();
    const response = await createProcess({
      title: 'Aquisição de papel A4',
      requesterCpf: '123.456.789-09',
    });
    expect(response.status).toBe(201);
    const { processId } = (response.body as { data: { processId: string } }).data;

    const found = await rows('a.entity_id = $1', [processId]);
    expect(found).toHaveLength(1);
    const [row] = found as [AuditRow];
    expect(row).toMatchObject({
      tenant_id: A,
      action: 'process.create',
      category: 'DATA_CHANGE',
      result: 'SUCCESS',
      actor_type: 'USER',
      actor_user_id: ANA.id,
      actor_name: 'Ana Souza',
      ip: '203.0.113.9',
      user_agent: 'Navegador/1.0',
      correlation_id: response.headers['x-correlation-id'],
      session_id_hash: 'c'.repeat(64),
      partition: currentPartition(),
    });
    // rowHash = SHA-256 do registro canonicalizado, recalculado a partir do que está no banco.
    expect(row.row_hash).toBe(rowHashOf(fromRow(row)));
    // Nenhum CPF em texto puro.
    expect(JSON.stringify(row.changes)).not.toContain('123.456.789-09');
    expect(row.changes).toContainEqual({ path: 'requester.cpf', old: null, new: '***.456.789-**' });
    expect(await outboxCount(processId)).toBe(1);
  });

  it('[Validação] ação fora do catálogo é recusada antes do INSERT e desfaz a transação', async () => {
    quiet();
    const before = await rows();
    const outboxBefore = await outboxTotal();
    const response = await createProcess({ title: 'X', action: 'foo.bar' });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await rows()).toHaveLength(before.length);
    expect(await outboxTotal()).toBe(outboxBefore);
  });

  it('[Permissão] ação negada por falta de permissão ainda é auditada', async () => {
    quiet();
    const response = await request(api.server)
      .post('/api/v1/_test/audit/forbidden')
      .set('Authorization', api.bearer(FAKE_USERS.fabio.subject))
      .set('X-Tenant-Id', A)
      .send({ title: 'Processo' });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    const [denial] = await rows("a.action = 'access.denied' AND a.actor_user_id = $1", [
      FAKE_USERS.fabio.id,
    ]);
    expect(denial).toMatchObject({
      tenant_id: A,
      category: 'ACCESS',
      result: 'DENIED',
      reason_code: 'PROCESS_CREATE',
    });
    if (!denial) throw new Error('access.denied não gravado');
    expect(denial.row_hash).toBe(rowHashOf(fromRow(denial)));
  });

  it('[Tenant incorreto] RLS: só os registros do tenant do contexto; plataforma invisível', async () => {
    quiet();
    await createProcess({ title: 'Processo de B' }, B).expect(403); // Ana não tem vínculo em B
    // Registros de A e de B (B gravado direto, como se fosse um usuário de B).
    await asAna(B, () =>
      app.$tenantTransaction((tx) =>
        new AuditService(
          loadConfig(configEnv()),
          new PrismaAuditLogStore(),
          new PrismaAuditTransactions(new TenantTransaction(app), new PlatformTransaction(app)),
          new InMemoryAuditSamplingStore(),
          () => new Date(),
        ).record(tx, { action: 'process.update', entityType: 'Process', entityId: DOCUMENT }),
      ),
    );
    const seenBy = (tenantId: string) =>
      asAna(tenantId, () =>
        app.$tenantTransaction(
          (tx) => tx.$queryRaw<{ tenant_id: string | null }[]>`SELECT tenant_id FROM audit_logs`,
          { readOnly: true },
        ),
      );
    const fromA = await seenBy(A);
    const fromB = await seenBy(B);
    expect(fromA.length).toBeGreaterThan(0);
    expect(new Set(fromA.map((row) => row.tenant_id))).toEqual(new Set<string>([A]));
    expect(new Set(fromB.map((row) => row.tenant_id))).toEqual(new Set<string>([B]));
    // A negação sem vínculo virou registro de plataforma — existe, mas nenhum tenant o vê.
    expect((await rows('a.tenant_id IS NULL')).length).toBeGreaterThan(0);
  });

  it('[Duplicidade] autosave em rajada na janela de 10 min grava um único registro', async () => {
    quiet();
    const clock = { now: new Date() };
    const service = new AuditService(
      loadConfig(configEnv()),
      new PrismaAuditLogStore(),
      new PrismaAuditTransactions(new TenantTransaction(app), new PlatformTransaction(app)),
      new InMemoryAuditSamplingStore(),
      () => clock.now,
    );
    const save = (revision: number, size: number) =>
      asAna(A, () =>
        app.$tenantTransaction((tx) =>
          service.record(tx, {
            action: 'document.draft_update',
            entityType: 'Document',
            entityId: DOCUMENT,
            coalesce: { scope: 'JUSTIFICATION', revision, size },
          }),
        ),
      );
    expect((await save(1, 1_000)).kind).toBe('recorded');
    clock.now = new Date(clock.now.getTime() + 2 * 60_000);
    expect((await save(2, 1_050)).kind).toBe('coalesced');
    expect((await save(3, 1_100)).kind).toBe('coalesced');
    const drafts = await rows("a.action = 'document.draft_update'");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.metadata).toMatchObject({
      coalesce: { scope: 'JUSTIFICATION', revision: 1 },
    });
    // Variação de tamanho relevante reabre a janela (FA-05).
    expect((await save(4, 2_000)).kind).toBe('recorded');
    expect(await rows("a.action = 'document.draft_update'")).toHaveLength(2);
  });

  it('[Concorrência] 20 transações no mesmo segundo → 20 registros distintos com rowHash único', async () => {
    quiet();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => createProcess({ title: `Processo ${index}` })),
    );
    expect(
      responses.map((response) => response.status),
      JSON.stringify(
        responses.filter((response) => response.status !== 201).map((r) => r.body as unknown),
      ),
    ).toEqual(Array(20).fill(201));
    const ids = responses.map(
      (response) => (response.body as { data: { processId: string } }).data.processId,
    );
    const created = await rows('a.entity_id = ANY($1::uuid[])', [ids]);
    expect(created).toHaveLength(20);
    expect(new Set(created.map((row) => row.row_hash)).size).toBe(20);
    expect(created.every((row) => row.row_hash === rowHashOf(fromRow(row)))).toBe(true);
  });

  it('[Concorrência] 50 gravações simultâneas no mesmo tenant: nenhuma perda', async () => {
    quiet();
    const service = new AuditService(
      loadConfig(configEnv()),
      new PrismaAuditLogStore(),
      new PrismaAuditTransactions(new TenantTransaction(app), new PlatformTransaction(app)),
      new InMemoryAuditSamplingStore(),
      () => new Date(),
    );
    const before = (await rows("a.action = 'process.items_update'")).length;
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        asAna(A, () =>
          app.$tenantTransaction((tx) =>
            service.record(tx, { action: 'process.items_update', metadata: { index } }),
          ),
        ),
      ),
    );
    const written = await rows("a.action = 'process.items_update'");
    expect(written.length - before).toBe(50);
    expect(new Set(written.map((row) => row.row_hash)).size).toBe(written.length);
  });

  it('[Falha de banco] partição do mês indisponível → 503 e nenhum processo persiste', async () => {
    quiet();
    const partition = currentPartition();
    const bounds = (
      await db.admin<{ bound: string }>(
        `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c WHERE c.relname = $1`,
        [partition],
      )
    )[0]?.bound;
    await db.admin(`ALTER TABLE audit_logs DETACH PARTITION ${partition}`);
    try {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const before = await outboxTotal();
      const response = await createProcess({ title: 'Sem partição' });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(response.headers['retry-after']).toBe('5');
      expect(await outboxTotal()).toBe(before);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'audit.partition_missing' }),
        'audit.partition_missing',
      );
    } finally {
      await db.admin(`ALTER TABLE audit_logs ATTACH PARTITION ${partition} ${String(bounds)}`);
    }
  });

  it('imutável: UPDATE/DELETE negados ao cf_app e barrados pelo trigger para o dono', async () => {
    const cfApp = asAna(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$executeRaw`UPDATE audit_logs SET action = 'process.update'`,
      ),
    );
    await expect(cfApp).rejects.toThrow(/permission denied/);
    await expect(db.admin("UPDATE audit_logs SET action = 'process.update'")).rejects.toThrow(
      /append-only: UPDATE/,
    );
    await expect(db.admin('DELETE FROM audit_logs')).rejects.toThrow(/append-only: DELETE/);
    await expect(db.admin('TRUNCATE audit_logs')).rejects.toThrow(/append-only: TRUNCATE/);
  });

  it('particionada por mês: o registro cai na partição do seu occurredAt', async () => {
    quiet();
    const nextMonth = new Date();
    nextMonth.setUTCDate(1);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const service = new AuditService(
      loadConfig(configEnv()),
      new PrismaAuditLogStore(),
      new PrismaAuditTransactions(new TenantTransaction(app), new PlatformTransaction(app)),
      new InMemoryAuditSamplingStore(),
      () => nextMonth,
    );
    const outcome = await asAna(A, () =>
      app.$tenantTransaction((tx) => service.record(tx, { action: 'process.tags_update' })),
    );
    const [row] = await rows('a.id = $1', [outcome.kind === 'recorded' ? outcome.id : '']);
    expect(row?.partition).toBe(currentPartition(nextMonth));
  });

  it('job diário recria a partição que faltar e mantém RLS/FORCE nela', async () => {
    quiet();
    const ahead = new Date();
    ahead.setUTCDate(1);
    ahead.setUTCMonth(ahead.getUTCMonth() + 2);
    const partition = currentPartition(ahead);
    await db.admin(`DROP TABLE ${partition}`);
    const job = new EnsureAuditPartitionsJob(
      loadConfig(configEnv()),
      new PrismaAuditPartitions(new PlatformTransaction(app)),
    );
    await expect(job.run()).resolves.toBe(1);
    await expect(job.run()).resolves.toBe(0);
    const [meta] = await db.admin<{ rls: boolean; force: boolean; owner: string }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS force, pg_get_userbyid(relowner) AS owner
         FROM pg_class WHERE relname = $1`,
      [partition],
    );
    expect(meta).toEqual({ rls: true, force: true, owner: 'cf_owner' });
  });

  it('registro de plataforma só fora de tenant; de dentro de um tenant a RLS recusa', async () => {
    quiet();
    const platform = new PlatformTransaction(app);
    const service = new AuditService(
      loadConfig(configEnv()),
      new PrismaAuditLogStore(),
      new PrismaAuditTransactions(new TenantTransaction(app), platform),
      new InMemoryAuditSamplingStore(),
      () => new Date(),
    );
    const denial = {
      action: 'access.denied' as const,
      result: 'DENIED' as const,
      reasonCode: 'X_TEST',
    };
    await runWithRequestContext(
      { correlationId: 'c-plat', ip: '198.51.100.4', userAgent: 'it' },
      () => service.recordStandalone(denial),
    );
    expect(await rows("a.reason_code = 'X_TEST'")).toEqual([
      expect.objectContaining({ tenant_id: null, ip: '198.51.100.4' }),
    ]);
    // Dentro de uma transação de tenant, um registro com tenant nulo é recusado pela RLS.
    await expect(
      asAna(A, () =>
        app.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, action, category, result, reason_code, row_hash)
            VALUES (gen_random_uuid(), now(), NULL, 'USER', 'access.denied', 'ACCESS', 'DENIED', 'X', ${'f'.repeat(64)})`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  describe('amostragem de access.denied no Redis (RN-AUD-07)', () => {
    const deny = () =>
      request(api.server)
        .post('/api/v1/_test/audit/forbidden')
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A)
        .expect(403);
    const denials = () => rows("a.action = 'access.denied' AND a.actor_user_id = $1", [ANA.id]);

    it('acima do limite da janela, as negações não geram registro próprio', async () => {
      quiet();
      // A conexão inicial do cliente Redis é feita em segundo plano no bootstrap.
      const sampling = new RedisAuditSamplingStore(api.app.get(RedisClient), api.config);
      await vi.waitFor(
        () => sampling.sample({ tenantId: A, subject: 'warmup', action: 'x' }, 1, 1),
        {
          timeout: 10_000,
        },
      );
      const before = (await denials()).length;
      for (let attempt = 0; attempt < 5; attempt += 1) await deny();
      expect((await denials()).length - before).toBe(3);
    });

    it('[Falha de integração] Redis fora: cada negação grava o próprio registro e loga warn', async () => {
      quiet();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await redis.stop();
      redisStopped = true;
      const before = (await denials()).length;
      for (let attempt = 0; attempt < 5; attempt += 1) await deny();
      expect((await denials()).length - before).toBe(5);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'audit.sampling_unavailable' }),
        'audit.sampling_unavailable',
      );
    });
  });

  /** Variáveis mínimas de configuração para instanciar o serviço fora do Nest. */
  function configEnv(): Record<string, string> {
    return {
      APP_ENV: 'test',
      DATABASE_URL: db.url('cf_app'),
      REDIS_CACHE_URL: redisUrl,
      OIDC_ISSUER_URL: 'https://issuer.test/',
    };
  }
});

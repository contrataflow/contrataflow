// Suíte "tenant leak" HTTP (US-100 · RN-TEN-36 · multi-tenancy.md §14 · CA-T-01): API inteira sobre
// PostgreSQL real (Testcontainers + migrações), identidade e vínculos reais (só o verificador de JWT
// é o fake), tenants A e B com marcadores LEAK-A/LEAK-B. Para cada operação da API classificada no
// manifesto: IDs de B no caminho → 404; no corpo → 422 REFERENCE_NOT_FOUND; nenhuma resposta com
// dados de B; tabelas de B intactas. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { captureLogs } from '@contrataflow/observability/testing';
import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { API_MODULES } from '#modules/index.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';
import { DATABASE_CLIENT } from '#shared/database/database-client.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import { createApiLogger } from '#shared/observability/observability.module.js';

import { LeakProbeController, LeakProbeModule, PROBE_MANIFEST } from './leak-probe.controller.js';
import { collectControllers, collectOperations } from '../../src/openapi/openapi-document.js';
import { tenantLeakCoverageViolations } from '../../src/openapi/tenant-isolation-coverage.js';
import { TENANT_LEAK_MANIFEST } from '../../src/openapi/tenant-leak.manifest.js';
import type { LeakFixtureKind } from '../../src/openapi/tenant-leak.manifest.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000000a';
const B = '0192c000-0000-7000-8000-00000000000b';
const BRUNO = '0192c000-0000-7000-8000-0000000000b1';
const CARLA = '0192c000-0000-7000-8000-0000000000c1';
const DANIEL = '0192c000-0000-7000-8000-0000000000d1';
const BRUNO_A = '0192c000-0000-7000-8000-0000000001b1';
const CARLA_A = '0192c000-0000-7000-8000-0000000001c1';
const CARLA_B = '0192c000-0000-7000-8000-0000000002c1';
const DANIEL_B = '0192c000-0000-7000-8000-0000000002d1';
const DEPT_A = '0192c000-0000-7000-8000-0000000003a1';
const DEPT_B = '0192c000-0000-7000-8000-0000000003b1';

/** Fixtures do tenant B usadas nos caminhos e corpos (RN-TEN-36). */
const B_IDS: Readonly<Record<LeakFixtureKind, string>> = {
  membership: CARLA_B,
  department: DEPT_B,
  tenant: B,
};

/** Tudo que identifica B e nunca pode aparecer numa resposta para quem só tem A. */
const B_CANARIES = ['LEAK-B', B, CARLA_B, DANIEL_B, DEPT_B, DANIEL, 'daniel@prefeitura-b.test'];

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a', 'Prefeitura A LEAK-A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${BRUNO}', 'sub-bruno', 'bruno@prefeitura-a.test', true, 'Bruno Lima'),
  ('${CARLA}', 'sub-carla', 'carla@consultoria.test', true, 'Carla Dias'),
  ('${DANIEL}', 'sub-daniel', 'daniel@prefeitura-b.test', true, 'Daniel LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, job_title, expires_at) VALUES
  ('${BRUNO_A}', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE', 'LEAK-A', NULL),
  ('${CARLA_A}', '${A}', '${CARLA}', 'EXTERNAL', 'ACTIVE', 'LEAK-A', now() + interval '30 days'),
  ('${CARLA_B}', '${B}', '${CARLA}', 'EXTERNAL', 'ACTIVE', 'LEAK-B', now() + interval '30 days'),
  ('${DANIEL_B}', '${B}', '${DANIEL}', 'INTERNAL', 'ACTIVE', 'LEAK-B', NULL);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('${randomUUID()}', '${A}', '${BRUNO_A}', '${DEPT_A}', true),
  ('${randomUUID()}', '${B}', '${DANIEL_B}', '${DEPT_B}', true);
INSERT INTO document_types (id, tenant_id, code, name, kind) VALUES
  ('${randomUUID()}', '${A}', 'TIPO_A', 'Tipo LEAK-A', 'FREE_TEXT'),
  ('${randomUUID()}', '${B}', 'TIPO_B', 'Tipo LEAK-B', 'FREE_TEXT');
INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type, aggregate_id, payload, metadata) VALUES
  ('${randomUUID()}', '${B}', 'ProcessCreated', 'process.created', 'Process', '${randomUUID()}', '{"title":"LEAK-B"}', '{}');
INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, action, category, result, row_hash) VALUES
  ('${randomUUID()}', now(), '${B}', 'USER', 'process.create', 'DATA_CHANGE', 'SUCCESS', '${'b'.repeat(64)}');
`;

/** Retrato das tabelas de tenant de B (conteúdo completo, como superusuário). */
async function snapshotOfB(db: TestDatabase): Promise<Record<string, string>> {
  const tables = await db.admin<{ table_name: string }>(`
    SELECT c.table_name FROM information_schema.columns c
    JOIN pg_class k ON k.relname = c.table_name AND NOT k.relispartition
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`);
  const snapshot: Record<string, string> = {};
  for (const { table_name: table } of tables) {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '')
              AS digest FROM ${table} t WHERE tenant_id = $1`,
      [B],
    );
    snapshot[table] = row?.digest ?? '';
  }
  return snapshot;
}

function expectNoCanary(label: string, body: unknown): void {
  // `instance` do problem+json ecoa o caminho pedido (o ID que o próprio chamador enviou).
  const { instance: _instance, ...rest } = (body ?? {}) as Record<string, unknown>;
  const text = JSON.stringify(rest);
  for (const canary of B_CANARIES) {
    expect(text.includes(canary), `${label} vazou "${canary}"`).toBe(false);
  }
}

async function startApi(db: TestDatabase, overrides: Record<string, string> = {}) {
  const logs = captureLogs();
  const config = testConfig({
    OIDC_FAKE_SIGNING_KEY: '',
    DATABASE_URL: db.url('cf_app'),
    DATABASE_URL_PLATFORM: db.url('cf_platform'),
    ...overrides,
  });
  const api = await createTestApi({
    config,
    controllers: [LeakProbeController],
    logger: createApiLogger(config, logs.destination),
    providers: [
      {
        token: TOKEN_VERIFIER,
        value: new FakeJwksProvider({
          signingKey: TEST_SIGNING_KEY,
          issuer: TEST_ISSUER,
          audiences: config.oidc.audiences,
          clockToleranceSeconds: 30,
        }),
      },
    ],
  });
  return { api, logs };
}

describe('Feature: suíte "tenant leak" sobre a API inteira (US-100)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let logs: ReturnType<typeof captureLogs>;
  const as = (subject: string) => api.bearer(subject);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    ({ api, logs } = await startApi(db));
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] Bruno lista no contexto de A: set_config antes de tudo, só LEAK-A, tenantId nos logs', async () => {
    logs.clear();
    const context = await request(api.server)
      .get('/api/v1/_leak/context')
      .set('Authorization', as('sub-bruno'))
      .set('X-Tenant-Id', A);
    expect(context.body).toEqual({ data: { tenant: A } });

    const response = await request(api.server)
      .get('/api/v1/_leak/memberships')
      .set('Authorization', as('sub-bruno'))
      .set('X-Tenant-Id', A);
    expect(response.status).toBe(200);
    const rows = (response.body as { data: { id: string; jobTitle: string }[] }).data;
    expect(rows.map((row) => row.id).sort()).toEqual([BRUNO_A, CARLA_A].sort());
    expect(new Set(rows.map((row) => row.jobTitle))).toEqual(new Set(['LEAK-A']));
    expectNoCanary('LEAK-01', response.body);

    const requestLogs = logs
      .lines()
      .filter(
        (line) =>
          line.event === 'http.request.completed' && line.route === '/api/v1/_leak/memberships',
      );
    expect(requestLogs).toEqual([expect.objectContaining({ tenantId: A, userId: BRUNO })]);
  });

  it('[Tenant incorreto] ID de B no caminho → 404; ID de B no corpo → 422 REFERENCE_NOT_FOUND', async () => {
    const byPath = await request(api.server)
      .get(`/api/v1/_leak/memberships/${CARLA_B}`)
      .set('Authorization', as('sub-bruno'))
      .set('X-Tenant-Id', A);
    expect(byPath.status).toBe(404);
    expect(problemDetailsSchema.parse(byPath.body).code).toBe('MEMBERSHIP_NOT_FOUND');

    const byBody = await request(api.server)
      .post('/api/v1/_leak/membership-departments')
      .set('Authorization', as('sub-bruno'))
      .set('X-Tenant-Id', A)
      .send({ membershipId: CARLA_B, departmentId: DEPT_A });
    expect(byBody.status).toBe(422);
    expect(problemDetailsSchema.parse(byBody.body).errors).toEqual([
      expect.objectContaining({ field: 'membershipId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expectNoCanary('LEAK-03', byBody.body);
  });

  it('[Permissão] cabeçalho forjado (tenant de B) e tenant inexistente respondem igual', async () => {
    const forged = await request(api.server)
      .get('/api/v1/_leak/memberships')
      .set('Authorization', as('sub-bruno'))
      .set('X-Tenant-Id', B);
    const missing = await request(api.server)
      .get('/api/v1/_leak/memberships')
      .set('Authorization', as('sub-bruno'))
      .set('X-Tenant-Id', randomUUID());
    const first = problemDetailsSchema.parse(forged.body);
    const second = problemDetailsSchema.parse(missing.body);
    expect(forged.status).toBe(403);
    expect(first.code).toBe('MEMBERSHIP_INACTIVE');
    expect({ ...first, correlationId: '' }).toEqual({ ...second, correlationId: '' });
    expectNoCanary('cabeçalho forjado', forged.body);
  });

  it('[Tenant incorreto] toda operação classificada responde 404/422 com IDs de B, sem vazar nada e sem tocar em B', async () => {
    const operations = collectOperations(collectControllers([...API_MODULES, LeakProbeModule]));
    const manifest = { ...TENANT_LEAK_MANIFEST, ...PROBE_MANIFEST };
    expect(tenantLeakCoverageViolations(operations, manifest)).toEqual([]);

    const before = await snapshotOfB(db);
    const covered = operations.filter(
      (operation) => manifest[operation.spec.operationId]?.kind === 'covered',
    );
    expect(covered.map((operation) => operation.spec.operationId).sort()).toEqual([
      'DTY-01',
      'LEAK-01',
      'LEAK-02',
      'LEAK-03',
      'LEAK-04',
      'ME-01',
      'ME-04',
    ]);
    for (const operation of covered) {
      const entry = manifest[operation.spec.operationId];
      if (entry?.kind !== 'covered') continue;
      const path = operation.path.replace(/\{(\w+)\}/g, (_match, param: string) => {
        const kind = entry.pathParams?.[param];
        if (!kind) throw new Error(`${operation.spec.operationId}: ${param} sem fixture`);
        return B_IDS[kind];
      });
      const agent = request(api.server);
      let call = agent[operation.method](`/api/v1${path}`).set('Authorization', as('sub-bruno'));
      if ((operation.tenantScope ?? 'TENANT') === 'TENANT') call = call.set('X-Tenant-Id', A);
      const body = entry.body?.((kind) => B_IDS[kind]);
      const response = await (body === undefined ? call : call.send(body as object));
      const label = `${operation.method.toUpperCase()} ${operation.path} (${operation.spec.operationId})`;

      if (entry.pathParams && Object.keys(entry.pathParams).length > 0) {
        expect(response.status, label).toBe(404);
        expect(problemDetailsSchema.parse(response.body).code, label).toMatch(/NOT_FOUND$/);
      } else if (entry.referenceFields && entry.referenceFields.length > 0) {
        expect(response.status, label).toBe(422);
        const errors = problemDetailsSchema.parse(response.body).errors;
        for (const field of entry.referenceFields) {
          expect(errors, label).toContainEqual(
            expect.objectContaining({ field, code: 'REFERENCE_NOT_FOUND' }),
          );
        }
      } else {
        expect(response.status, label).toBeLessThan(300);
      }
      expectNoCanary(label, response.body);
    }
    expect(await snapshotOfB(db)).toEqual(before);
  });
});

describe('Feature: contexto não vaza entre transações no pool (US-100 · Concorrência)', () => {
  let db: TestDatabase;
  let api: TestApi;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    ({ api } = await startApi(db, { DATABASE_POOL_SIZE: '2' }));
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Concorrência] 500 requisições alternando A e B num pool de 2 conexões: cada uma só vê o próprio tenant', async () => {
    const expected: Record<string, string[]> = {
      [A]: [BRUNO_A, CARLA_A].sort(),
      [B]: [CARLA_B, DANIEL_B].sort(),
    };
    const call = (index: number) => {
      const tenant = index % 2 === 0 ? A : B;
      const subject = tenant === A ? 'sub-bruno' : 'sub-carla';
      return request(api.server)
        .get('/api/v1/_leak/memberships')
        .set('Authorization', api.bearer(subject))
        .set('X-Tenant-Id', tenant)
        .then((response) => ({ tenant, response }));
    };
    for (let start = 0; start < 500; start += 25) {
      const batch = await Promise.all(
        Array.from({ length: 25 }, (_, offset) => call(start + offset)),
      );
      for (const { tenant, response } of batch) {
        expect(response.status).toBe(200);
        const ids = (response.body as { data: { id: string }[] }).data.map((row) => row.id).sort();
        expect(ids).toEqual(expected[tenant]);
      }
    }

    // As duas conexões do pool, devolvidas, não guardam app.tenant_id fora de transação.
    const client = api.app.get<TenantPrismaClient>(DATABASE_CLIENT);
    const probe = () =>
      client.$platformTransaction(
        (tx) => tx.$queryRaw<{ value: string | null; pid: number }[]>`
          SELECT current_setting('app.tenant_id', true) AS value, pg_backend_pid() AS pid
            FROM pg_sleep(0.3)`,
      );
    const [first, second] = await Promise.all([probe(), probe()]);
    expect(new Set([first[0]?.pid, second[0]?.pid]).size).toBe(2);
    expect([first[0]?.value ?? '', second[0]?.value ?? '']).toEqual(['', '']);
  });
});

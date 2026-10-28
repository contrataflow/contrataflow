// Autorização na API inteira sobre PostgreSQL e Redis reais (US-097 · Tenant incorreto, Sucesso,
// Concorrência, Falha de integração · RN-IAM-102/103/104): as permissões efetivas saem de
// `role_assignments` + `role_permissions` + `membership_departments` + a árvore de `departments`
// lidas sob RLS, o retrato fica no Redis (`cf:test:t:{tenant}:access:eff:{membership}`), a
// revogação pela API troca o token de geração e o predicado SQL de visibilidade (DEC-024) é
// conferido contra tabelas reais de processo. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { MyPermissionsDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaRoleAssignmentRepository } from '#modules/access/infrastructure/role-assignment.repository.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PROCESS_RUNTIME_READER } from '#modules/process/application/ports.js';
import { InMemoryProcessRuntimeStore } from '#modules/process/infrastructure/process-runtime.readers.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';
import { isProcessVisible } from '#shared/auth/process-access.js';
import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { buildVisibilityPredicate } from '#shared/database/process-visibility.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { AuthorizationProbeController } from '../support/authorization-probe.controller.js';
import { processRuntime } from '../support/workflow-engine-fixtures.js';

const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

const A = '0192d000-0000-7000-8000-00000000970a';
const B = '0192d000-0000-7000-8000-00000000970b';
const DIEGO = '0192d000-0000-7000-8000-0000000970a1';
const MARTA = '0192d000-0000-7000-8000-0000000970a2';
const CAIO = '0192d000-0000-7000-8000-0000000970a3';
const BETO = '0192d000-0000-7000-8000-0000000970b1';
const M_DIEGO = '0192d000-0000-7000-8000-0000000974a1';
const M_MARTA = '0192d000-0000-7000-8000-0000000974a2';
const M_CAIO = '0192d000-0000-7000-8000-0000000974a3';
const M_BETO = '0192d000-0000-7000-8000-0000000974b1';
const ORG_A = '0192d000-0000-7000-8000-0000000971a1';
const ORG_B = '0192d000-0000-7000-8000-0000000971b1';
const OBRAS = '0192d000-0000-7000-8000-0000000972a1';
const PROJETOS = '0192d000-0000-7000-8000-0000000972a2';
const SAUDE = '0192d000-0000-7000-8000-0000000972a3';
const SETOR_B = '0192d000-0000-7000-8000-0000000972b1';
const ADMIN_A = '0192d000-0000-7000-8000-0000000973a1';
const REQ_A = '0192d000-0000-7000-8000-0000000973a2';
const ADMIN_B = '0192d000-0000-7000-8000-0000000973b1';
const RA_DIEGO = '0192d000-0000-7000-8000-0000000976a1';
const RA_MARTA = '0192d000-0000-7000-8000-0000000976a2';
const RA_BETO = '0192d000-0000-7000-8000-0000000976b1';
const P_PROJETOS = '0192d000-0000-7000-8000-0000000977a1';
const P_SAUDE = '0192d000-0000-7000-8000-0000000977a2';
const P_B = '0192d000-0000-7000-8000-0000000977b1';
const MFA = ['pwd', 'otp'];

const ADMIN_PERMISSIONS = ['ROLE_ASSIGN', 'ROLE_VIEW', 'USER_VIEW', 'USER_MANAGE', 'PROCESS_VIEW'];
const REQ_PERMISSIONS = ['PROCESS_VIEW', 'PROCESS_CREATE', 'COMMENT_CREATE'];

const grants = (tenant: string, role: string, codes: readonly string[], prefix: string) =>
  codes
    .map(
      (code, index) =>
        `('0192d000-0000-7000-8000-${prefix}${String(index).padStart(4, '0')}', '${tenant}', '${role}', '${code}')`,
    )
    .join(',\n  ');

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-authz', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-authz', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${DIEGO}', 'sub-diego', 'diego@a.test', true, 'Diego Obras'),
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Admin'),
  ('${CAIO}', 'sub-caio', 'caio@a.test', true, 'Caio Sem Perfil'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${M_DIEGO}', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('${M_MARTA}', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('${M_CAIO}', '${A}', '${CAIO}', 'INTERNAL', 'ACTIVE'),
  ('${M_BETO}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal', 'PMA', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '/${OBRAS}/', 0),
  ('${PROJETOS}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Projetos', '/${OBRAS}/${PROJETOS}/', 1),
  ('${SAUDE}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '/${SAUDE}/', 0),
  ('${SETOR_B}', '${B}', '${ORG_B}', NULL, 'SECTOR', 'Setor LEAK-B', '/${SETOR_B}/', 0);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192d000-0000-7000-8000-0000000975a1', '${A}', '${M_DIEGO}', '${OBRAS}', true);
INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES
  ('${ADMIN_A}', '${A}', 'ADMIN_ORGAO', 'Administrador do órgão', true),
  ('${REQ_A}', '${A}', 'REQUISITANTE', 'Requisitante', true),
  ('${ADMIN_B}', '${B}', 'ADMIN_ORGAO', 'Administrador LEAK-B', true);
INSERT INTO role_permissions (id, tenant_id, role_id, permission_code) VALUES
  ${grants(A, ADMIN_A, ADMIN_PERMISSIONS, '00978a00')},
  ${grants(A, REQ_A, REQ_PERMISSIONS, '00979a00')},
  ${grants(B, ADMIN_B, [...ADMIN_PERMISSIONS, 'PROCESS_CANCEL'], '00978b00')};
INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, include_subtree, granted_by_id, valid_from) VALUES
  ('${RA_DIEGO}', '${A}', '${M_DIEGO}', '${REQ_A}', 'OWN_DEPARTMENTS', true, '${MARTA}', now() - interval '1 day'),
  ('${RA_MARTA}', '${A}', '${M_MARTA}', '${ADMIN_A}', 'TENANT', false, '${MARTA}', now() - interval '1 day'),
  ('${RA_BETO}', '${B}', '${M_BETO}', '${ADMIN_B}', 'TENANT', false, '${BETO}', now() - interval '1 day');
`;

const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;

describe('Feature: autorização sobre PostgreSQL e Redis reais (US-097)', () => {
  let db: TestDatabase;
  let redis: StartedTestContainer;
  let api: TestApi;
  let cache: CacheStore;
  let redisStopped = false;
  const warn = vi.fn();

  const as = (test: request.Test, subject = 'sub-diego', tenant = A) =>
    test.set('Authorization', api.bearer(subject, { amr: MFA })).set('X-Tenant-Id', tenant);
  const create = (departmentId: string, subject?: string) =>
    as(request(api.server).post('/api/v1/_test/authz/processes'), subject).send({
      requestingDepartmentId: departmentId,
    });
  const view = (id: string, subject?: string, tenant?: string) =>
    as(request(api.server).get(`/api/v1/_test/authz/processes/${id}`), subject, tenant);
  const myPermissions = (subject?: string, tenant?: string) =>
    as(request(api.server).get('/api/v1/me/permissions'), subject, tenant);
  const snapshotKey = (tenant: string, membership: string) =>
    `cf:test:t:${tenant}:access:eff:${membership}`;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    [db, redis] = await Promise.all([
      startTestDatabase(),
      new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
    ]);
    await db.admin(FIXTURE_SQL);
    const processes = new InMemoryProcessRuntimeStore();
    const base = { workflowVersionId: P_B, passes: [] } as const;
    processes.save(
      processRuntime({ ...base, id: P_PROJETOS, tenantId: A, accessDepartmentIds: [PROJETOS] }),
    );
    processes.save(
      processRuntime({ ...base, id: P_SAUDE, tenantId: A, accessDepartmentIds: [SAUDE] }),
    );
    processes.save(
      processRuntime({ ...base, id: P_B, tenantId: B, accessDepartmentIds: [SETOR_B] }),
    );
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      REDIS_CACHE_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    });
    api = await createTestApi({
      config,
      stores: 'redis',
      controllers: [AuthorizationProbeController],
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
        { token: PROCESS_RUNTIME_READER, value: processes },
      ],
    });
    cache = api.app.get<CacheStore>(CACHE_STORE, { strict: false });
    // O cliente Redis conecta em segundo plano no bootstrap.
    await vi.waitFor(
      async () => {
        await cache.set('cf:test:p:warmup', '1', 5);
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    if (!redisStopped) await redis.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] processo de B → 404 PROCESS_NOT_FOUND; vínculo só em A → 403 em B', async () => {
    const ofB = await view(P_B);
    expect(ofB.status, JSON.stringify(ofB.body)).toBe(404);
    expect(codeOf(ofB)).toBe('PROCESS_NOT_FOUND');
    expect(JSON.stringify(ofB.body)).not.toMatch(/LEAK-B/);
    const inB = await myPermissions('sub-diego', B);
    expect(inB.status).toBe(403);
    expect(codeOf(inB)).toBe('MEMBERSHIP_INACTIVE');
    // Beto (ADMIN_ORGAO em B, com PROCESS_CANCEL) nunca aparece nas permissões de A.
    const mine = (await myPermissions()).body as { data: MyPermissionsDto };
    expect(mine.data.permissions.map((permission) => permission.code)).toEqual([
      'COMMENT_CREATE',
      'PROCESS_CREATE',
      'PROCESS_VIEW',
    ]);
    expect(await cache.get(snapshotKey(B, M_DIEGO))).toBeNull();
  });

  it('[Sucesso] escopo OWN_DEPARTMENTS com subárvore lido sob RLS e servido do Redis', async () => {
    const repository = api.app.get(PrismaRoleAssignmentRepository, { strict: false });
    const reads = vi.spyOn(repository, 'listByMembership');
    await cache.delete(snapshotKey(A, M_DIEGO));

    const first = await create(PROJETOS);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await cache.get(snapshotKey(A, M_DIEGO))).toContain(OBRAS);

    expect((await view(P_PROJETOS)).status).toBe(200);
    expect((await create(OBRAS)).status).toBe(201);
    const outside = await create(SAUDE);
    expect(outside.status).toBe(403);
    expect(codeOf(outside)).toBe('PERMISSION_DENIED');
    expect(codeOf(await view(P_SAUDE))).toBe('PROCESS_NOT_FOUND');
    // Cache quente: nenhuma nova leitura de `role_assignments`.
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  });

  it('vínculo sem nenhuma atribuição não tem permissão alguma (produção não usa a ponte)', async () => {
    const response = await create(OBRAS, 'sub-caio');
    expect(response.status).toBe(403);
    expect(codeOf(response)).toBe('PERMISSION_DENIED');
    const body = (await myPermissions('sub-caio')).body as { data: MyPermissionsDto };
    expect(body.data.permissions).toEqual([]);
  });

  it('[Concorrência] revogação pela API invalida o retrato no Redis: a próxima requisição nega', async () => {
    expect((await create(PROJETOS)).status).toBe(201);
    const revoked = await as(
      request(api.server).post(`/api/v1/role-assignments/${RA_DIEGO}/revoke`),
      'sub-marta',
    )
      .set('If-Match', '"1"')
      .send({ reason: 'Mudou de área' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(await cache.get(snapshotKey(A, M_DIEGO))).toBeNull();
    expect(await cache.get(`cf:test:t:${A}:access:eff-gen:${M_DIEGO}`)).toMatch(/^[0-9a-f-]{36}$/);

    const results = await Promise.all([create(PROJETOS), create(OBRAS)]);
    expect(results.map((response) => response.status)).toEqual([403, 403]);
    expect(codeOf(await view(P_PROJETOS))).toBe('PROCESS_NOT_FOUND');
  });

  describe('predicado SQL de visibilidade (DEC-024 · RN-IAM-103) no PostgreSQL', () => {
    const USER = '0192d000-0000-7000-8000-0000000980a1';
    const T = A;
    const OTHER = B;
    const ORG = ORG_A;
    const ids = {
      requesting: '0192d000-0000-7000-8000-0000000981a1',
      current: '0192d000-0000-7000-8000-0000000981a2',
      historical: '0192d000-0000-7000-8000-0000000981a3',
      ownGrant: '0192d000-0000-7000-8000-0000000981a4',
      revoked: '0192d000-0000-7000-8000-0000000981a5',
      deleted: '0192d000-0000-7000-8000-0000000981a6',
      organization: '0192d000-0000-7000-8000-0000000981a7',
      otherTenant: '0192d000-0000-7000-8000-0000000981b1',
    };

    beforeAll(async () => {
      // Só as colunas que o predicado usa, num schema próprio (as tabelas reais do agregado já
      // existem desde a US-001): a consulta resolve os nomes pelo `search_path` (`visible`).
      await db.admin(`
      CREATE SCHEMA ci_visibility;
      SET search_path TO ci_visibility;
      CREATE TABLE processes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
                              organization_id uuid, deleted_at timestamptz);
      CREATE TABLE process_access (tenant_id uuid NOT NULL, process_id uuid NOT NULL,
                                   principal_type text NOT NULL, department_id uuid, user_id uuid,
                                   reason text NOT NULL, revoked_at timestamptz, source_id uuid);
      CREATE TABLE process_participants (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
                                         expires_at timestamptz);
      INSERT INTO processes (id, tenant_id, organization_id, deleted_at) VALUES
        ('${ids.requesting}', '${T}', NULL, NULL),
        ('${ids.current}', '${T}', NULL, NULL),
        ('${ids.historical}', '${T}', NULL, NULL),
        ('${ids.ownGrant}', '${T}', NULL, NULL),
        ('${ids.revoked}', '${T}', NULL, NULL),
        ('${ids.deleted}', '${T}', NULL, now()),
        ('${ids.organization}', '${T}', '${ORG}', NULL),
        ('${ids.otherTenant}', '${OTHER}', '${ORG}', NULL);
      INSERT INTO process_access (tenant_id, process_id, principal_type, department_id, user_id, reason, revoked_at) VALUES
        ('${T}', '${ids.requesting}', 'DEPARTMENT', '${OBRAS}', NULL, 'REQUESTING', NULL),
        ('${T}', '${ids.current}', 'DEPARTMENT', '${PROJETOS}', NULL, 'CURRENT', NULL),
        ('${T}', '${ids.historical}', 'DEPARTMENT', '${OBRAS}', NULL, 'HISTORICAL', NULL),
        ('${T}', '${ids.ownGrant}', 'USER', NULL, '${USER}', 'CREATOR', NULL),
        ('${T}', '${ids.revoked}', 'DEPARTMENT', '${OBRAS}', NULL, 'PARTICIPANT', NULL),
        ('${T}', '${ids.revoked}', 'USER', NULL, '${USER}', 'PARTICIPANT', now()),
        ('${T}', '${ids.deleted}', 'DEPARTMENT', '${OBRAS}', NULL, 'REQUESTING', NULL),
        ('${OTHER}', '${ids.otherTenant}', 'DEPARTMENT', '${OBRAS}', NULL, 'REQUESTING', NULL);
    `);
    });

    async function visible(
      scope: Parameters<typeof buildVisibilityPredicate>[0],
      historicalDepartmentsCanView = true,
    ): Promise<string[]> {
      const predicate = buildVisibilityPredicate(scope, { historicalDepartmentsCanView });
      const client = new pg.Client({ connectionString: db.url('postgres') });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL search_path TO ci_visibility');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
        const rows = await client.query<{ id: string }>(
          `SELECT p.id FROM processes p WHERE ${predicate.text} ORDER BY p.id`,
          predicate.values,
        );
        await client.query('COMMIT');
        return rows.rows.map((row) => row.id);
      } finally {
        await client.end();
      }
    }

    const scope = (patch: Partial<Parameters<typeof buildVisibilityPredicate>[0]> = {}) => ({
      userId: USER,
      tenantWide: false,
      organizationIds: [],
      departmentIds: [],
      ...patch,
    });

    it('PROCESS_VIEW de TENANT vê tudo do tenant, nunca o descartado nem o de outro tenant', async () => {
      expect(await visible(scope({ tenantWide: true }))).toEqual(
        [
          ids.requesting,
          ids.current,
          ids.historical,
          ids.ownGrant,
          ids.revoked,
          ids.organization,
        ].sort(),
      );
    });

    // permissions.md §4 (US-012): a unidade participante dá visibilidade como REQUESTING/CURRENT;
    // o `revoked` entra pela unidade OBRAS participante, não pela concessão própria revogada.
    it('escopo de unidade expandido: REQUESTING/CURRENT/HISTORICAL e a unidade PARTICIPANT', async () => {
      expect(await visible(scope({ departmentIds: [OBRAS, PROJETOS] }))).toEqual(
        [ids.requesting, ids.current, ids.historical, ids.ownGrant, ids.revoked].sort(),
      );
      expect(await visible(scope({ departmentIds: [OBRAS, PROJETOS] }), false)).toEqual(
        [ids.requesting, ids.current, ids.ownGrant, ids.revoked].sort(),
      );
    });

    it('órgão do processo; concessão própria ativa (a revogada não vale)', async () => {
      expect(await visible(scope({ organizationIds: [ORG] }))).toEqual(
        [ids.ownGrant, ids.organization].sort(),
      );
      expect(await visible(scope())).toEqual([ids.ownGrant]);
    });

    it('equivale à checagem em memória usada na consulta por id (isProcessVisible)', async () => {
      const departments = scope({ departmentIds: [PROJETOS] });
      expect(await visible(departments)).toEqual([ids.current, ids.ownGrant].sort());
      expect(
        isProcessVisible(departments, {
          organizationId: null,
          departmentIds: [PROJETOS],
          userIds: [],
        }),
      ).toBe(true);
      expect(
        isProcessVisible(departments, {
          organizationId: null,
          departmentIds: [OBRAS],
          userIds: [],
        }),
      ).toBe(false);
    });
  });

  it('[Falha de integração] Redis fora do ar: decide pelo banco, corretamente, e loga warn', async () => {
    await redis.stop();
    redisStopped = true;
    const marta = await myPermissions('sub-marta');
    expect(marta.status, JSON.stringify(marta.body)).toBe(200);
    const denied = await create(OBRAS, 'sub-marta');
    expect(denied.status).toBe(403);
    expect(codeOf(denied)).toBe('PERMISSION_DENIED');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'authorization.cache_unavailable', membershipId: M_MARTA }),
      'authorization.cache_unavailable',
    );
  });
});

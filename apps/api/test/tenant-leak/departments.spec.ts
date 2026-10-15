// Secretarias e setores na API inteira sobre PostgreSQL real (US-102 · Tenant incorreto, Permissão,
// Validação, Duplicidade, Concorrência, Falha de banco, Falha de integração): administradores nos
// tenants A e B, auditoria e outbox reais na mesma transação, RLS, FKs compostas `RESTRICT`
// (pai do mesmo órgão, lotações, etapas de workflow), checks de caminho, trava consultiva da árvore
// e `FOR UPDATE` da subárvore. Perfis ainda não existem como registro (US-096): o vínculo ganha
// `roleKeys` por uma porta de teste sobre a `MembershipPort` real — e, por isso, só a lotação torna
// alguém elegível a titular aqui (RN-TEN-48).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DepartmentDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { TenantIsolationViolationError } from '#shared/database/errors.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192d000-0000-7000-8000-00000000102a';
const B = '0192d000-0000-7000-8000-00000000102b';
const CARLA = '0192d000-0000-7000-8000-0000000102a1';
const OTAVIO = '0192d000-0000-7000-8000-0000000102a2';
const BRUNO = '0192d000-0000-7000-8000-0000000102a3';
const PEDRO = '0192d000-0000-7000-8000-0000000102a4';
const BETO = '0192d000-0000-7000-8000-0000000102b1';
const PEDRO_A = '0192d000-0000-7000-8000-0000000103a4';
const PMSJ = '0192d000-0000-7000-8000-0000000104a1';
const FIB = '0192d000-0000-7000-8000-0000000104a2';
const ORG_B = '0192d000-0000-7000-8000-0000000104b1';
const SETOR_X_B = '0192d000-0000-7000-8000-0000000105b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['ADMIN_ORGAO'],
  [OTAVIO]: ['ADMIN_ORGAO'],
  [BRUNO]: ['GESTOR_CONTRATACOES'],
  [PEDRO]: ['REQUISITANTE'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-sao-jose-dep', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-dep', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Dias'),
  ('${OTAVIO}', 'sub-otavio', 'otavio@a.test', true, 'Otávio Reis'),
  ('${BRUNO}', 'sub-bruno', 'bruno@a.test', true, 'Bruno Lima'),
  ('${PEDRO}', 'sub-pedro', 'pedro@a.test', true, 'Pedro Alves'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192d000-0000-7000-8000-0000000103a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000103a2', '${A}', '${OTAVIO}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000103a3', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE'),
  ('${PEDRO_A}', '${A}', '${PEDRO}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000103b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${PMSJ}', '${A}', 'Prefeitura Municipal', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${FIB}', '${A}', 'Fundo inativo', 'FIB', '45997418000153', 'FUND', false),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${PMSJ}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, type, name, acronym, path, depth) VALUES
  ('${SETOR_X_B}', '${B}', '${ORG_B}', 'SECTOR', 'Setor X LEAK-B', 'SXB', '/${SETOR_X_B}/', 0);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (perfis como registro: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: secretarias e setores isolados por tenant sobre PostgreSQL (US-102)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string) => api.bearer(subject, { amr: MFA });
  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    subject: string,
    tenant = A,
  ) => {
    const test = request(api.server)[method](`/api/v1/departments${path}`);
    return test.set('Authorization', as(subject)).set('X-Tenant-Id', tenant);
  };
  const create = (body: Record<string, unknown>, subject = 'sub-carla', tenant = A) =>
    call('post', '', subject, tenant).send(body);
  const move = (id: string, parentId: string | null, ifMatch: string, subject = 'sub-carla') =>
    call('post', `/${id}/move`, subject).set('If-Match', ifMatch).send({ parentId });

  const row = async (id: string) =>
    (await db.admin<Row>('SELECT * FROM departments WHERE id = $1', [id]))[0];
  const digestOfB = async () => {
    const [result] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM departments t WHERE tenant_id = $1`,
      [B],
    );
    return result?.digest;
  };
  const events = (aggregateId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [aggregateId],
    );
  const audits = (entityId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, result, reason_code, actor_user_id, metadata
         FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at`,
      [entityId],
    );
  const unit = async (name: string, extra: Record<string, unknown> = {}) => {
    const response = await create({ organizationId: PMSJ, type: 'SECTOR', name, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: DepartmentDto }).data;
  };
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
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
    membership.inner = api.app.get(PrismaIdentityRepository);
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso][Falha de integração] criar secretaria na raiz: linha depth 0, auditoria e evento PENDING (sem relay)', async () => {
    const before = await digestOfB();
    const response = await create({
      organizationId: PMSJ,
      type: 'SECRETARIAT',
      name: 'Secretaria de Obras',
      acronym: 'SOB',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: DepartmentDto }).data;
    expect(await row(created.id)).toMatchObject({
      tenant_id: A,
      organization_id: PMSJ,
      parent_id: null,
      path: `/${created.id}/`,
      depth: 0,
      is_active: true,
      version: 1,
      created_by_id: CARLA,
    });
    expect(await audits(created.id)).toEqual([
      expect.objectContaining({ tenant_id: A, action: 'department.create', result: 'SUCCESS' }),
    ]);
    expect(await events(created.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        event_type: 'DepartmentCreated',
        routing_key: 'department.created',
        status: 'PENDING',
      }),
    ]);
    expect(await digestOfB()).toBe(before);
  });

  it('[Sucesso] mover subárvore de 3 níveis recalcula todos os descendentes numa transação', async () => {
    const origem = await unit('Secretaria de Origem', { type: 'SECRETARIAT' });
    const destino = await unit('Secretaria de Destino', { type: 'SECRETARIAT' });
    const div = await unit('Divisão', { type: 'DIVISION', parentId: origem.id });
    const setor = await unit('Setor', { parentId: div.id });
    const nucleo = await unit('Núcleo', { type: 'OTHER', parentId: setor.id });

    const response = await move(div.id, destino.id, '"1"');

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await row(div.id)).toMatchObject({
      parent_id: destino.id,
      path: `/${destino.id}/${div.id}/`,
      depth: 1,
      version: 2,
    });
    expect(await row(setor.id)).toMatchObject({
      path: `/${destino.id}/${div.id}/${setor.id}/`,
      depth: 2,
      version: 1,
    });
    expect(await row(nucleo.id)).toMatchObject({
      path: `/${destino.id}/${div.id}/${setor.id}/${nucleo.id}/`,
      depth: 3,
    });
    const moved = (await audits(div.id)).at(-1);
    expect(moved?.action).toBe('department.move');
    expect(moved?.metadata).toMatchObject({ descendantsRecalculated: 2, toParentId: destino.id });
    expect((await events(div.id)).at(-1)).toMatchObject({
      event_type: 'DepartmentMoved',
      status: 'PENDING',
    });
  });

  it('[Validação] titular sem lotação nem escopo → 422 REFERENCE_NOT_FOUND; lotado na unidade → aceito', async () => {
    const obras = await unit('Secretaria de Obras Públicas', { type: 'SECRETARIAT' });
    const refused = await call('patch', `/${obras.id}`, 'sub-carla')
      .set('If-Match', '"1"')
      .send({ headUserId: PEDRO });
    expect(refused.status).toBe(422);
    expect(problemDetailsSchema.parse(refused.body).errors).toEqual([
      expect.objectContaining({ field: 'headUserId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    await db.admin(
      `INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary)
       VALUES ('${randomUUID()}', '${A}', '${PEDRO_A}', '${obras.id}', true)`,
    );
    const accepted = await call('patch', `/${obras.id}`, 'sub-carla')
      .set('If-Match', '"1"')
      .send({ headUserId: PEDRO });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await row(obras.id)).toMatchObject({ head_user_id: PEDRO, version: 2 });
    // A OrganizationFacade enxerga o titular (US-061/US-040 — aprovador DEPARTMENT_HEAD).
    expect((await events(obras.id)).at(-1)).toMatchObject({ event_type: 'DepartmentUpdated' });
  });

  it('[Permissão] sem DEPARTMENT_MANAGE → 403 PERMISSION_DENIED e access.denied gravado; leitura segue permitida', async () => {
    const response = await create(
      { organizationId: PMSJ, type: 'SECTOR', name: 'Setor Negado' },
      'sub-bruno',
    );
    expect(response.status).toBe(403);
    expect(codeOf(response)).toBe('PERMISSION_DENIED');
    const denied = await db.admin<Row>(
      `SELECT tenant_id, result, reason_code FROM audit_logs
        WHERE action = 'access.denied' AND actor_user_id = $1`,
      [BRUNO],
    );
    expect(denied).toEqual([
      expect.objectContaining({ tenant_id: A, result: 'DENIED', reason_code: 'DEPARTMENT_MANAGE' }),
    ]);
    expect(
      await db.admin('SELECT 1 FROM departments WHERE name = $1', ['Setor Negado']),
    ).toHaveLength(0);
    expect((await call('get', '', 'sub-bruno')).status).toBe(200);
  });

  it('[Tenant incorreto] unidade de B: parentId → 422 sem vazamento; por id → 404; listas sem B; B intacto', async () => {
    const before = await digestOfB();
    const byBody = await create({
      organizationId: PMSJ,
      type: 'SECTOR',
      name: 'Setor sob B',
      parentId: SETOR_X_B,
    });
    expect(byBody.status).toBe(422);
    expect(problemDetailsSchema.parse(byBody.body).errors).toEqual([
      expect.objectContaining({ field: 'parentId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expect(JSON.stringify(byBody.body)).not.toMatch(/LEAK-B|SXB/);
    const orgOfB = await create({ organizationId: ORG_B, type: 'SECTOR', name: 'No órgão de B' });
    expect(problemDetailsSchema.parse(orgOfB.body).errors).toEqual([
      expect.objectContaining({ field: 'organizationId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const headOfB = await create({
      organizationId: PMSJ,
      type: 'SECTOR',
      name: 'Titular de B',
      headUserId: BETO,
    });
    expect(problemDetailsSchema.parse(headOfB.body).errors).toEqual([
      expect.objectContaining({ field: 'headUserId', code: 'REFERENCE_NOT_FOUND' }),
    ]);

    expect((await call('get', `/${SETOR_X_B}`, 'sub-carla')).status).toBe(404);
    expect(
      (
        await call('patch', `/${SETOR_X_B}`, 'sub-carla')
          .set('If-Match', '"1"')
          .send({ name: 'Invadido por A' })
      ).status,
    ).toBe(404);
    expect((await move(SETOR_X_B, null, '"1"')).status).toBe(404);
    expect((await call('delete', `/${SETOR_X_B}`, 'sub-carla').set('If-Match', '"1"')).status).toBe(
      404,
    );
    for (const path of ['?pageSize=100', '/lookup?q=LEAK']) {
      expect(JSON.stringify((await call('get', path, 'sub-carla')).body)).not.toMatch(/LEAK-B/);
    }
    // B vê só o que é seu.
    const fromB = await call('get', '?pageSize=100', 'sub-beto', B);
    expect((fromB.body as { data: DepartmentDto[] }).data.map((d) => d.id)).toEqual([SETOR_X_B]);
    expect(await digestOfB()).toBe(before);

    // RLS + extensão de isolamento: a transação de A não lê B nem com filtro explícito.
    const app = db.client('cf_app');
    await expect(
      asTenant(A, () =>
        app.$tenantTransaction((tx) => tx.department.findMany({ where: { tenantId: B } })),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationViolationError);
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) =>
          tx.$queryRaw<
            { total: bigint }[]
          >`SELECT count(*) AS total FROM departments WHERE id = ${SETOR_X_B}::uuid`,
      ),
    );
    expect(Number(visible[0]?.total)).toBe(0);
  });

  it('[Duplicidade] sigla repetida no órgão → 422 acronym; nomes iguais criados juntos → uma 201 e uma 422', async () => {
    const dup = await create({
      organizationId: PMSJ,
      type: 'SECRETARIAT',
      name: 'Outra de Obras',
      acronym: 'sob',
    });
    expect(dup.status).toBe(422);
    expect(problemDetailsSchema.parse(dup.body).errors).toEqual([
      expect.objectContaining({ field: 'acronym', code: 'INVALID_FORMAT' }),
    ]);
    const body = { organizationId: PMSJ, type: 'SECRETARIAT', name: 'Secretaria Gêmea' };
    const [one, two] = await Promise.all([create(body), create(body, 'sub-otavio')]);
    expect([one.status, two.status].sort()).toEqual([201, 422]);
    expect(
      await db.admin('SELECT 1 FROM departments WHERE lower(name) = lower($1)', [body.name]),
    ).toHaveLength(1);
  });

  it('[Concorrência] mover A para dentro de B e B para dentro de A ao mesmo tempo: uma aplicada, árvore sem ciclo', async () => {
    const sec = await unit('Secretaria Concorrente', { type: 'SECRETARIAT' });
    const setorA = await unit('Setor A', { parentId: sec.id });
    const setorB = await unit('Setor B', { parentId: sec.id });

    const [one, two] = await Promise.all([
      move(setorA.id, setorB.id, '"1"'),
      move(setorB.id, setorA.id, '"1"', 'sub-otavio'),
    ]);

    expect([one.status, two.status].sort()).toEqual([200, 422]);
    const failed = one.status === 200 ? two : one;
    expect(['DEPARTMENT_CYCLE', 'VERSION_CONFLICT']).toContain(codeOf(failed));
    const a = await row(setorA.id);
    const b = await row(setorB.id);
    expect(
      [a?.parent_id, b?.parent_id].filter((p) => p === setorA.id || p === setorB.id),
    ).toHaveLength(1);
    // Nenhum caminho repete um id (sem ciclo) e todos começam pela secretaria.
    const paths = await db.admin<{ path: string }>(
      `SELECT path FROM departments WHERE path LIKE $1`,
      [`/${sec.id}/%`],
    );
    for (const { path } of paths) {
      const ids = path.split('/').filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('[Referências] excluir com sub-unidade, lotação ou etapa de workflow fixa → 409; sem referências → 204', async () => {
    const pai = await unit('Secretaria Referenciada', { type: 'SECRETARIAT' });
    const filho = await unit('Setor Filho', { parentId: pai.id });
    const lotado = await unit('Setor Lotado');
    const fixo = await unit('Setor do Workflow');
    const livre = await unit('Setor Livre');
    await db.admin(
      `INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary)
       VALUES ('${randomUUID()}', '${A}', '${PEDRO_A}', '${lotado.id}', false)`,
    );
    const workflow = randomUUID();
    const version = randomUUID();
    await db.admin(`
      INSERT INTO workflows (id, tenant_id, key, name) VALUES ('${workflow}', '${A}', 'WF_DEP', 'Workflow com unidade fixa');
      INSERT INTO workflow_versions (id, tenant_id, workflow_id, version_number)
        VALUES ('${version}', '${A}', '${workflow}', 1);
      INSERT INTO workflow_stages (id, tenant_id, workflow_version_id, key, name, type, display_order,
                                   department_resolution, fixed_department_id)
        VALUES ('${randomUUID()}', '${A}', '${version}', 'FIXA', 'Fixa', 'TASK', 1, 'FIXED', '${fixo.id}');
    `);

    const references = async (id: string) => {
      const response = await call('delete', `/${id}`, 'sub-carla').set('If-Match', '"1"');
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(codeOf(response)).toBe('DEPARTMENT_HAS_REFERENCES');
      return (response.body as { references: string[] }).references;
    };
    expect(await references(pai.id)).toEqual(['SUBUNITS']);
    expect(await references(lotado.id)).toEqual(['ASSIGNMENTS']);
    expect(await references(fixo.id)).toEqual(['WORKFLOW_STAGES']);
    for (const id of [pai.id, filho.id, lotado.id, fixo.id]) expect(await row(id)).toBeDefined();

    const removed = await call('delete', `/${livre.id}`, 'sub-carla').set('If-Match', '"1"');
    expect(removed.status).toBe(204);
    expect(await row(livre.id)).toBeUndefined();
    expect((await audits(livre.id)).at(-1)).toMatchObject({ action: 'department.delete' });
  });

  it('[Banco] checks de caminho, pai do mesmo órgão, titular ≠ substituto e órgão imutável', async () => {
    const id = randomUUID();
    const insert = (values: string) =>
      db.admin(
        `INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth,
                                  head_user_id, deputy_user_id) VALUES ${values}`,
      );
    await expect(
      insert(
        `('${id}', '${A}', '${PMSJ}', NULL, 'SECTOR', 'Caminho errado', '/x/', 0, NULL, NULL)`,
      ),
    ).rejects.toThrow(/departments_path/);
    await expect(
      insert(
        `('${id}', '${A}', '${PMSJ}', NULL, 'SECTOR', 'Prof. errada', '/${id}/', 1, NULL, NULL)`,
      ),
    ).rejects.toThrow(/departments_depth_matches_path|departments_root_depth/);
    await expect(
      insert(
        `('${id}', '${A}', '${PMSJ}', NULL, 'SECTOR', 'Mesma pessoa', '/${id}/', 0, '${CARLA}', '${CARLA}')`,
      ),
    ).rejects.toThrow(/departments_head_distinct_deputy/);
    const outroOrgao = await unit('Unidade do órgão inativo?', {});
    await expect(
      insert(
        `('${id}', '${A}', '${FIB}', '${outroOrgao.id}', 'SECTOR', 'Pai de outro órgão', '${outroOrgao.path}${id}/', 1, NULL, NULL)`,
      ),
    ).rejects.toThrow(/departments_parent_fkey/);
    await expect(
      db.admin(`UPDATE departments SET organization_id = '${FIB}' WHERE id = '${outroOrgao.id}'`),
    ).rejects.toThrow(/imutáveis|organization_id/);
  });

  it('[Falha de banco] banco indisponível ao mover → 503 DEPENDENCY_UNAVAILABLE', async () => {
    const sec = await unit('Secretaria Final', { type: 'SECRETARIAT' });
    const filho = await unit('Setor Final', { parentId: sec.id });
    dbStopped = true;
    await db.container.stop();
    const response = await move(filho.id, null, '"1"');
    expect(response.status).toBe(503);
    expect(codeOf(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});

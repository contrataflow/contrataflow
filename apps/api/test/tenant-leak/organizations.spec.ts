// Órgãos/entidades na API inteira sobre PostgreSQL real (US-101 · Tenant incorreto, Permissão,
// Duplicidade, Concorrência, Falha de banco, Falha de integração): administradores nos tenants A e
// B, auditoria e outbox reais na mesma transação, RLS, índices únicos, FK composta do órgão
// principal e a extensão de isolamento. Perfis ainda não existem como registro (US-096): o vínculo
// ganha `roleKeys` por uma porta de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { OrganizationDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000101a';
const B = '0192c000-0000-7000-8000-00000000101b';
const MARTA = '0192c000-0000-7000-8000-0000000101a1';
const LUCIA = '0192c000-0000-7000-8000-0000000101a2';
const BETO = '0192c000-0000-7000-8000-0000000101b1';
const PMSJ = '0192c000-0000-7000-8000-0000000102a1';
const SEC_B = '0192c000-0000-7000-8000-0000000102b1';
const SEC_B_OFF = '0192c000-0000-7000-8000-0000000102b2';
const MFA = ['pwd', 'otp'];

const CNPJ = {
  pmsj: '11222333000181',
  fms: '11.444.777/0001-61',
  autarquia: '45.997.418/0001-53',
  concorrente: '33.000.167/0001-01',
  secB: '60746948000112',
  secBOff: '00000000000191',
} as const;

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-org', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-org', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${LUCIA}', 'sub-lucia', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000103a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000103a2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000103b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${PMSJ}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '${CNPJ.pmsj}', 'DIRECT_ADMINISTRATION', true),
  ('${SEC_B}', '${B}', 'Secretaria LEAK-B', 'SEC', '${CNPJ.secB}', 'DIRECT_ADMINISTRATION', true),
  ('${SEC_B_OFF}', '${B}', 'Fundo inativo LEAK-B', 'FIB', '${CNPJ.secBOff}', 'FUND', false);
UPDATE tenants SET primary_organization_id = '${PMSJ}' WHERE id = '${A}';
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

describe('Feature: órgãos isolados por tenant sobre PostgreSQL (US-101)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string, amr: readonly string[] = MFA) => api.bearer(subject, { amr });
  const organizationsOf = (tenantId: string) =>
    db.admin<Row>(
      'SELECT id, short_name, cnpj, name, version, is_active FROM organizations WHERE tenant_id = $1 ORDER BY short_name',
      [tenantId],
    );
  const digestOf = async (tenantId: string) => {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM organizations t WHERE tenant_id = $1`,
      [tenantId],
    );
    return row?.digest;
  };
  const events = (aggregateId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [aggregateId],
    );
  const audits = (entityId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, result, reason_code, actor_user_id, changes
         FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at`,
      [entityId],
    );

  const post = (subject: string, tenant: string, body: unknown, amr = MFA) =>
    request(api.server)
      .post('/api/v1/organizations')
      .set('Authorization', as(subject, amr))
      .set('X-Tenant-Id', tenant)
      .send(body as object);
  const patch = (
    subject: string,
    tenant: string,
    id: string,
    body: unknown,
    ifMatch: string,
    amr = MFA,
  ) =>
    request(api.server)
      .patch(`/api/v1/organizations/${id}`)
      .set('Authorization', as(subject, amr))
      .set('X-Tenant-Id', tenant)
      .set('If-Match', ifMatch)
      .send(body as object);
  const get = (subject: string, tenant: string, path = '') =>
    request(api.server)
      .get(`/api/v1/organizations${path}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant);

  const body = (overrides: Record<string, unknown> = {}) => ({
    name: 'Fundo Municipal de Saúde',
    shortName: 'FMS',
    cnpj: CNPJ.fms,
    type: 'FUND',
    ...overrides,
  });
  const idOf = async (tenantId: string, shortName: string) =>
    ((await organizationsOf(tenantId)).find((row) => row.short_name === shortName)?.id ??
      '') as string;

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

  it('[Sucesso] Marta cria um órgão: linha, auditoria e evento PENDING no banco, só em A', async () => {
    const digestOfB = await digestOf(B);

    const response = await post('sub-marta', A, body({ shortName: 'fms' }));

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    const created = (response.body as { data: OrganizationDto }).data;
    expect(created).toMatchObject({ shortName: 'FMS', cnpj: '11444777000161', isPrimary: false });
    const [row] = await db.admin<Row>('SELECT * FROM organizations WHERE id = $1', [created.id]);
    expect(row).toMatchObject({
      tenant_id: A,
      short_name: 'FMS',
      cnpj: '11444777000161',
      type: 'FUND',
      is_active: true,
      version: 1,
      created_by_id: MARTA,
      metadata: {},
    });
    expect(await audits(created.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        action: 'organization.create',
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actor_user_id: MARTA,
      }),
    ]);
    // [Falha de integração] o relay não roda aqui: o evento fica PENDING até ele voltar.
    expect(await events(created.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        event_type: 'OrganizationCreated',
        routing_key: 'organization.created',
        status: 'PENDING',
        payload: { organizationId: created.id },
      }),
    ]);
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Sucesso] PATCH com If-Match: nova versão, auditoria campo a campo e evento com changedFields', async () => {
    const id = await idOf(A, 'FMS');

    const response = await patch(
      'sub-marta',
      A,
      id,
      { name: 'Fundo Municipal de Saúde de São José', phone: '4833810000' },
      '"1"',
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    const trail = await audits(id);
    expect(trail.map((entry) => entry.action)).toEqual([
      'organization.create',
      'organization.update',
    ]);
    expect(trail[1]?.changes).toEqual([
      {
        path: 'name',
        old: 'Fundo Municipal de Saúde',
        new: 'Fundo Municipal de Saúde de São José',
      },
      { path: 'phone', old: null, new: '4833810000' },
    ]);
    const published = await events(id);
    expect(published.map((event) => event.event_type)).toEqual([
      'OrganizationCreated',
      'OrganizationUpdated',
    ]);
    expect(published[1]?.payload).toEqual({
      organizationId: id,
      changedFields: ['name', 'phone'],
    });
  });

  it('[Tenant incorreto] órgão de B → 404 e B intacto; a lista de A não mostra nada de B; mesma sigla em A é permitida', async () => {
    const digestOfB = await digestOf(B);
    const auditsBefore = await db.admin('SELECT 1 FROM audit_logs WHERE tenant_id = $1', [B]);

    const response = await patch('sub-marta', A, SEC_B, { name: 'Invadida' }, '"1"');
    expect(response.status).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
    expect((await get('sub-marta', A, `/${SEC_B}`)).status).toBe(404);
    expect(await digestOf(B)).toBe(digestOfB);
    expect(await db.admin('SELECT 1 FROM audit_logs WHERE tenant_id = $1', [B])).toHaveLength(
      auditsBefore.length,
    );

    const list = await get('sub-marta', A);
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    for (const canary of ['LEAK-B', CNPJ.secB, SEC_B, SEC_B_OFF, B]) {
      expect(text.includes(canary), `vazou ${canary}`).toBe(false);
    }
    // Sigla "SEC" e CNPJ do órgão de B não bloqueiam a criação em A (unicidade por tenant).
    const same = await post(
      'sub-marta',
      A,
      body({ name: 'Secretaria de A', shortName: 'SEC', cnpj: CNPJ.secB }),
    );
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    expect(await digestOf(B)).toBe(digestOfB);

    const ofB = await get('sub-beto', B);
    expect((ofB.body as { data: OrganizationDto[] }).data.map((org) => org.shortName)).toEqual([
      'FIB',
      'SEC',
    ]);
  });

  it('[Tenant incorreto] logoAttachmentId de outro tenant ou inexistente → 422 REFERENCE_NOT_FOUND', async () => {
    const id = await idOf(A, 'PMSJ');
    const response = await patch(
      'sub-marta',
      A,
      id,
      { logoAttachmentId: '0192c000-0000-7000-8000-0000000199b1' },
      '"1"',
    );
    expect(response.status).toBe(422);
    expect(problemDetailsSchema.parse(response.body).errors).toEqual([
      expect.objectContaining({ field: 'logoAttachmentId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
  });

  it('[Tenant incorreto] o tenant não aponta para órgão de outro tenant (FK composta)', async () => {
    await expect(
      db.admin(`UPDATE tenants SET primary_organization_id = '${SEC_B}' WHERE id = '${A}'`),
    ).rejects.toThrow(/tenants_primary_organization_fkey|foreign key/i);
    const [tenant] = await db.admin<Row>(
      'SELECT primary_organization_id FROM tenants WHERE id = $1',
      [A],
    );
    expect(tenant?.primary_organization_id).toBe(PMSJ);
  });

  it('[Permissão] sem ORGANIZATION_MANAGE → 403 e access.denied gravado; leitura segue permitida', async () => {
    const before = (await organizationsOf(A)).length;
    const response = await post(
      'sub-lucia',
      A,
      body({ shortName: 'PROIBIDO', cnpj: CNPJ.concorrente }),
    );
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PERMISSION_DENIED');
    expect(await organizationsOf(A)).toHaveLength(before);
    const denied = await db.admin<Row>(
      `SELECT tenant_id, result, reason_code FROM audit_logs
        WHERE action = 'access.denied' AND actor_user_id = $1`,
      [LUCIA],
    );
    expect(denied).toContainEqual(
      expect.objectContaining({
        tenant_id: A,
        result: 'DENIED',
        reason_code: 'ORGANIZATION_MANAGE',
      }),
    );
    expect((await get('sub-lucia', A)).status).toBe(200);
  });

  it('[Permissão] sessão sem MFA → 403 MFA_REQUIRED e nada persistido', async () => {
    const id = await idOf(A, 'PMSJ');
    const response = await patch('sub-marta', A, id, { name: 'Sem MFA' }, '"1"', ['pwd']);
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('MFA_REQUIRED');
    expect((await organizationsOf(A)).find((row) => row.short_name === 'PMSJ')).toMatchObject({
      name: 'Prefeitura Municipal de São José',
      version: 1,
    });
  });

  it('[Duplicidade] sigla ou CNPJ repetidos no tenant → 422; criação concorrente → uma 201 e uma 422', async () => {
    const sigla = await post('sub-marta', A, body({ shortName: 'pmsj', cnpj: CNPJ.concorrente }));
    expect(sigla.status).toBe(422);
    expect(problemDetailsSchema.parse(sigla.body).errors).toEqual([
      expect.objectContaining({ field: 'shortName', code: 'INVALID_FORMAT' }),
    ]);
    const cnpj = await post(
      'sub-marta',
      A,
      body({ shortName: 'OUTRA', cnpj: '11.222.333/0001-81' }),
    );
    expect(cnpj.status).toBe(422);
    expect(problemDetailsSchema.parse(cnpj.body).errors).toEqual([
      expect.objectContaining({ field: 'cnpj', code: 'INVALID_CNPJ' }),
    ]);

    const concurrent = body({ name: 'Autarquia', shortName: 'AUT', cnpj: CNPJ.autarquia });
    const results = await Promise.all([
      post('sub-marta', A, concurrent),
      post('sub-marta', A, concurrent),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
    const id = await idOf(A, 'AUT');
    expect((await organizationsOf(A)).filter((row) => row.short_name === 'AUT')).toHaveLength(1);
    // O vencedor tem uma auditoria e um evento; o perdedor não deixou rastro.
    expect(await audits(id)).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
  });

  it('[RN-TEN-41] inativar o órgão principal → 409; o único órgão ativo do tenant (B) → 409; reativar volta', async () => {
    const primary = await patch('sub-marta', A, PMSJ, { isActive: false }, '"1"');
    expect(primary.status).toBe(409);
    expect(problemDetailsSchema.parse(primary.body).code).toBe('PRIMARY_ORGANIZATION_REQUIRED');

    // Tenant B: SEC é o único ativo (FIB já está inativo) e B nem tem órgão principal definido.
    const lonely = await patch('sub-beto', B, SEC_B, { isActive: false }, '"1"');
    expect(lonely.status).toBe(409);
    expect(problemDetailsSchema.parse(lonely.body).code).toBe('PRIMARY_ORGANIZATION_REQUIRED');
    expect((await organizationsOf(B)).find((row) => row.short_name === 'SEC')).toMatchObject({
      is_active: true,
      version: 1,
    });
    expect(await audits(SEC_B)).toHaveLength(0);

    // Reativando o outro órgão de B, SEC já pode ser inativado — e FIB volta a ser ativo.
    const reactivate = await patch('sub-beto', B, SEC_B_OFF, { isActive: true }, '"1"');
    expect(reactivate.status, JSON.stringify(reactivate.body)).toBe(200);
    const inactivate = await patch('sub-beto', B, SEC_B, { isActive: false }, '"1"');
    expect(inactivate.status, JSON.stringify(inactivate.body)).toBe(200);
  });

  it('[Concorrência] mesma versão em duas edições: uma 200 e outra 412 VERSION_CONFLICT com currentVersion', async () => {
    const id = await idOf(A, 'AUT');
    const results = await Promise.all([
      patch('sub-marta', A, id, { addressCity: 'São José' }, '"1"'),
      patch('sub-marta', A, id, { addressCity: 'Palhoça' }, '"1"'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const loser = results.find((result) => result.status === 412);
    expect(problemDetailsSchema.parse(loser?.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 2,
    });
    expect((await organizationsOf(A)).find((row) => row.short_name === 'AUT')?.version).toBe(2);
    // A edição perdedora não deixou auditoria nem evento próprios.
    expect(await audits(id)).toHaveLength(2);
    expect(await events(id)).toHaveLength(2);
  });

  it('[Banco] checks de formato, trigger de tenant e ausência de DELETE para a aplicação', async () => {
    await expect(
      db.admin(
        `INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type)
         VALUES ('0192c000-0000-7000-8000-0000000104a1', '${A}', 'Sigla minúscula', 'abc', '11111111000191', 'OTHER')`,
      ),
    ).rejects.toThrow(/organizations_short_name_format/);
    await expect(
      db.admin(
        `INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type)
         VALUES ('0192c000-0000-7000-8000-0000000104a2', '${A}', 'CNPJ curto', 'ABC', '123', 'OTHER')`,
      ),
    ).rejects.toThrow(/organizations_cnpj_format/);
    await expect(
      db.admin(`UPDATE organizations SET tenant_id = '${B}' WHERE id = '${PMSJ}'`),
    ).rejects.toThrow(/imutável|tenant_id/);
    const app = db.client('cf_app');
    await expect(
      asTenant(A, () =>
        app.$tenantTransaction((tx) => tx.organization.deleteMany({ where: { id: PMSJ } })),
      ),
    ).rejects.toSatisfy((error: unknown) => /permission denied/i.test(String(error)));
    expect((await organizationsOf(A)).some((row) => row.id === PMSJ)).toBe(true);
  });

  it('[Falha de banco] banco indisponível ao salvar → 503 com Retry-After', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await post(
      'sub-marta',
      A,
      body({ name: 'Sem banco', shortName: 'SB', cnpj: CNPJ.concorrente }),
    );
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});

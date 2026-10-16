// Provisionamento de tenant na API inteira sobre PostgreSQL real (US-099): SystemDbService
// (`cf_platform`) para `tenants`, auditoria e eventos do agregado `Tenant`; seeders reais (perfis,
// tipos de documento, primeiro administrador) em `TenantTransaction` do tenant novo sob RLS.
// Cobre: sucesso, seeders só no tenant novo, operador sem vínculo, retomada após falha injetada
// sem linhas duplicadas, reexecução sem nenhuma linha nova, concorrência no slug, suspensão com
// efeito imediato no guard e as garantias do banco (slug imutável, impressão do pedido só do
// `cf_platform`). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { PlatformTenantDto, ProvisionTenantResultDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SystemDocumentTypesSeeder } from '#modules/document/application/system-document-types.seeder.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const PALHOCA = '0192c000-0000-7000-8000-00000000099a';
const CARLA = '0192c000-0000-7000-8000-0000000099c1';
const PEDRO = '0192c000-0000-7000-8000-0000000099a1';
const MFA = ['pwd', 'otp'];

/** Tabelas de tenant escritas pelo provisionamento (contagem por tenant). */
const TENANT_TABLES = [
  'roles',
  'role_permissions',
  'document_types',
  'organizations',
  'tenant_settings',
  'tenant_memberships',
  'workflows',
  'workflow_versions',
  'audit_logs',
  'outbox_events',
] as const;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${PALHOCA}', 'palhoca', 'Prefeitura de Palhoça LEAK', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name, is_platform_operator) VALUES
  ('${CARLA}', 'sub-carla-op', 'carla@contrataflow.com.br', true, 'Carla Antunes', true),
  ('${PEDRO}', 'sub-pedro', 'pedro@palhoca.test', true, 'Pedro LEAK', false);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000099b1', '${PALHOCA}', '${PEDRO}', 'INTERNAL', 'ACTIVE');
INSERT INTO document_types (id, tenant_id, code, name, kind)
  VALUES ('0192c000-0000-7000-8000-0000000099d1', '${PALHOCA}', 'PORTARIA', 'Portaria LEAK', 'FREE_TEXT');
`;

function body(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'sao-jose',
    name: 'Prefeitura de São José',
    type: 'MUNICIPALITY',
    stateCode: 'SC',
    ibgeCityCode: '4216602',
    primaryOrganization: {
      name: 'Prefeitura Municipal de São José',
      shortName: 'PMSJ',
      cnpj: '11.222.333/0001-81',
      type: 'DIRECT_ADMINISTRATION',
    },
    firstAdmin: { email: 'rafael.nogueira@pmsj.exemplo.gov.br', name: 'Rafael Nogueira' },
    ...overrides,
  };
}

describe('provisionamento de tenant no PostgreSQL (US-099)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const auth = (test: request.Test, subject = 'sub-carla-op') =>
    test.set('Authorization', api.bearer(subject, { amr: MFA }));

  const provision = (payload: Record<string, unknown>, key: string = randomUUID()) =>
    auth(request(api.server).post('/api/v1/platform/tenants'))
      .set('Idempotency-Key', key)
      .send(payload);

  const countsOf = async (tenantId: string) => {
    const counts: Record<string, number> = {};
    for (const table of TENANT_TABLES) {
      const [row] = await db.admin<{ count: string }>(
        `SELECT count(*) FROM ${table} WHERE tenant_id = $1`,
        [tenantId],
      );
      counts[table] = Number(row?.count);
    }
    return counts;
  };

  /** Fotografia de todas as linhas do tenant (detecta qualquer alteração, não só inserção). */
  const digestOf = async (tenantId: string) => {
    const parts: string[] = [];
    for (const table of TENANT_TABLES) {
      const rows = await db.admin(`SELECT * FROM ${table} WHERE tenant_id = $1 ORDER BY 1`, [
        tenantId,
      ]);
      parts.push(JSON.stringify(rows));
    }
    return parts.join('\n');
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
    });
    api = await createTestApi({
      config,
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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  describe('[Sucesso] Provisionar e ativar pela API de plataforma', () => {
    let tenant: ProvisionTenantResultDto;
    let palhocaBefore: string;

    beforeAll(async () => {
      palhocaBefore = await digestOf(PALHOCA);
      const response = await provision(body());
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      tenant = (response.body as { data: ProvisionTenantResultDto }).data;
    });

    it('tenant ACTIVE com checklist completo e as linhas semeadas no banco', async () => {
      expect(tenant.status).toBe('ACTIVE');
      expect(tenant.provisioning.complete).toBe(true);
      const [row] = await db.admin<{ status: string; activated_at: Date | null; version: number }>(
        'SELECT status, activated_at, version FROM tenants WHERE id = $1',
        [tenant.id],
      );
      expect(row).toMatchObject({ status: 'ACTIVE', version: 2 });
      expect(row?.activated_at).toBeInstanceOf(Date);
      const counts = await countsOf(tenant.id);
      expect(counts).toMatchObject({
        roles: 15,
        document_types: 11,
        organizations: 1,
        tenant_settings: SETTING_DEFINITIONS.length,
        tenant_memberships: 1,
        // US-042: os dois workflows de DEC-015, cada um com a v1 publicada.
        workflows: 2,
        workflow_versions: 2,
      });
      const [admin] = await db.admin<{ protected: boolean }>(
        `SELECT is_protected AS protected FROM roles WHERE tenant_id = $1 AND key = 'ADMIN_ORGAO'`,
        [tenant.id],
      );
      expect(admin?.protected).toBe(true);
    });

    it('órgão principal do tenant.json criado e apontado por tenants.primary_organization_id (US-101)', async () => {
      const [org] = await db.admin<{
        id: string;
        short_name: string;
        cnpj: string;
        is_active: boolean;
      }>('SELECT id, short_name, cnpj, is_active FROM organizations WHERE tenant_id = $1', [
        tenant.id,
      ]);
      expect(org).toMatchObject({ short_name: 'PMSJ', cnpj: '11222333000181', is_active: true });
      const [row] = await db.admin<{ primary_organization_id: string }>(
        'SELECT primary_organization_id FROM tenants WHERE id = $1',
        [tenant.id],
      );
      expect(row?.primary_organization_id).toBe(org?.id);
      const trail = await db.admin<{ actor_type: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, metadata FROM audit_logs
          WHERE tenant_id = $1 AND action = 'organization.create'`,
        [tenant.id],
      );
      expect(trail).toEqual([
        expect.objectContaining({
          actor_type: 'SYSTEM',
          metadata: expect.objectContaining({ seeded: true, principal: true }) as unknown,
        }),
      ]);
    });

    it('vínculo INTERNAL INVITED do administrador, identidade criada sem sub', async () => {
      const rows = await db.admin<{ type: string; status: string; email: string; sub: string }>(
        `SELECT m.type, m.status, u.email::text AS email, u.external_subject AS sub
           FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1`,
        [tenant.id],
      );
      expect(rows).toEqual([
        {
          type: 'INTERNAL',
          status: 'INVITED',
          email: 'rafael.nogueira@pmsj.exemplo.gov.br',
          sub: null,
        },
      ]);
    });

    it('auditorias tenant.provision e tenant.activate (PLATFORM_OPERATOR) e eventos no tenant', async () => {
      const audits = await db.admin<{ action: string; actor_type: string; actor_user_id: string }>(
        `SELECT action, actor_type, actor_user_id FROM audit_logs
          WHERE tenant_id = $1 AND action LIKE 'tenant.%' ORDER BY occurred_at`,
        [tenant.id],
      );
      expect(audits).toEqual([
        { action: 'tenant.provision', actor_type: 'PLATFORM_OPERATOR', actor_user_id: CARLA },
        { action: 'tenant.activate', actor_type: 'PLATFORM_OPERATOR', actor_user_id: CARLA },
      ]);
      // Os seeders auditam como SYSTEM (role.create dos perfis padrão).
      const [seeded] = await db.admin<{ count: string }>(
        `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'role.create' AND actor_type = 'SYSTEM'`,
        [tenant.id],
      );
      expect(Number(seeded?.count)).toBe(15);
      const events = await db.admin<{ event_type: string; aggregate_type: string }>(
        `SELECT event_type, aggregate_type FROM outbox_events WHERE tenant_id = $1 ORDER BY occurred_at`,
        [tenant.id],
      );
      expect(events.filter((event) => event.aggregate_type === 'Tenant')).toEqual([
        { event_type: 'TenantProvisioned', aggregate_type: 'Tenant' },
        { event_type: 'TenantActivated', aggregate_type: 'Tenant' },
      ]);
      // US-042: a carga dos workflows grava criação e publicação, nunca WorkflowDefaultChanged.
      expect(
        events.filter((event) => event.aggregate_type === 'Workflow').map((e) => e.event_type),
      ).toEqual([
        'WorkflowCreated',
        'WorkflowVersionPublished',
        'WorkflowCreated',
        'WorkflowVersionPublished',
      ]);
    });

    it('[Tenant incorreto] seeders não criam, alteram nem leem linhas de palhoca', async () => {
      expect(await digestOf(PALHOCA)).toBe(palhocaBefore);
    });

    it('[Tenant incorreto] a operadora não tem vínculo: rotas do tenant → 403 MEMBERSHIP_INACTIVE', async () => {
      const [membership] = await db.admin<{ count: string }>(
        'SELECT count(*) FROM tenant_memberships WHERE user_id = $1',
        [CARLA],
      );
      expect(Number(membership?.count)).toBe(0);
      const response = await auth(request(api.server).get('/api/v1/document-types')).set(
        'X-Tenant-Id',
        tenant.id,
      );
      expect(response.status).toBe(403);
      expect(problemDetailsSchema.parse(response.body).code).toBe('MEMBERSHIP_INACTIVE');
    });

    it('[Duplicidade] reexecutar o tenant já ativo → 409, auditado na plataforma', async () => {
      const response = await provision(body());
      expect(response.status).toBe(409);
      const [failure] = await db.admin<{ tenant_id: string | null; reason_code: string }>(
        `SELECT tenant_id, reason_code FROM audit_logs
          WHERE action = 'tenant.provision' AND result = 'FAILURE' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(failure).toEqual({ tenant_id: null, reason_code: 'TENANT_SLUG_TAKEN' });
    });

    it('banco: slug imutável depois da ativação; impressão do pedido fora do alcance do cf_app', async () => {
      await expect(
        db.admin(`UPDATE tenants SET slug = 'sao-jose-2' WHERE id = '${tenant.id}'`),
      ).rejects.toThrow(/slug é imutável/);
      const [row] = await db.admin<{ fingerprint: string }>(
        'SELECT provisioning_fingerprint AS fingerprint FROM tenants WHERE id = $1',
        [tenant.id],
      );
      expect(row?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const app = db.client('cf_app');
      await expect(
        app.$platformTransaction(
          (tx) => tx.$queryRaw`SELECT provisioning_fingerprint FROM tenants LIMIT 1`,
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('[Falha de banco] falha no meio e retomada', () => {
    it('etapa que falha fica PENDING; a reexecução só roda o pendente, sem duplicar', async () => {
      const seeder = api.app.get(SystemDocumentTypesSeeder, { strict: false });
      const spy = vi
        .spyOn(seeder, 'seed')
        .mockRejectedValueOnce(new DatabaseUnavailableError(new Error('conexão perdida')));
      const payload = body({
        slug: 'biguacu',
        name: 'Prefeitura de Biguaçu',
        ibgeCityCode: '4202305',
        primaryOrganization: { ...body().primaryOrganization, cnpj: '12.ABC.345/01DE-35' },
        firstAdmin: { email: 'admin@biguacu.exemplo.gov.br', name: 'Admin Biguaçu' },
      });
      const failed = await provision(payload);
      expect(failed.status).toBe(503);
      const problem = problemDetailsSchema.parse(failed.body) as unknown as {
        code: string;
        provisioning: { steps: { key: string; status: string }[] };
      };
      expect(problem.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(
        problem.provisioning.steps.filter((step) => step.status === 'PENDING').map((s) => s.key),
      ).toEqual([
        'document.systemTypes',
        // A execução para na etapa que falhou: as seguintes ficam pendentes (US-042/US-106).
        'workflow.seedWorkflows',
        'catalog.holidays',
        'identity.firstAdmin',
        'tenancy.complete',
      ]);
      const [tenant] = await db.admin<{ id: string; status: string }>(
        `SELECT id, status FROM tenants WHERE slug = 'biguacu'`,
      );
      expect(tenant?.status).toBe('PROVISIONING');
      const id = tenant?.id ?? '';
      expect(await countsOf(id)).toMatchObject({ roles: 15, document_types: 0, workflows: 0 });

      const resumed = await provision(payload);
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(201);
      expect((resumed.body as { data: { id: string } }).data.id).toBe(id);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await countsOf(id)).toMatchObject({
        roles: 15,
        document_types: 11,
        tenant_memberships: 1,
        workflows: 2,
      });
      spy.mockRestore();
    });

    it('reexecução de um provisionamento completo sem ativar não grava nenhuma linha nova', async () => {
      const payload = body({
        slug: 'tijucas',
        name: 'Prefeitura de Tijucas',
        ibgeCityCode: '4218004',
        activate: false,
        firstAdmin: { email: 'admin@tijucas.exemplo.gov.br', name: 'Admin Tijucas' },
      });
      const first = await provision(payload);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const created = (first.body as { data: PlatformTenantDto }).data;
      expect(created.status).toBe('PROVISIONING');
      const before = await countsOf(created.id);
      const [users] = await db.admin<{ count: string }>('SELECT count(*) FROM users');

      const again = await provision(payload);
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(await countsOf(created.id)).toEqual(before);
      const [usersAfter] = await db.admin<{ count: string }>('SELECT count(*) FROM users');
      expect(usersAfter?.count).toBe(users?.count);
    });
  });

  describe('[Concorrência] mesmo slug em paralelo com CNPJs diferentes', () => {
    it('exatamente um 201 e um 409 TENANT_SLUG_TAKEN', async () => {
      const responses = await Promise.all([
        provision(body({ slug: 'sao-pedro', ibgeCityCode: '4216503' })),
        provision(
          body({
            slug: 'sao-pedro',
            ibgeCityCode: '4216503',
            primaryOrganization: { ...body().primaryOrganization, cnpj: '12.ABC.345/01DE-35' },
          }),
        ),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const [count] = await db.admin<{ count: string }>(
        `SELECT count(*) FROM tenants WHERE slug = 'sao-pedro'`,
      );
      expect(count?.count).toBe('1');
    });
  });

  describe('[Sucesso] suspender e reativar (efeito no guard de tenant)', () => {
    it('usuário de palhoca recebe 403 TENANT_SUSPENDED sem o motivo e volta após a reativação', async () => {
      const read = () =>
        auth(request(api.server).get('/api/v1/document-types'), 'sub-pedro').set(
          'X-Tenant-Id',
          PALHOCA,
        );
      expect((await read()).status).toBe(200);

      const suspended = await auth(
        request(api.server).post(`/api/v1/platform/tenants/${PALHOCA}/suspend`),
      )
        .set('If-Match', '"1"')
        .send({ reason: 'Contrato com pagamento em atraso' });
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
      const [row] = await db.admin<{ status: string; suspension_reason: string }>(
        'SELECT status, suspension_reason FROM tenants WHERE id = $1',
        [PALHOCA],
      );
      expect(row).toEqual({
        status: 'SUSPENDED',
        suspension_reason: 'Contrato com pagamento em atraso',
      });
      const [event] = await db.admin<{ event_type: string }>(
        `SELECT event_type FROM outbox_events WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [PALHOCA],
      );
      expect(event?.event_type).toBe('TenantSuspended');

      const denied = await read();
      expect(denied.status).toBe(403);
      expect(problemDetailsSchema.parse(denied.body).code).toBe('TENANT_SUSPENDED');
      expect(JSON.stringify(denied.body)).not.toContain('pagamento');

      const version = (suspended.body as { data: PlatformTenantDto }).data.version;
      const reactivated = await auth(
        request(api.server).post(`/api/v1/platform/tenants/${PALHOCA}/activate`),
      )
        .set('If-Match', `"${version}"`)
        .send({});
      expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
      expect((await read()).status).toBe(200);
    });

    it('[Concorrência] If-Match desatualizado → 412 VERSION_CONFLICT', async () => {
      const response = await auth(
        request(api.server).post(`/api/v1/platform/tenants/${PALHOCA}/suspend`),
      )
        .set('If-Match', '"1"')
        .send({ reason: 'Contrato com pagamento em atraso' });
      expect(response.status).toBe(412);
    });
  });
});

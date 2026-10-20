import { randomUUID } from 'node:crypto';

import { seedHolidaysOf } from '@contrataflow/types';
import { problemDetailsSchema, SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { PlatformTenantDto, ProvisionTenantResultDto } from '@contrataflow/validation';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { ChangeTenantStatusCommand } from '../application/change-tenant-status.command.js';
import { InMemoryOrganizationRepository } from '../infrastructure/in-memory-organization.repository.js';
import { InMemoryTenantRepository } from '../infrastructure/in-memory-tenant.repository.js';

/*
 * US-099 — PLT-01..05 pelo pipeline HTTP completo (autenticação, guard de operador, MFA, If-Match,
 * idempotência, Zod, RFC 9457) com a identidade fake, os seeders reais em memória (perfis, tipos de
 * documento, primeiro administrador), a auditoria real do `AuditService` e o outbox em memória.
 * Os mesmos fluxos contra o PostgreSQL (RLS, `cf_platform`, falha injetada) estão em `test/tenancy`.
 */

const CARLA = FAKE_USERS.operadora;
const MARTA = FAKE_USERS.marta;
const MFA = ['pwd', 'otp'];
const A = FAKE_TENANTS.prefeituraA.id;

function sampleBody(overrides: Record<string, unknown> = {}) {
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

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- leitura tipada do envelope
const dataOf = <T>(response: request.Response) => (response.body as { data: T }).data;

describe('Feature: Provisionar tenant com dados padrão (US-099) — API de plataforma', () => {
  let api: TestApi;
  let tenants: InMemoryTenantRepository;

  beforeAll(async () => {
    api = await createTestApi();
    tenants = api.app.get(InMemoryTenantRepository, { strict: false });
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
  });

  const auth = (
    test: request.Test,
    user: { subject: string | null } = CARLA,
    amr: readonly string[] = MFA,
  ) => test.set('Authorization', api.bearer(user.subject ?? '', { amr }));

  const provision = (
    body: Record<string, unknown>,
    options: { key?: string; user?: { subject: string | null }; amr?: readonly string[] } = {},
  ) =>
    auth(request(api.server).post('/api/v1/platform/tenants'), options.user, options.amr)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);

  const suspend = (id: string, version: number | null, body: Record<string, unknown>) => {
    const test = auth(request(api.server).post(`/api/v1/platform/tenants/${id}/suspend`));
    return (version === null ? test : test.set('If-Match', `"${version}"`)).send(body);
  };

  const activate = (id: string, version: number) =>
    auth(request(api.server).post(`/api/v1/platform/tenants/${id}/activate`))
      .set('If-Match', `"${version}"`)
      .send({});

  describe('[Sucesso] Provisionar e ativar uma prefeitura pela API de plataforma', () => {
    let response: request.Response;
    let tenant: ProvisionTenantResultDto;

    beforeAll(async () => {
      response = await provision(sampleBody());
      tenant = dataOf<ProvisionTenantResultDto>(response);
    });

    it('responde 201 ACTIVE com todas as etapas DONE, Location e ETag', () => {
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(tenant).toMatchObject({
        slug: 'sao-jose',
        status: 'ACTIVE',
        hasSuspensionReason: false,
      });
      expect(response.headers.location).toBe(`/api/v1/platform/tenants/${tenant.id}`);
      expect(response.headers.etag).toBe(`"${tenant.version}"`);
      expect(tenant.provisioning.complete).toBe(true);
      expect(tenant.provisioning.steps.map((step) => [step.key, step.status])).toEqual([
        ['tenancy.tenantRecord', 'DONE'],
        ['tenancy.primaryOrganization', 'DONE'],
        ['tenancy.settings', 'DONE'],
        ['catalog.items', 'DONE'],
        ['access.defaultRoles', 'DONE'],
        ['document.systemTypes', 'DONE'],
        ['document.templateLibrary', 'DONE'],
        ['workflow.seedWorkflows', 'DONE'],
        ['catalog.holidays', 'DONE'],
        ['identity.firstAdmin', 'DONE'],
        ['tenancy.complete', 'DONE'],
      ]);
    });

    it('semeia 84 itens de catálogo, 15 perfis padrão, os feriados dos 2 anos, 11 tipos de documento, os 2 workflows e o vínculo do administrador', () => {
      const details = Object.fromEntries(
        tenant.provisioning.steps.map((step) => [step.key, step.details]),
      );
      expect(details['tenancy.settings']).toEqual({ settings: SETTING_DEFINITIONS.length });
      expect(details['catalog.items']).toEqual({ items: 84 });
      expect(details['access.defaultRoles']).toEqual({ roles: 15 });
      // Ano corrente e seguinte (US-106): o relógio do teste é o real.
      const year = new Date().getFullYear();
      expect(details['catalog.holidays']).toEqual({
        holidays: seedHolidaysOf(year).length + seedHolidaysOf(year + 1).length,
      });
      expect(details['document.systemTypes']).toEqual({ documentTypes: 11 });
      // US-042: os dois workflows de DEC-015 publicados.
      expect(details['workflow.seedWorkflows']).toEqual({ workflows: 2 });
      expect(details['identity.firstAdmin']).toEqual({ memberships: 1 });
    });

    // O vínculo em si (e a ausência de vínculo da operadora) está em identity/first-admin.seeder.spec.ts
    // e, no PostgreSQL, em test/tenant-leak/tenant-provisioning.spec.ts.
    it('cria o vínculo INTERNAL INVITED do administrador e mascara o e-mail', () => {
      expect(tenant.firstAdmin).toEqual({
        email: 'r***@pmsj.exemplo.gov.br',
        membershipStatus: 'INVITED',
        // A fachada de convite (US-091) enfileira o e-mail na ativação.
        invitationDispatched: true,
      });
    });

    it('audita tenant.provision e tenant.activate como PLATFORM_OPERATOR no tenant novo', () => {
      const audits = api
        .auditRecords()
        .filter((record) => record.action.startsWith('tenant.') && record.tenantId === tenant.id);
      expect(audits.map((record) => [record.action, record.actorType, record.result])).toEqual([
        ['tenant.provision', 'PLATFORM_OPERATOR', 'SUCCESS'],
        ['tenant.activate', 'PLATFORM_OPERATOR', 'SUCCESS'],
      ]);
      expect(audits[0]?.actorUserId).toBe(CARLA.id);
      expect(audits[0]?.metadata).toMatchObject({
        slug: 'sao-jose',
        channel: 'API',
        seedVersions: {
          'access.defaultRoles': '2026.10.1',
          'document.systemTypes': '2026.10.1',
          'identity.firstAdmin': '2026.10.1',
        },
        firstAdmin: 'r***@pmsj.exemplo.gov.br',
      });
      expect(audits[1]?.metadata).toMatchObject({ fromStatus: 'PROVISIONING', toStatus: 'ACTIVE' });
    });

    it('gera TenantProvisioned e TenantActivated no tenant novo', () => {
      const events = api.outboxRows().filter((row) => row.aggregateId === tenant.id);
      expect(events.map((row) => [row.eventType, row.tenantId])).toEqual([
        ['TenantProvisioned', tenant.id],
        ['TenantActivated', tenant.id],
      ]);
      expect(events[0]?.payload).toEqual({
        tenantId: tenant.id,
        slug: 'sao-jose',
        primaryOrganizationId: expect.any(String) as unknown,
      });
      // O órgão principal do `tenant.json` foi criado e é o `primaryOrganizationId` do tenant.
      const organizations = api.app
        .get(InMemoryOrganizationRepository, { strict: false })
        .snapshot()
        .filter((organization) => organization.tenantId === tenant.id);
      expect(organizations).toHaveLength(1);
      expect(organizations[0]).toMatchObject({ shortName: 'PMSJ', isActive: true });
      expect(events[0]?.payload.primaryOrganizationId).toBe(organizations[0]?.id);
    });

    it('[Tenant incorreto] a operadora não tem vínculo com o tenant que provisionou', async () => {
      const denied = await auth(request(api.server).get('/api/v1/document-types')).set(
        'X-Tenant-Id',
        tenant.id,
      );
      expectProblem(denied, 403, 'MEMBERSHIP_INACTIVE');
    });

    it('PLT-02 lista e PLT-03 consulta com o checklist calculado e ETag', async () => {
      const listed = await auth(request(api.server).get('/api/v1/platform/tenants?q=jos'));
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({
        data: [{ id: tenant.id, slug: 'sao-jose', status: 'ACTIVE' }],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      });
      const filtered = await auth(
        request(api.server).get('/api/v1/platform/tenants?status=SUSPENDED&stateCode=SC'),
      );
      expect(dataOf<{ slug: string }[]>(filtered).map((t) => t.slug)).toEqual([
        'prefeitura-suspensa',
      ]);

      const detail = await auth(request(api.server).get(`/api/v1/platform/tenants/${tenant.id}`));
      expect(detail.status).toBe(200);
      expect(detail.headers.etag).toBe(`"${tenant.version}"`);
      expect(dataOf<ProvisionTenantResultDto>(detail).provisioning.complete).toBe(true);

      const missing = await auth(
        request(api.server).get(`/api/v1/platform/tenants/${randomUUID()}`),
      );
      expectProblem(missing, 404, 'TENANT_NOT_FOUND');
    });
  });

  describe('[Duplicidade] Reenvio com a mesma chave de idempotência', () => {
    it('responde 201 com o mesmo tenant e Idempotent-Replayed, sem novo conjunto semeado', async () => {
      const key = randomUUID();
      const body = sampleBody({
        slug: 'palhoca',
        name: 'Prefeitura de Palhoça',
        ibgeCityCode: '4211900',
        firstAdmin: { email: 'admin@palhoca.exemplo.gov.br', name: 'Ana Admin' },
      });
      const first = await provision(body, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const auditsBefore = api.auditRecords().length;

      const replay = await provision(body, { key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(dataOf<{ id: string }>(replay).id).toBe(dataOf<{ id: string }>(first).id);
      expect(api.auditRecords()).toHaveLength(auditsBefore);

      const reused = await provision({ ...body, name: 'Outro nome' }, { key });
      expectProblem(reused, 422, 'IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('[Validação] Dados de cadastro inválidos', () => {
    it('responde 422 com os campos e não cria tenant', async () => {
      const before = (await tenants.list({} as never, { page: 1, pageSize: 100 })).totalItems;
      const response = await provision(
        sampleBody({
          slug: 'São José',
          timezone: 'Europe/Lisbon',
          primaryOrganization: { ...sampleBody().primaryOrganization, cnpj: '11.222.333/0001-82' },
        }),
      );
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors.map((error) => [error.field, error.code])).toEqual(
        expect.arrayContaining([
          ['slug', 'INVALID_FORMAT'],
          ['primaryOrganization.cnpj', 'INVALID_CNPJ'],
          ['timezone', 'INVALID_ENUM'],
        ]),
      );
      expect((await tenants.list({} as never, { page: 1, pageSize: 100 })).totalItems).toBe(before);
    });
  });

  describe('[Permissão]', () => {
    it('administrador de tenant (não operador) recebe 403 PERMISSION_DENIED, auditado na plataforma', async () => {
      const response = await provision(sampleBody({ slug: 'rafael-tenta' }), { user: MARTA });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      const denied = api
        .auditRecords()
        .filter((record) => record.action === 'access.denied' && record.actorUserId === MARTA.id);
      expect(denied.at(-1)).toMatchObject({ tenantId: null, reasonCode: 'PLATFORM_TENANT_MANAGE' });
    });

    it('operadora sem segundo fator recebe 403 MFA_REQUIRED', async () => {
      const response = await provision(sampleBody({ slug: 'sem-mfa' }), { amr: ['pwd'] });
      expectProblem(response, 403, 'MFA_REQUIRED');
    });

    it('rotas de plataforma não aceitam usuário anônimo', async () => {
      const response = await request(api.server).get('/api/v1/platform/tenants');
      expectProblem(response, 401, 'UNAUTHENTICATED');
    });
  });

  describe('[Duplicidade] Slug de tenant desativado não é reutilizado', () => {
    it('responde 409 TENANT_SLUG_TAKEN e audita a falha na auditoria de plataforma', async () => {
      const created = await provision(
        sampleBody({
          slug: 'biguacu',
          name: 'Prefeitura de Biguaçu',
          ibgeCityCode: '4202305',
          activate: false,
        }),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(dataOf<{ status: string }>(created).status).toBe('PROVISIONING');
      await api.app.get(ChangeTenantStatusCommand, { strict: false }).execute({
        tenant: { slug: 'biguacu' },
        action: 'DEACTIVATE',
        expectedVersion: null,
        operator: { id: CARLA.id, name: CARLA.name },
        channel: 'CLI',
      });

      const again = await provision(
        sampleBody({ slug: 'biguacu', name: 'Outra', ibgeCityCode: '4202305' }),
      );
      const problem = expectProblem(again, 409, 'TENANT_SLUG_TAKEN');
      expect(problem.detail).toBe('O identificador "biguacu" já está em uso.');
      const failure = api
        .auditRecords()
        .filter((record) => record.action === 'tenant.provision' && record.result === 'FAILURE');
      expect(failure.at(-1)).toMatchObject({
        tenantId: null,
        actorType: 'PLATFORM_OPERATOR',
        reasonCode: 'TENANT_SLUG_TAKEN',
      });
    });
  });

  describe('[Concorrência] Dois provisionamentos simultâneos com o mesmo slug', () => {
    it('exatamente um recebe 201 e o outro 409 TENANT_SLUG_TAKEN', async () => {
      const responses = await Promise.all([
        provision(sampleBody({ slug: 'sao-pedro', ibgeCityCode: '4216503' })),
        provision(
          sampleBody({
            slug: 'sao-pedro',
            ibgeCityCode: '4216503',
            primaryOrganization: {
              ...sampleBody().primaryOrganization,
              cnpj: '12.ABC.345/01DE-35',
            },
          }),
        ),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    });
  });

  describe('[Sucesso] Suspender e reativar', () => {
    let id: string;
    let version: number;

    beforeAll(async () => {
      const created = await provision(
        sampleBody({ slug: 'tijucas', name: 'Prefeitura de Tijucas', ibgeCityCode: '4218004' }),
      );
      ({ id, version } = dataOf<PlatformTenantDto>(created));
    });

    it('[Validação] suspensão sem motivo → 422 REQUIRED em reason', async () => {
      const problem = expectProblem(await suspend(id, version, {}), 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ field: 'reason', code: 'REQUIRED' });
    });

    it('If-Match ausente → 428; desatualizado → 412', async () => {
      expectProblem(
        await suspend(id, null, { reason: 'Contrato com pagamento em atraso' }),
        428,
        'PRECONDITION_REQUIRED',
      );
      expectProblem(
        await suspend(id, version - 1, { reason: 'Contrato com pagamento em atraso' }),
        412,
        'VERSION_CONFLICT',
      );
    });

    it('suspende, gera TenantSuspended e recusa usuários com TENANT_SUSPENDED; reativa preservando activatedAt', async () => {
      const suspended = await suspend(id, version, { reason: 'Contrato com pagamento em atraso' });
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
      const body = dataOf<PlatformTenantDto>(suspended);
      expect(body).toMatchObject({ status: 'SUSPENDED', hasSuspensionReason: true });
      expect(JSON.stringify(suspended.body)).not.toContain('pagamento em atraso');
      expect(suspended.headers.etag).toBe(`"${body.version}"`);
      expect(
        api
          .outboxRows()
          .filter((row) => row.aggregateId === id)
          .map((row) => row.eventType),
      ).toContain('TenantSuspended');
      const audit = api
        .auditRecords()
        .find((record) => record.action === 'tenant.suspend' && record.tenantId === id);
      expect(audit).toMatchObject({ actorType: 'PLATFORM_OPERATOR' });
      expect(await tenants.findStatus(id)).toBe('SUSPENDED');

      const activatedBefore = dataOf<PlatformTenantDto>(
        await auth(request(api.server).get(`/api/v1/platform/tenants/${id}`)),
      ).activatedAt;
      const reactivated = await activate(id, body.version);
      expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
      expect(dataOf<PlatformTenantDto>(reactivated)).toMatchObject({
        status: 'ACTIVE',
        activatedAt: activatedBefore,
        suspendedAt: null,
        hasSuspensionReason: false,
      });
    });

    it('transição inválida → 409 INVALID_STATE com a mensagem da story', async () => {
      const current = dataOf<PlatformTenantDto>(
        await auth(request(api.server).get(`/api/v1/platform/tenants/${id}`)),
      );
      const problem = expectProblem(await activate(id, current.version), 409, 'INVALID_STATE');
      expect(problem.detail).toBe('Não é possível ativar: a instituição está ativa.');
    });
  });

  describe('[Tenant incorreto] usuário de tenant suspenso', () => {
    it('recebe 403 TENANT_SUSPENDED sem o motivo', async () => {
      const davi = FAKE_USERS.davi;
      const response = await auth(request(api.server).get('/api/v1/document-types'), davi).set(
        'X-Tenant-Id',
        FAKE_TENANTS.prefeituraSuspensa.id,
      );
      const problem = expectProblem(response, 403, 'TENANT_SUSPENDED');
      expect(JSON.stringify(problem)).not.toContain('Suspensa no diretório fake');
    });

    it('rota de tenant continua normal para quem tem vínculo ativo', async () => {
      const response = await auth(request(api.server).get('/api/v1/document-types'), MARTA).set(
        'X-Tenant-Id',
        A,
      );
      expect(response.status).toBe(200);
    });
  });
});

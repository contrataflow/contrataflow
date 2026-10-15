import { problemDetailsSchema } from '@contrataflow/validation';
import type { OrganizationDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  ORGANIZATION_CLOCK,
  ORGANIZATION_LOGO_PORT,
  ORGANIZATION_TRANSACTIONS,
} from '../application/organization-ports.js';
import type { OrganizationTransactions } from '../application/organization-ports.js';
import { createOrganization } from '../domain/organization.js';
import {
  InMemoryOrganizationRepository,
  StubLogoPort,
} from '../infrastructure/in-memory-organization.repository.js';

/*
 * US-101 — ORG-01..04 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do `AuditService` e o
 * outbox em memória. Os mesmos casos contra o PostgreSQL (RLS, índices únicos, trigger) estão em
 * `test/tenancy` e `test/tenant-leak`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const LUCIA = FAKE_USERS.lucia;
const HEITOR = FAKE_USERS.heitor;
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');

/** CNPJs válidos (DV conferido): numéricos e um alfanumérico (Receita Federal, 2026). */
const CNPJ = {
  principal: '11.222.333/0001-81',
  fms: '11.444.777/0001-61',
  autarquia: '45.997.418/0001-53',
  outra: '33.000.167/0001-01',
  ft: '30.000.000/0001-52',
  sec: '40.000.000/0001-06',
  semMfa: '50.000.000/0001-60',
  negado: '60.746.948/0001-12',
  duplicado: '20.000.000/0001-07',
  alfanumerico: '12.ABC.345/01DE-35',
  deB: '60.746.948/0001-12',
} as const;

const PRINCIPAL = newId();
const SEC_B = newId();
const LOGO_OK = newId();
const LOGO_INACTIVE = newId();

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = unknown>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Gerenciar órgãos/entidades (US-101)', () => {
  let api: TestApi;
  let repository: InMemoryOrganizationRepository;

  const seed = (tenantId: string, id: string, shortName: string, cnpj: string, active = true) => {
    repository.seed({
      ...createOrganization(
        {
          name: `Órgão ${shortName}`,
          shortName,
          cnpj: cnpj.replace(/\D/g, ''),
          type: 'DIRECT_ADMINISTRATION',
        },
        { id, tenantId, now: NOW, userId: null },
      ),
      isActive: active,
    });
  };

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: ORGANIZATION_CLOCK, value: () => NOW },
        {
          token: ORGANIZATION_LOGO_PORT,
          value: new StubLogoPort({ [LOGO_OK]: 'OK', [LOGO_INACTIVE]: 'INACTIVE' }),
        },
      ],
    });
    repository = api.app.get(InMemoryOrganizationRepository, { strict: false });
    // Background: o tenant A com o órgão principal "PMSJ"; o tenant B com um único órgão ativo.
    seed(A, PRINCIPAL, 'PMSJ', CNPJ.principal);
    repository.setPrimary(A, PRINCIPAL);
    seed(B, SEC_B, 'SEC', CNPJ.deB);
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const withAuth = (
    test: request.Test,
    user: { subject: string },
    options: { amr?: readonly string[]; tenant?: string } = {},
  ) =>
    test
      .set('Authorization', api.bearer(user.subject, { amr: options.amr ?? MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);

  const list = (query = '', user: { subject: string } = MARTA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/organizations?${query}`), user, { tenant });

  const get = (id: string, user: { subject: string } = MARTA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/organizations/${id}`), user, { tenant });

  const create = (
    body: Record<string, unknown>,
    options: { user?: { subject: string }; amr?: readonly string[]; tenant?: string } = {},
  ) =>
    withAuth(request(api.server).post('/api/v1/organizations'), options.user ?? MARTA, {
      amr: options.amr ?? MFA,
      tenant: options.tenant ?? A,
    }).send(body);

  const patch = (
    id: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    options: { user?: { subject: string }; amr?: readonly string[]; tenant?: string } = {},
  ) => {
    const test = withAuth(
      request(api.server).patch(`/api/v1/organizations/${id}`),
      options.user ?? MARTA,
      { amr: options.amr ?? MFA, tenant: options.tenant ?? A },
    );
    return (ifMatch === null ? test : test.set('If-Match', ifMatch)).send(body);
  };

  const fms = (overrides: Record<string, unknown> = {}) => ({
    name: 'Fundo Municipal de Saúde',
    shortName: 'FMS',
    cnpj: CNPJ.fms,
    type: 'FUND',
    ...overrides,
  });

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const snapshotOf = (id: string) => repository.snapshot().find((org) => org.id === id);

  describe('[Sucesso]', () => {
    it('criar órgão: 201, ETag "1", ativo, sigla em maiúsculas, CNPJ sem máscara, auditoria e evento', async () => {
      silence();
      const audits = auditOf('organization.create').length;
      const events = api.outboxRows().length;

      const response = await create(fms({ shortName: 'fms', email: 'FMS@Saude.Gov.BR' }));

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const data = dataOf<OrganizationDto>(response);
      expect(response.headers.location).toBe(`/api/v1/organizations/${data.id}`);
      expect(data).toMatchObject({
        name: 'Fundo Municipal de Saúde',
        shortName: 'FMS',
        cnpj: '11444777000161',
        type: 'FUND',
        isActive: true,
        isPrimary: false,
        email: 'fms@saude.gov.br',
        logoAttachmentId: null,
        metadata: {},
        version: 1,
      });

      const records = auditOf('organization.create');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actorUserId: MARTA.id,
        entityType: 'Organization',
        entityId: data.id,
        metadata: { shortName: 'FMS' },
      });
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        tenantId: A,
        eventType: 'OrganizationCreated',
        routingKey: 'organization.created',
        aggregateType: 'Organization',
        aggregateId: data.id,
        payload: { organizationId: data.id },
      });
    });

    it('CNPJ alfanumérico (Receita Federal, 2026) e endereço completo são aceitos', async () => {
      silence();
      const response = await create(
        fms({
          name: 'Autarquia Municipal de Trânsito',
          shortName: 'amt-sj',
          cnpj: CNPJ.alfanumerico,
          type: 'AUTARCHY',
          phone: '(48) 3381-0000',
          website: 'https://amt.sj.sc.gov.br',
          addressStreet: 'Rua Central',
          addressNumber: '100',
          addressComplement: 'Sala 2',
          addressDistrict: 'Centro',
          addressCity: 'São José',
          addressState: 'sc',
          addressZipCode: '88.100-000',
          ibgeCityCode: '4216602',
        }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf(response)).toMatchObject({
        shortName: 'AMT-SJ',
        cnpj: '12ABC34501DE35',
        addressState: 'SC',
        addressZipCode: '88100000',
        website: 'https://amt.sj.sc.gov.br',
      });
    });

    it('listar (ORG-01): por nome, órgão principal marcado, filtros isActive/q e paginação', async () => {
      const all = await list();
      expect(all.status).toBe(200);
      const body = all.body as { data: OrganizationDto[]; meta: Record<string, number> };
      expect(body.data.map((org) => org.shortName)).toEqual(['AMT-SJ', 'FMS', 'PMSJ']);
      expect(body.data.find((org) => org.shortName === 'PMSJ')?.isPrimary).toBe(true);
      expect(body.meta).toMatchObject({ page: 1, pageSize: 20, totalItems: 3, totalPages: 1 });

      const bySigla = await list('q=fms');
      expect(dataOf<OrganizationDto[]>(bySigla).map((org) => org.shortName)).toEqual(['FMS']);
      const byName = await list(`q=${encodeURIComponent('saude')}`);
      expect(dataOf<OrganizationDto[]>(byName).map((org) => org.shortName)).toEqual(['FMS']);
      const byCnpj = await list('q=11.222.333');
      expect(dataOf<OrganizationDto[]>(byCnpj).map((org) => org.shortName)).toEqual(['PMSJ']);
      expect(dataOf<OrganizationDto[]>(await list('isActive=false'))).toEqual([]);

      const paged = await list('page=2&pageSize=2');
      expect((paged.body as { data: unknown[] }).data).toHaveLength(1);
      expectProblem(await list('q=a'), 422, 'VALIDATION_ERROR');
    });

    it('consultar (ORG-03): ETag com a versão', async () => {
      const response = await get(PRINCIPAL);
      expect(response.status).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(dataOf(response)).toMatchObject({ id: PRINCIPAL, shortName: 'PMSJ', isPrimary: true });
    });

    it('editar (ORG-04): 200, nova versão, auditoria com valor anterior/novo e evento com changedFields', async () => {
      silence();
      const target = dataOf<OrganizationDto>(
        await create(fms({ name: 'Instituto Municipal', shortName: 'IMP', cnpj: CNPJ.autarquia })),
      );
      const events = api.outboxRows().length;

      const response = await patch(
        target.id,
        { name: 'Instituto Municipal de Previdência', phone: '4833810000', type: 'AUTARCHY' },
        '"1"',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(dataOf(response)).toMatchObject({
        name: 'Instituto Municipal de Previdência',
        phone: '4833810000',
        type: 'AUTARCHY',
        version: 2,
      });
      const update = auditOf('organization.update').at(-1);
      expect(update).toMatchObject({
        category: 'CONFIGURATION',
        entityType: 'Organization',
        entityId: target.id,
        actorUserId: MARTA.id,
      });
      expect(update?.changes).toEqual([
        { path: 'name', old: 'Instituto Municipal', new: 'Instituto Municipal de Previdência' },
        { path: 'type', old: 'FUND', new: 'AUTARCHY' },
        { path: 'phone', old: null, new: '4833810000' },
      ]);
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'OrganizationUpdated',
        routingKey: 'organization.updated',
        payload: { organizationId: target.id, changedFields: ['name', 'type', 'phone'] },
      });

      // Limpar um campo opcional: `null`.
      const cleared = await patch(target.id, { phone: null }, '"2"');
      expect(cleared.status).toBe(200);
      expect(dataOf(cleared)).toMatchObject({ phone: null, version: 3 });
    });

    it('nada alterado: 200 sem nova versão, auditoria nem evento', async () => {
      silence();
      const audits = api.auditRecords().length;
      const events = api.outboxRows().length;
      const response = await patch(PRINCIPAL, { name: 'Órgão PMSJ', shortName: 'pmsj' }, '"1"');
      expect(response.status).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(api.auditRecords()).toHaveLength(audits);
      expect(api.outboxRows()).toHaveLength(events);
    });

    it('RN-TEN-43: metadata enviado pelo cliente é ignorado', async () => {
      silence();
      const created = await create(
        fms({
          name: 'Fundo de Teste',
          shortName: 'FT',
          cnpj: CNPJ.ft,
          metadata: { pncpUnitCode: 'X' },
          isActive: false,
        }),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const data = dataOf<OrganizationDto>(created);
      expect(data.metadata).toEqual({});
      expect(data.isActive).toBe(true);
      const updated = await patch(data.id, { metadata: { a: 1 }, name: 'Fundo de Teste 2' }, '"1"');
      expect(dataOf<OrganizationDto>(updated).metadata).toEqual({});
    });

    it('inativar e reativar órgão que não é o principal nem o único ativo (FA-03)', async () => {
      silence();
      const target = repository.snapshot().find((org) => org.shortName === 'FT');
      const off = await patch(target?.id ?? '', { isActive: false }, '"2"');
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(dataOf(off)).toMatchObject({ isActive: false });
      const inactive = await list('isActive=false');
      expect(dataOf<OrganizationDto[]>(inactive).map((org) => org.shortName)).toEqual(['FT']);
      const on = await patch(target?.id ?? '', { isActive: true }, '"3"');
      expect(dataOf(on)).toMatchObject({ isActive: true });
    });

    it('logs sem dados sensíveis: CNPJ só com os 4 últimos caracteres', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const response = await create(
        fms({
          name: 'Fundo de Logs',
          shortName: 'LOGS',
          cnpj: CNPJ.deB,
          email: 'logs@exemplo.gov.br',
          phone: '4833810001',
        }),
      );
      // Mesmo CNPJ de outro tenant é permitido (unicidade por tenant).
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = log.mock.calls.find(([entry]) => {
        return (entry as { event?: string }).event === 'organization.created';
      });
      expect(created?.[0]).toMatchObject({
        cnpj: '**********0112',
        organizationId: expect.any(String) as unknown,
      });
      const printed = JSON.stringify(log.mock.calls);
      expect(printed).not.toContain('60746948000112');
      expect(printed).not.toContain('logs@exemplo.gov.br');
      expect(printed).not.toContain('4833810001');
    });
  });

  describe('[Validação]', () => {
    it('CNPJ com dígito verificador inválido: 422 VALIDATION_ERROR / INVALID_CNPJ em cnpj', async () => {
      const response = await create(fms({ cnpj: '11.111.111/1111-00' }));
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'cnpj', code: 'INVALID_CNPJ' }),
      ]);
    });

    it('obrigatórios ausentes: REQUIRED por campo; sigla e website fora do padrão: INVALID_FORMAT', async () => {
      const missing = expectProblem(await create({}), 422, 'VALIDATION_ERROR');
      expect(missing.errors.map((error) => [error.field, error.code])).toEqual(
        expect.arrayContaining([
          ['name', 'REQUIRED'],
          ['shortName', 'REQUIRED'],
          ['cnpj', 'REQUIRED'],
          ['type', 'INVALID_ENUM'],
        ]),
      );

      const bad = expectProblem(
        await create(
          fms({
            shortName: 'sigla com espaço',
            website: 'http://inseguro.gov.br',
            addressState: 'SCX',
            addressZipCode: '123',
            ibgeCityCode: '12',
            email: 'nao-e-email',
          }),
        ),
        422,
        'VALIDATION_ERROR',
      );
      const byField = Object.fromEntries(bad.errors.map((e) => [e.field, e.code]));
      expect(byField).toMatchObject({
        shortName: 'INVALID_FORMAT',
        website: 'INVALID_FORMAT',
        addressState: 'INVALID_FORMAT',
        addressZipCode: 'INVALID_FORMAT',
        ibgeCityCode: 'INVALID_FORMAT',
      });
      expect(byField.email).toBeDefined();
      expect(repository.snapshot().some((org) => org.shortName === 'FMS-X')).toBe(false);
    });

    it('PATCH: mesmas validações; id que não é UUID é rejeitado', async () => {
      expectProblem(await patch(PRINCIPAL, { cnpj: '123' }, '"1"'), 422, 'VALIDATION_ERROR');
      expectProblem(
        await patch('nao-uuid', { name: 'Outro nome' }, '"1"'),
        422,
        'VALIDATION_ERROR',
      );
    });
  });

  describe('[Permissão]', () => {
    it('usuário sem ORGANIZATION_MANAGE: 403 PERMISSION_DENIED e access.denied com o motivo', async () => {
      silence();
      const denials = auditOf('access.denied').length;
      const total = repository.snapshot().length;

      const response = await create(fms({ shortName: 'NEGADO', cnpj: CNPJ.negado }), {
        user: LUCIA,
      });

      expectProblem(response, 403, 'PERMISSION_DENIED');
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: LUCIA.id,
        reasonCode: 'ORGANIZATION_MANAGE',
        result: 'DENIED',
      });
      expect(repository.snapshot()).toHaveLength(total);
      expectProblem(
        await patch(PRINCIPAL, { name: 'Sem permissão' }, '"1"', { user: LUCIA }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('leitura (ORG-01/03) é capacidade implícita de qualquer vínculo ativo', async () => {
      expect((await list('', LUCIA)).status).toBe(200);
      expect((await get(PRINCIPAL, LUCIA)).status).toBe(200);
    });

    it('administradora sem MFA na sessão (POL-14): 403 MFA_REQUIRED e nada persistido', async () => {
      silence();
      const events = api.outboxRows().length;
      const total = repository.snapshot().length;

      expectProblem(
        await create(fms({ shortName: 'SEM-MFA', cnpj: CNPJ.semMfa }), { amr: ['pwd'] }),
        403,
        'MFA_REQUIRED',
      );
      expectProblem(
        await patch(PRINCIPAL, { name: 'Sem MFA' }, '"1"', { amr: ['pwd'] }),
        403,
        'MFA_REQUIRED',
      );

      expect(repository.snapshot()).toHaveLength(total);
      expect(snapshotOf(PRINCIPAL)?.version).toBe(1);
      expect(api.outboxRows()).toHaveLength(events);
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'MFA_REQUIRED' });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('sigla já usada em outro tenant não bloqueia, e nada do outro tenant é lido ou alterado', async () => {
      silence();
      const before = JSON.stringify(snapshotOf(SEC_B));
      const response = await create(
        fms({ name: 'Secretaria de A', shortName: 'SEC', cnpj: CNPJ.sec }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf(response)).toMatchObject({ shortName: 'SEC' });
      expect(JSON.stringify(snapshotOf(SEC_B))).toBe(before);
    });

    it('órgão de outro tenant: 404 NOT_FOUND no GET e no PATCH (indistinguível de inexistente)', async () => {
      expectProblem(await get(SEC_B), 404, 'NOT_FOUND');
      expectProblem(await get(newId()), 404, 'NOT_FOUND');
      expectProblem(await patch(SEC_B, { name: 'Órgão da B' }, '"1"'), 404, 'NOT_FOUND');
      expect(snapshotOf(SEC_B)).toMatchObject({ name: 'Órgão SEC', version: 1 });
    });

    it('a lista traz só os órgãos do tenant da requisição', async () => {
      const inA = dataOf<OrganizationDto[]>(await list());
      expect(inA.some((org) => org.id === SEC_B)).toBe(false);
      const inB = dataOf<OrganizationDto[]>(await list('', HEITOR, B));
      expect(inB.map((org) => org.id)).toContain(SEC_B);
      expect(inB.every((org) => org.id !== PRINCIPAL)).toBe(true);
    });

    it('logoAttachmentId inexistente ou de outro tenant: 422 REFERENCE_NOT_FOUND', async () => {
      silence();
      const problem = expectProblem(
        await patch(PRINCIPAL, { logoAttachmentId: newId() }, '"1"'),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'logoAttachmentId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(snapshotOf(PRINCIPAL)?.logoAttachmentId).toBeNull();
    });
  });

  describe('[Logotipo — RN-TEN-42]', () => {
    it('anexo disponível do tenant é aceito; indisponível → REFERENCE_INACTIVE; null limpa', async () => {
      silence();
      const current = snapshotOf(PRINCIPAL)?.version ?? 1;
      const inactive = expectProblem(
        await patch(PRINCIPAL, { logoAttachmentId: LOGO_INACTIVE }, `"${current}"`),
        422,
        'VALIDATION_ERROR',
      );
      expect(inactive.errors[0]).toMatchObject({
        field: 'logoAttachmentId',
        code: 'REFERENCE_INACTIVE',
      });

      const ok = await patch(PRINCIPAL, { logoAttachmentId: LOGO_OK }, `"${current}"`);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(dataOf(ok)).toMatchObject({ logoAttachmentId: LOGO_OK, version: current + 1 });

      const cleared = await patch(PRINCIPAL, { logoAttachmentId: null }, `"${current + 1}"`);
      expect(dataOf(cleared)).toMatchObject({ logoAttachmentId: null });
    });
  });

  describe('[Duplicidade]', () => {
    it('sigla já usada no mesmo tenant: 422 VALIDATION_ERROR / INVALID_FORMAT em shortName', async () => {
      silence();
      const total = repository.snapshot().length;
      const problem = expectProblem(
        await create(fms({ shortName: 'pmsj', cnpj: CNPJ.duplicado })),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'shortName', code: 'INVALID_FORMAT' }),
      ]);
      expect(repository.snapshot()).toHaveLength(total);
    });

    it('CNPJ já usado no mesmo tenant: 422 INVALID_CNPJ em cnpj ("Já existe um órgão com este CNPJ.")', async () => {
      silence();
      const problem = expectProblem(
        await create(fms({ shortName: 'OUTRA', cnpj: '11.222.333/0001-81' })),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'cnpj',
          code: 'INVALID_CNPJ',
          message: 'Já existe um órgão com este CNPJ.',
        }),
      ]);
    });

    it('PATCH para sigla ou CNPJ de outro órgão do tenant é recusado; o próprio valor não conflita', async () => {
      silence();
      const fmsOrg = repository
        .snapshot()
        .find((org) => org.shortName === 'FMS' && org.tenantId === A);
      const version = `"${fmsOrg?.version ?? 1}"`;
      expectProblem(
        await patch(fmsOrg?.id ?? '', { shortName: 'PMSJ' }, version),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await patch(fmsOrg?.id ?? '', { cnpj: CNPJ.principal }, version),
        422,
        'VALIDATION_ERROR',
      );
      const same = await patch(fmsOrg?.id ?? '', { shortName: 'FMS', cnpj: CNPJ.fms }, version);
      expect(same.status).toBe(200);
    });
  });

  describe('[Regra RN-TEN-41 — órgão principal / único ativo]', () => {
    it('inativar o órgão principal: 409 PRIMARY_ORGANIZATION_REQUIRED e isActive mantido', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const version = snapshotOf(PRINCIPAL)?.version ?? 1;
      const audits = auditOf('organization.update').length;

      const problem = expectProblem(
        await patch(PRINCIPAL, { isActive: false }, `"${version}"`),
        409,
        'PRIMARY_ORGANIZATION_REQUIRED',
      );
      expect(problem.detail).toContain('principal');
      expect(snapshotOf(PRINCIPAL)).toMatchObject({ isActive: true, version });
      expect(auditOf('organization.update')).toHaveLength(audits);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'organization.deactivate_blocked', reason: 'PRIMARY' }),
        'organization.deactivate_blocked',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('edições simultâneas: versão desatualizada → 412 VERSION_CONFLICT com currentVersion; sem If-Match → 428', async () => {
      silence();
      const target = repository.snapshot().find((org) => org.shortName === 'AMT-SJ');
      const version = target?.version ?? 1;

      const otavio = await patch(target?.id ?? '', { name: 'AMT (Otávio)' }, `"${version}"`, {
        user: OTAVIO,
      });
      expect(otavio.status).toBe(200);
      expect(otavio.headers.etag).toBe(`"${version + 1}"`);

      const marta = await patch(target?.id ?? '', { phone: '4833819999' }, `"${version}"`);
      const problem = expectProblem(marta, 412, 'VERSION_CONFLICT');
      expect(problem).toMatchObject({ currentVersion: version + 1 });
      expectProblem(
        await patch(target?.id ?? '', { name: 'Sem If-Match' }, null),
        428,
        'PRECONDITION_REQUIRED',
      );
      expect(snapshotOf(target?.id ?? '')?.phone).toBe('(48) 3381-0000');
    });

    it('duas edições com o mesmo If-Match disparadas juntas: uma 200 e outra 412', async () => {
      silence();
      const target = repository.snapshot().find((org) => org.shortName === 'AMT-SJ');
      const version = target?.version ?? 1;
      const [one, two] = await Promise.all([
        patch(target?.id ?? '', { addressCity: 'Florianópolis' }, `"${version}"`),
        patch(target?.id ?? '', { addressCity: 'Palhoça' }, `"${version}"`, { user: OTAVIO }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao salvar: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      silence();
      const failing: OrganizationTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [
          { token: ORGANIZATION_TRANSACTIONS, value: failing },
          { token: ORGANIZATION_CLOCK, value: () => NOW },
        ],
      });
      try {
        const response = await request(down.server)
          .post('/api/v1/organizations')
          .set('Authorization', down.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send(fms({ shortName: 'SEM-BANCO', cnpj: CNPJ.ft }));
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('5');
        expect(down.auditRecords().filter((r) => r.action === 'organization.create')).toHaveLength(
          0,
        );
        expect(down.outboxRows()).toHaveLength(0);
      } finally {
        await down.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('relay do outbox fora do ar: órgão criado (201) e OrganizationCreated gravado no outbox', async () => {
      silence();
      const events = api.outboxRows().length;
      const response = await create(
        fms({ name: 'Fundo do Relay', shortName: 'RELAY', cnpj: '20.000.000/0001-07' }),
      );
      // Sem relay no teste, o evento fica no outbox sem publicação; o status `PENDING` no banco é
      // conferido em `test/tenancy/organizations.spec.ts`.
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({ eventType: 'OrganizationCreated' });
    });
  });
});

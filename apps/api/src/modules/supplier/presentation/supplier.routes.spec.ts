import { problemDetailsSchema } from '@contrataflow/validation';
import type { SupplierDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EnvelopeFieldProtection, FIELD_PROTECTION } from '#shared/crypto/field-protection.js';
import type { FieldProtection, KeyWrapper } from '#shared/crypto/field-protection.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { SUPPLIER_TRANSACTIONS } from '../application/supplier-ports.js';
import type { SupplierTransactions } from '../application/supplier-ports.js';
import { SupplierFacade } from '../application/supplier.facade.js';
import { InMemorySupplierRepository } from '../infrastructure/in-memory-supplier.repository.js';

/*
 * US-025 — SUP-01..06 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * Idempotency-Key, validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do
 * `AuditService` e o outbox em memória. Os mesmos casos contra o PostgreSQL (RLS, índice único
 * parcial, CPF cifrado, concorrência) estão em `test/tenant-leak/suppliers.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** Carla do Gherkin: COMPRAS com SUPPLIER_MANAGE no tenant A. */
const CARLA = FAKE_USERS.fabio;
/** Bruno do Gherkin: só SUPPLIER_VIEW (REQUISITANTE). */
const BRUNO = FAKE_USERS.ana;
const SUSPENSO = FAKE_USERS.bruno;
/** Gestor de contratações do tenant B (SUPPLIER_MANAGE lá). */
const HEITOR = FAKE_USERS.heitor;
const MFA = ['pwd', 'otp'];

const CNPJ = '11.222.333/0001-81';
const CNPJ_ALFA = '12.ABC.345/01DE-35';
const CPF = '111.444.777-35';

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

function expectFieldError(response: request.Response, field: string, code: string) {
  const body = expectProblem(response, 422, 'VALIDATION_ERROR');
  expect(body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field, code })]));
  return body;
}

describe('Feature: Cadastrar e manter fornecedores (US-025)', () => {
  let api: TestApi;
  let suppliers: InMemorySupplierRepository;

  beforeAll(async () => {
    api = await createTestApi();
    suppliers = api.app.get(InMemorySupplierRepository, { strict: false });
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
    tenant: string = A,
  ): request.Test =>
    test.set('Authorization', api.bearer(user.subject, { amr: MFA })).set('X-Tenant-Id', tenant);

  const list = (query = '', user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/suppliers?${query}`), user, tenant);
  const lookup = (documentNumber: string, user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(
      request(api.server).get(
        `/api/v1/suppliers/lookup?documentNumber=${encodeURIComponent(documentNumber)}`,
      ),
      user,
      tenant,
    );
  const get = (id: string, user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/suppliers/${id}`), user, tenant);
  const create = (
    body: Record<string, unknown>,
    user: { subject: string } = CARLA,
    tenant: string = A,
  ) => withAuth(request(api.server).post('/api/v1/suppliers'), user, tenant).send(body);
  const withVersion = (test: request.Test, ifMatch: string | null) =>
    ifMatch === null ? test : test.set('If-Match', ifMatch);
  const patch = (
    id: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    user: { subject: string } = CARLA,
    tenant: string = A,
  ) =>
    withVersion(
      withAuth(request(api.server).patch(`/api/v1/suppliers/${id}`), user, tenant),
      ifMatch,
    ).send(body);
  const remove = (
    id: string,
    ifMatch: string | null,
    user: { subject: string } = CARLA,
    tenant: string = A,
  ) =>
    withVersion(
      withAuth(request(api.server).delete(`/api/v1/suppliers/${id}`), user, tenant),
      ifMatch,
    );

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const stored = (id: string) => suppliers.snapshot().find((s) => s.id === id);

  let sequence = 0;
  /** Gera um CNPJ numérico válido distinto (14 dígitos com DV). */
  const nextCnpj = (): string => {
    sequence += 1;
    const base = `${String(40_000_000 + sequence).padStart(8, '0')}0001`;
    const digit = (digits: string, weights: number[]) => {
      const sum = digits.split('').reduce((acc, d, i) => acc + Number(d) * (weights[i] ?? 0), 0);
      const rest = sum % 11;
      return rest < 2 ? 0 : 11 - rest;
    };
    const first = digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const second = digit(`${base}${first}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return `${base}${first}${second}`;
  };

  /** Cadastra um fornecedor pela API e devolve a resposta (201 conferido). */
  const supplier = async (
    legalName: string,
    extra: Record<string, unknown> = {},
  ): Promise<SupplierDto> => {
    const response = await create({
      documentType: 'CNPJ',
      documentNumber: nextCnpj(),
      legalName,
      ...extra,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return dataOf<SupplierDto>(response);
  };

  describe('[Sucesso]', () => {
    it('cadastrar com CNPJ numérico: 201, ETag "1", SupplierCreated e auditoria supplier.create', async () => {
      silence();
      const audits = auditOf('supplier.create').length;
      const events = api.outboxRows().length;

      const response = await create({
        documentType: 'CNPJ',
        documentNumber: CNPJ,
        legalName: '  Construtora ABC Ltda  ',
        email: 'Contato@ABC.com.br',
        isActive: false,
        documentNumberHash: 'forjado',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const data = dataOf<SupplierDto>(response);
      expect(response.headers.location).toBe(`/api/v1/suppliers/${data.id}`);
      expect(data).toMatchObject({
        documentType: 'CNPJ',
        documentNumber: '11222333000181',
        legalName: 'Construtora ABC Ltda',
        email: 'contato@abc.com.br',
        isActive: true,
        version: 1,
      });
      expect(data).not.toHaveProperty('documentNumberHash');
      expect(data).not.toHaveProperty('documentNumberEncrypted');
      expect(stored(data.id)).toMatchObject({ tenantId: A, documentNumberEncrypted: null });

      const created = auditOf('supplier.create');
      expect(created).toHaveLength(audits + 1);
      expect(created.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: CARLA.id,
        entityType: 'Supplier',
        entityId: data.id,
        category: 'DATA_CHANGE',
        result: 'SUCCESS',
        metadata: { documentType: 'CNPJ' },
      });
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        tenantId: A,
        eventType: 'SupplierCreated',
        routingKey: 'supplier.created',
        aggregateId: data.id,
        payload: { supplierId: data.id, documentType: 'CNPJ' },
      });
    });

    it('CNPJ alfanumérico (IN RFB 2.229/2024): criado e devolvido em claro', async () => {
      silence();
      const response = await create({
        documentType: 'CNPJ',
        documentNumber: CNPJ_ALFA,
        legalName: 'Alfa Numérica S.A.',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf<SupplierDto>(response)).toMatchObject({
        documentType: 'CNPJ',
        documentNumber: '12ABC34501DE35',
      });
      const found = await lookup('12abc34501de35');
      expect(dataOf<SupplierDto>(found)).toMatchObject({ documentNumber: '12ABC34501DE35' });
    });

    it('CPF: mascarado na resposta, cifrado no armazenamento e nunca em claro em nenhuma rota', async () => {
      silence();
      const created = await create({
        documentType: 'CPF',
        documentNumber: CPF,
        legalName: 'João da Silva',
        notes: 'Prestador autônomo',
      });

      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const data = dataOf<SupplierDto>(created);
      expect(data).toMatchObject({ documentType: 'CPF', documentNumber: '***.444.777-**' });
      const row = stored(data.id);
      expect(row?.documentNumber).toBe('***.444.777-**');
      expect(row?.documentNumberEncrypted).toBeInstanceOf(Buffer);
      expect(row?.documentNumberEncrypted?.toString('utf8')).not.toContain('11144477735');

      const responses = [
        created,
        await get(data.id),
        await list('q=Silva'),
        await lookup(CPF),
        await lookup('11144477735'),
        await patch(data.id, { tradeName: 'Silva ME' }, '"1"'),
      ];
      for (const response of responses) {
        expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
        const text = JSON.stringify(response.body);
        expect(text).not.toContain('11144477735');
        expect(text).not.toContain('111.444.777-35');
        expect(text).not.toContain('documentNumberHash');
        expect(text).not.toContain('documentNumberEncrypted');
      }
      expect(dataOf<SupplierDto>(responses[3] as request.Response).id).toBe(data.id);
      // Nem a auditoria nem o outbox carregam o CPF em claro.
      const trail = JSON.stringify([
        ...api.auditRecords().filter((r) => r.entityId === data.id),
        ...api.outboxRows().filter((r) => r.aggregateId === data.id),
      ]);
      expect(trail).not.toContain('11144477735');
      expect(trail).not.toContain('111.444.777-35');
    });

    it('estrangeiro: número livre (até 20 caracteres), sem cifra nem verificação de dígito', async () => {
      silence();
      const response = await create({
        documentType: 'FOREIGN',
        documentNumber: '  DE-123456789 ',
        legalName: 'Acme GmbH',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf<SupplierDto>(response)).toMatchObject({
        documentType: 'FOREIGN',
        documentNumber: 'DE-123456789',
      });
      expectFieldError(
        await create({
          documentType: 'FOREIGN',
          documentNumber: 'X'.repeat(21),
          legalName: 'Acme Longa',
        }),
        'documentNumber',
        'TOO_LONG',
      );
    });

    it('SUP-01/SUP-03: lista por razão social com busca e filtro Ativos/Inativos; detalhe com ETag', async () => {
      silence();
      const alpha = await supplier('Zeta Lista Comércio');
      const beta = await supplier('Alfa Lista Serviços', { tradeName: 'Alfa Expresso' });
      await patch(beta.id, { isActive: false }, '"1"');

      const all = await list('q=Lista');
      expect(all.status).toBe(200);
      expect(dataOf<SupplierDto[]>(all).map((s) => s.legalName)).toEqual([
        'Alfa Lista Serviços',
        'Zeta Lista Comércio',
      ]);
      expect((all.body as { meta: { totalItems: number } }).meta).toMatchObject({ totalItems: 2 });
      const byTrade = await list('q=expresso');
      expect(dataOf<SupplierDto[]>(byTrade).map((s) => s.id)).toEqual([beta.id]);
      const active = await list('q=Lista&isActive=true');
      expect(dataOf<SupplierDto[]>(active).map((s) => s.id)).toEqual([alpha.id]);
      const inactive = await list('q=Lista&isActive=false');
      expect(dataOf<SupplierDto[]>(inactive).map((s) => s.id)).toEqual([beta.id]);
      const paged = await list('q=Lista&pageSize=1&page=2');
      expect(dataOf<SupplierDto[]>(paged).map((s) => s.id)).toEqual([alpha.id]);

      const one = await get(alpha.id);
      expect(one.status).toBe(200);
      expect(one.headers.etag).toBe('"1"');
      expect(dataOf<SupplierDto>(one)).toMatchObject({ id: alpha.id, legalName: alpha.legalName });
    });

    it('SUP-06: lookup por documento com ou sem máscara; inexistente → data null', async () => {
      silence();
      const cnpj = nextCnpj();
      const created = await supplier('Lookup Ltda', { documentNumber: cnpj });
      const masked = `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;

      expect(dataOf<SupplierDto>(await lookup(cnpj)).id).toBe(created.id);
      expect(dataOf<SupplierDto>(await lookup(masked)).id).toBe(created.id);
      const none = await lookup('00.000.000/0001-91');
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ data: null });
    });

    it('editar (FA-01): ETag novo, auditoria sem valores de contato e SupplierUpdated com changedFields', async () => {
      silence();
      const created = await supplier('Edição Ltda');
      const audits = auditOf('supplier.update').length;
      const events = api.outboxRows().length;

      const response = await patch(
        created.id,
        { legalName: 'Edição Brasil Ltda', email: 'novo@edicao.com.br', tradeName: null },
        '"1"',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(dataOf<SupplierDto>(response)).toMatchObject({
        legalName: 'Edição Brasil Ltda',
        email: 'novo@edicao.com.br',
        version: 2,
      });
      const records = auditOf('supplier.update');
      expect(records).toHaveLength(audits + 1);
      const record = records.at(-1);
      expect(record).toMatchObject({ entityId: created.id, metadata: { documentType: 'CNPJ' } });
      expect(record?.changes).toEqual([
        { path: 'legalName', old: 'Edição Ltda', new: 'Edição Brasil Ltda' },
        { path: 'email', old: '[alterado]', new: '[alterado]' },
      ]);
      expect(JSON.stringify(record)).not.toContain('novo@edicao.com.br');
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'SupplierUpdated',
        routingKey: 'supplier.updated',
        payload: {
          supplierId: created.id,
          documentType: 'CNPJ',
          changedFields: ['legalName', 'email'],
        },
      });
    });

    it('nada alterado: 200 sem nova versão, auditoria nem evento', async () => {
      silence();
      const created = await supplier('Sem Mudança Ltda');
      const audits = api.auditRecords().length;
      const events = api.outboxRows().length;

      const response = await patch(created.id, { legalName: 'Sem Mudança Ltda' }, '"1"');

      expect(response.status).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(api.auditRecords()).toHaveLength(audits);
      expect(api.outboxRows()).toHaveLength(events);
    });

    it('inativar e reativar (FA-02): supplier.deactivate, SupplierUpdated e o cadastro permanece', async () => {
      silence();
      const created = await supplier('Inativável Ltda');

      const off = await patch(created.id, { isActive: false }, '"1"');
      expect(dataOf<SupplierDto>(off)).toMatchObject({ isActive: false, version: 2 });
      expect(auditOf('supplier.deactivate').at(-1)).toMatchObject({
        entityId: created.id,
        metadata: { documentType: 'CNPJ' },
      });
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'SupplierUpdated',
        payload: expect.objectContaining({ changedFields: ['isActive'] }) as unknown,
      });

      const on = await patch(created.id, { isActive: true }, '"2"');
      expect(dataOf<SupplierDto>(on)).toMatchObject({ isActive: true, version: 3 });
      expect(auditOf('supplier.update').at(-1)).toMatchObject({ entityId: created.id });
      expect(dataOf<SupplierDto>(await get(created.id)).isActive).toBe(true);
    });

    it('excluir sem uso (FA-03): 204, supplier.delete sem evento, some das rotas e libera o documento', async () => {
      silence();
      const cnpj = nextCnpj();
      const created = await supplier('Excluível Ltda', { documentNumber: cnpj });
      const events = api.outboxRows().length;

      const response = await remove(created.id, '"1"');

      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect(auditOf('supplier.delete').at(-1)).toMatchObject({
        entityId: created.id,
        category: 'DATA_CHANGE',
        metadata: { documentType: 'CNPJ' },
      });
      expect(api.outboxRows()).toHaveLength(events);
      expect(stored(created.id)?.deletedAt).not.toBeNull();
      expectProblem(await get(created.id), 404, 'NOT_FOUND');
      expect((await lookup(cnpj)).body).toEqual({ data: null });
      expect(dataOf<SupplierDto[]>(await list('q=Excluível'))).toHaveLength(0);

      const again = await create({
        documentType: 'CNPJ',
        documentNumber: cnpj,
        legalName: 'Excluível Ltda (novo)',
      });
      expect(again.status, JSON.stringify(again.body)).toBe(201);
    });

    it('Idempotency-Key na criação: a repetição devolve o mesmo fornecedor', async () => {
      silence();
      const key = newId();
      const body = { documentType: 'CNPJ', documentNumber: nextCnpj(), legalName: 'Idempotente' };
      const first = await create(body).set('Idempotency-Key', key);
      const again = await create(body).set('Idempotency-Key', key);

      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(dataOf<SupplierDto>(again).id).toBe(dataOf<SupplierDto>(first).id);
      expect(suppliers.snapshot().filter((s) => s.legalName === 'Idempotente')).toHaveLength(1);
    });
  });

  describe('[Validação]', () => {
    it('V-02: CNPJ com dígito verificador inválido → 422 INVALID_CNPJ em documentNumber e nada criado', async () => {
      silence();
      const total = suppliers.snapshot().length;

      const response = await create({
        documentType: 'CNPJ',
        documentNumber: '11.222.333/0001-00',
        legalName: 'Inválida Ltda',
      });

      expectFieldError(response, 'documentNumber', 'INVALID_CNPJ');
      expect(suppliers.snapshot()).toHaveLength(total);
    });

    it('V-03: CPF com dígito verificador inválido → 422 INVALID_CPF', async () => {
      silence();
      expectFieldError(
        await create({
          documentType: 'CPF',
          documentNumber: '111.444.777-00',
          legalName: 'Pessoa',
        }),
        'documentNumber',
        'INVALID_CPF',
      );
    });

    it('V-01/V-05/V-06: obrigatórios, e-mail, website e limites de tamanho', async () => {
      silence();
      const empty = await create({});
      const body = expectProblem(empty, 422, 'VALIDATION_ERROR');
      expect(body.errors.map((e) => e.field)).toEqual(
        expect.arrayContaining(['documentType', 'documentNumber', 'legalName']),
      );
      const base = { documentType: 'CNPJ', documentNumber: nextCnpj(), legalName: 'Limites Ltda' };
      expectFieldError(await create({ ...base, email: 'sem-arroba' }), 'email', 'INVALID_FORMAT');
      expectFieldError(await create({ ...base, website: 'abc' }), 'website', 'INVALID_FORMAT');
      expectFieldError(await create({ ...base, legalName: 'A' }), 'legalName', 'TOO_SHORT');
      expectFieldError(
        await create({ ...base, tradeName: 'A'.repeat(251) }),
        'tradeName',
        'TOO_LONG',
      );
      expectFieldError(await create({ ...base, notes: 'A'.repeat(5_001) }), 'notes', 'TOO_LONG');
    });

    it('V-07: alterar tipo ou número do documento em edição → 422 NOT_ALLOWED; o mesmo número é aceito', async () => {
      silence();
      const cnpj = nextCnpj();
      const created = await supplier('Documento Fixo Ltda', { documentNumber: cnpj });

      expectFieldError(
        await patch(created.id, { documentNumber: nextCnpj() }, '"1"'),
        'documentNumber',
        'NOT_ALLOWED',
      );
      expectFieldError(
        await patch(created.id, { documentType: 'CPF' }, '"1"'),
        'documentNumber',
        'NOT_ALLOWED',
      );
      const same = await patch(created.id, { documentNumber: cnpj, legalName: 'Fixo Ltda' }, '"1"');
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(stored(created.id)).toMatchObject({ documentNumber: cnpj, version: 2 });
    });

    it('sem If-Match → 428; If-Match divergente → 412 VERSION_CONFLICT com currentVersion', async () => {
      silence();
      const created = await supplier('Versão Ltda');

      expectProblem(await patch(created.id, { notes: 'a' }, null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await remove(created.id, null), 428, 'PRECONDITION_REQUIRED');
      await patch(created.id, { notes: 'primeira' }, '"1"');
      const stale = await patch(created.id, { notes: 'segunda' }, '"1"');
      const problem = expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(problem).toMatchObject({ currentVersion: 2 });
      expectProblem(await remove(created.id, '"1"'), 412, 'VERSION_CONFLICT');
    });

    it('q com 1 caractere na lista → 422; documentNumber ausente no lookup → 422', async () => {
      silence();
      expectFieldError(await list('q=a'), 'q', 'TOO_SHORT');
      expect(
        (await withAuth(request(api.server).get('/api/v1/suppliers/lookup'), CARLA)).status,
      ).toBe(422);
    });
  });

  describe('[Permissão]', () => {
    it('sem SUPPLIER_MANAGE: 403 PERMISSION_DENIED, access.denied com o motivo e nada criado/alterado', async () => {
      silence();
      const target = await supplier('Protegido Ltda');
      const denials = auditOf('access.denied').length;
      const total = suppliers.snapshot().length;

      const response = await create(
        { documentType: 'CNPJ', documentNumber: nextCnpj(), legalName: 'Negado Ltda' },
        BRUNO,
      );

      expectProblem(response, 403, 'PERMISSION_DENIED');
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: BRUNO.id,
        reasonCode: 'SUPPLIER_MANAGE',
        result: 'DENIED',
      });
      expect(suppliers.snapshot()).toHaveLength(total);
      for (const attempt of [
        patch(target.id, { legalName: 'Outro nome' }, '"1"', BRUNO),
        patch(target.id, { isActive: false }, '"1"', BRUNO),
        remove(target.id, '"1"', BRUNO),
      ]) {
        expectProblem(await attempt, 403, 'PERMISSION_DENIED');
      }
      expect(stored(target.id)).toMatchObject({ legalName: 'Protegido Ltda', version: 1 });
    });

    it('SUPPLIER_VIEW consulta (lista, detalhe e lookup) mas não escreve', async () => {
      silence();
      const cnpj = nextCnpj();
      const target = await supplier('Visível Ltda', { documentNumber: cnpj });

      expect((await list('q=Visível', BRUNO)).status).toBe(200);
      expect(dataOf<SupplierDto>(await get(target.id, BRUNO)).id).toBe(target.id);
      expect(dataOf<SupplierDto>(await lookup(cnpj, BRUNO)).id).toBe(target.id);
    });

    it('sem SUPPLIER_VIEW (vínculo suspenso): consulta recusada', async () => {
      silence();
      const response = await list('', SUSPENSO);
      expect(response.status).toBeGreaterThanOrEqual(401);
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('lookup não revela fornecedor de outro tenant; detalhe/edição/exclusão → 404; lista só do tenant', async () => {
      silence();
      const cnpjB = nextCnpj();
      const createdB = await create(
        { documentType: 'CNPJ', documentNumber: cnpjB, legalName: 'Fornecedora LEAK-B' },
        HEITOR,
        B,
      );
      expect(createdB.status, JSON.stringify(createdB.body)).toBe(201);
      const idB = dataOf<SupplierDto>(createdB).id;
      expect(stored(idB)?.tenantId).toBe(B);

      const found = await lookup(cnpjB);
      expect(found.status).toBe(200);
      expect(found.body).toEqual({ data: null });
      expect(JSON.stringify(found.body)).not.toContain('LEAK-B');
      expectProblem(await get(idB), 404, 'NOT_FOUND');
      expectProblem(await patch(idB, { legalName: 'Invadida' }, '"1"'), 404, 'NOT_FOUND');
      expectProblem(await remove(idB, '"1"'), 404, 'NOT_FOUND');
      expect(JSON.stringify((await list('q=LEAK-B')).body)).not.toContain('LEAK-B');
      expect(stored(idB)).toMatchObject({ legalName: 'Fornecedora LEAK-B', deletedAt: null });

      // O mesmo CNPJ pode existir nos dois tenants (a unicidade é por tenant).
      const sameInA = await create({
        documentType: 'CNPJ',
        documentNumber: cnpjB,
        legalName: 'Mesma Empresa no A',
      });
      expect(sameInA.status, JSON.stringify(sameInA.body)).toBe(201);
      expect(dataOf<SupplierDto>(await lookup(cnpjB)).legalName).toBe('Mesma Empresa no A');
    });
  });

  describe('[Duplicidade]', () => {
    it('mesmo documento no tenant → 409 SUPPLIER_ALREADY_EXISTS e nenhum segundo fornecedor', async () => {
      silence();
      const cnpj = nextCnpj();
      const first = await supplier('Construtora Original', { documentNumber: cnpj });
      const total = suppliers.snapshot().length;

      const response = await create({
        documentType: 'CNPJ',
        documentNumber: cnpj,
        legalName: 'Construtora Duplicada',
      });

      const problem = expectProblem(response, 409, 'SUPPLIER_ALREADY_EXISTS');
      expect(problem).toMatchObject({ existingSupplierId: first.id });
      expect(suppliers.snapshot()).toHaveLength(total);
    });

    it('CPF duplicado, com ou sem máscara, também é recusado', async () => {
      silence();
      const cpf = '529.982.247-25';
      const first = await create({ documentType: 'CPF', documentNumber: cpf, legalName: 'Maria' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const again = await create({
        documentType: 'CPF',
        documentNumber: '52998224725',
        legalName: 'Maria de novo',
      });
      expectProblem(again, 409, 'SUPPLIER_ALREADY_EXISTS');
    });
  });

  describe('[Concorrência]', () => {
    it('duas criações simultâneas do mesmo CNPJ: exatamente uma 201 e a outra 409', async () => {
      silence();
      const cnpj = nextCnpj();
      const body = { documentType: 'CNPJ', documentNumber: cnpj, legalName: 'Corrida Ltda' };

      const [one, two] = await Promise.all([create(body), create(body)]);

      expect([one.status, two.status].sort()).toEqual([201, 409]);
      const loser = one.status === 409 ? one : two;
      expectProblem(loser, 409, 'SUPPLIER_ALREADY_EXISTS');
      expect(
        suppliers.snapshot().filter((s) => s.tenantId === A && s.legalName === 'Corrida Ltda'),
      ).toHaveLength(1);
    });
  });

  describe('[Fornecedor em uso]', () => {
    it('V-08: excluir fornecedor referenciado → 409 SUPPLIER_IN_USE; inativar segue permitido', async () => {
      silence();
      const emUso = await supplier('Em Uso Ltda');
      const livre = await supplier('Livre Ltda');
      api.app.get(SupplierFacade).registerUsageProvider({
        isInUse: (_tx, supplierId) => Promise.resolve(supplierId === emUso.id),
      });
      const audits = auditOf('supplier.delete').length;

      expectProblem(await remove(emUso.id, '"1"'), 409, 'SUPPLIER_IN_USE');
      expect(auditOf('supplier.delete')).toHaveLength(audits);
      expect(stored(emUso.id)?.deletedAt).toBeNull();
      const inactivated = await patch(emUso.id, { isActive: false }, '"1"');
      expect(inactivated.status, JSON.stringify(inactivated.body)).toBe(200);

      expect((await remove(livre.id, '"1"')).status).toBe(204);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível no cadastro: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      silence();
      const failing: SupplierTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [{ token: SUPPLIER_TRANSACTIONS, value: failing }],
      });
      const errorLog = vi.spyOn(Logger.prototype, 'error');
      try {
        const response = await request(down.server)
          .post('/api/v1/suppliers')
          .set('Authorization', down.bearer(CARLA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({ documentType: 'CNPJ', documentNumber: nextCnpj(), legalName: 'Sem Banco' });

        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('5');
        expect(down.auditRecords().filter((r) => r.action === 'supplier.create')).toHaveLength(0);
        expect(down.outboxRows()).toHaveLength(0);
        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'supplier.create_failed',
            errorCode: 'DEPENDENCY_UNAVAILABLE',
          }),
          'supplier.create_failed',
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Sem Banco');
      } finally {
        await down.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('KMS indisponível ao cadastrar CPF: 503 DEPENDENCY_UNAVAILABLE e nenhum CPF persistido sem criptografia', async () => {
      silence();
      const brokenKms: KeyWrapper = {
        wrap: () => Promise.reject(new Error('KMS timeout')),
        unwrap: () => Promise.reject(new Error('KMS timeout')),
      };
      const protection: FieldProtection = new EnvelopeFieldProtection(
        brokenKms,
        Buffer.alloc(32, 7),
      );
      const down = await createTestApi({
        providers: [{ token: FIELD_PROTECTION, value: protection }],
      });
      const downSuppliers = down.app.get(InMemorySupplierRepository, { strict: false });
      const errorLog = vi.spyOn(Logger.prototype, 'error');
      try {
        const cpf = await request(down.server)
          .post('/api/v1/suppliers')
          .set('Authorization', down.bearer(CARLA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({ documentType: 'CPF', documentNumber: '390.533.447-05', legalName: 'Sem KMS' });

        expectProblem(cpf, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(cpf.headers['retry-after']).toBe('5');
        expect(downSuppliers.snapshot()).toHaveLength(0);
        expect(down.auditRecords().filter((r) => r.action === 'supplier.create')).toHaveLength(0);
        expect(down.outboxRows()).toHaveLength(0);
        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'supplier.create_failed' }),
          'supplier.create_failed',
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain('39053344705');

        // CNPJ não passa pelo KMS: segue funcionando.
        const cnpj = await request(down.server)
          .post('/api/v1/suppliers')
          .set('Authorization', down.bearer(CARLA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({ documentType: 'CNPJ', documentNumber: nextCnpj(), legalName: 'Sem KMS CNPJ' });
        expect(cnpj.status, JSON.stringify(cnpj.body)).toBe(201);
      } finally {
        await down.close();
      }
    });
  });
});

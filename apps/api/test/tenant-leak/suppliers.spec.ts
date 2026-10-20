// Fornecedores na API inteira sobre PostgreSQL real (US-025 · Tenant incorreto, Permissão, Duplicidade,
// Concorrência, Falha de banco, Falha de integração): usuários nos tenants A e B, auditoria e outbox
// reais na mesma transação, RLS, índice único parcial `(tenant, tipo, hash)`, CPF cifrado e
// mascarado, exclusão lógica e gatilho de documento imutável. Perfis ainda não existem como
// registro (US-096): o vínculo ganha `roleKeys` por uma porta de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { SupplierDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { SupplierFacade } from '#modules/supplier/application/supplier.facade.js';
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

const A = '0192d000-0000-7000-8000-00000000025a';
const B = '0192d000-0000-7000-8000-00000000025b';
const CARLA = '0192d000-0000-7000-8000-0000000025a1';
const BRUNO = '0192d000-0000-7000-8000-0000000025a2';
const BETO = '0192d000-0000-7000-8000-0000000025b1';
const MFA = ['pwd', 'otp'];

const CNPJ = '11222333000181';
const CNPJ_ALFA = '12ABC34501DE35';
const CPF = '11144477735';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['COMPRAS'],
  [BRUNO]: ['REQUISITANTE'],
  [BETO]: ['COMPRAS'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-sao-jose-sup', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-sup', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Dias'),
  ('${BRUNO}', 'sub-bruno', 'bruno@a.test', true, 'Bruno Lima'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192d000-0000-7000-8000-0000000125a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000125a2', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000125b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
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

describe('Feature: fornecedores isolados por tenant sobre PostgreSQL (US-025)', () => {
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
    const test = request(api.server)[method](`/api/v1/suppliers${path}`);
    return test.set('Authorization', as(subject)).set('X-Tenant-Id', tenant);
  };
  const create = (body: Record<string, unknown>, subject = 'sub-carla', tenant = A) =>
    call('post', '', subject, tenant).send(body);
  const lookup = (documentNumber: string, subject = 'sub-carla', tenant = A) =>
    call('get', `/lookup?documentNumber=${encodeURIComponent(documentNumber)}`, subject, tenant);

  const row = async (id: string) =>
    (await db.admin<Row>('SELECT * FROM suppliers WHERE id = $1', [id]))[0];
  const digestOfB = async () => {
    const [result] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM suppliers t WHERE tenant_id = $1`,
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
      `SELECT tenant_id, action, result, reason_code, actor_user_id, changes, metadata
         FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at`,
      [entityId],
    );
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  const supplier = async (documentNumber: string, legalName: string, documentType = 'CNPJ') => {
    const response = await create({ documentType, documentNumber, legalName });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: SupplierDto }).data;
  };

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

  it('[Sucesso][Falha de integração] CNPJ numérico: linha com hash, auditoria e evento PENDING (sem relay)', async () => {
    const created = await supplier(CNPJ, 'Construtora ABC Ltda');

    expect(await row(created.id)).toMatchObject({
      tenant_id: A,
      document_type: 'CNPJ',
      document_number: CNPJ,
      document_number_encrypted: null,
      legal_name: 'Construtora ABC Ltda',
      is_active: true,
      deleted_at: null,
      version: 1,
      created_by_id: CARLA,
    });
    expect(String((await row(created.id))?.document_number_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(await audits(created.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        action: 'supplier.create',
        result: 'SUCCESS',
        actor_user_id: CARLA,
        metadata: { documentType: 'CNPJ' },
      }),
    ]);
    expect(await events(created.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        event_type: 'SupplierCreated',
        routing_key: 'supplier.created',
        status: 'PENDING',
        payload: { supplierId: created.id, documentType: 'CNPJ' },
      }),
    ]);
  });

  it('[Sucesso] CNPJ alfanumérico é aceito, persistido em maiúsculas e encontrado pelo lookup', async () => {
    const created = await supplier('12.abc.345/01de-35', 'Alfa Numérica S.A.');

    expect(await row(created.id)).toMatchObject({ document_number: CNPJ_ALFA });
    const found = await lookup('12.ABC.345/01DE-35');
    expect(found.status).toBe(200);
    expect((found.body as { data: SupplierDto }).data.id).toBe(created.id);
  });

  it('[Sucesso] CPF: mascarado na coluna e na API, cifrado em bytea e ausente do banco, da auditoria e do outbox', async () => {
    const created = await supplier('111.444.777-35', 'João da Silva', 'CPF');

    expect(created.documentNumber).toBe('***.444.777-**');
    const stored = await row(created.id);
    expect(stored).toMatchObject({ document_type: 'CPF', document_number: '***.444.777-**' });
    const encrypted = stored?.document_number_encrypted as Buffer;
    expect(Buffer.isBuffer(encrypted)).toBe(true);
    expect(encrypted.length).toBeGreaterThan(40);
    expect(encrypted.toString('latin1')).not.toContain(CPF);

    const [everything] = await db.admin<{ text: string }>(
      `SELECT (SELECT string_agg(t::text, '|') FROM suppliers t WHERE id = $1)
              || (SELECT coalesce(string_agg(a::text, '|'), '') FROM audit_logs a WHERE entity_id = $1)
              || (SELECT coalesce(string_agg(o::text, '|'), '') FROM outbox_events o WHERE aggregate_id = $1)
              AS text`,
      [created.id],
    );
    expect(everything?.text).not.toContain(CPF);
    expect(everything?.text).not.toContain('111.444.777-35');
    const trail = await audits(created.id);
    expect(JSON.stringify(trail)).toContain('documentNumberHash');
    expect(JSON.stringify(trail)).not.toContain('"documentNumber"');

    for (const response of [
      await call('get', `/${created.id}`, 'sub-carla'),
      await call('get', '?q=Silva', 'sub-carla'),
      await lookup('111.444.777-35'),
    ]) {
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(CPF);
    }
  });

  it('[Sucesso] editar e inativar: versão, auditoria sem contato e evento; excluir é lógico e libera o documento', async () => {
    const created = await supplier('45997418000153', 'Ciclo de Vida Ltda');

    const edited = await call('patch', `/${created.id}`, 'sub-carla')
      .set('If-Match', '"1"')
      .send({ tradeName: 'Ciclo', email: 'ciclo@fornecedor.test' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.headers.etag).toBe('"2"');
    const off = await call('patch', `/${created.id}`, 'sub-carla')
      .set('If-Match', '"2"')
      .send({ isActive: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await row(created.id)).toMatchObject({
      trade_name: 'Ciclo',
      is_active: false,
      version: 3,
      updated_by_id: CARLA,
    });
    const trail = await audits(created.id);
    expect(trail.map((entry) => entry.action)).toEqual([
      'supplier.create',
      'supplier.update',
      'supplier.deactivate',
    ]);
    expect(JSON.stringify(trail)).not.toContain('ciclo@fornecedor.test');
    expect((await events(created.id)).map((event) => event.event_type)).toEqual([
      'SupplierCreated',
      'SupplierUpdated',
      'SupplierUpdated',
    ]);

    const removed = await call('delete', `/${created.id}`, 'sub-carla').set('If-Match', '"3"');
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(await row(created.id)).toMatchObject({ version: 4 });
    expect((await row(created.id))?.deleted_at).not.toBeNull();
    expect((await audits(created.id)).at(-1)).toMatchObject({ action: 'supplier.delete' });
    expect((await events(created.id)).map((event) => event.event_type)).toHaveLength(3);
    expect((await call('get', `/${created.id}`, 'sub-carla')).status).toBe(404);
    // O documento fica livre para um novo cadastro (índice único parcial).
    const again = await supplier('45997418000153', 'Ciclo de Vida Ltda (novo)');
    expect(again.id).not.toBe(created.id);
  });

  it('[Validação] DV inválido de CNPJ/CPF → 422 sem linha criada; tipo/número imutáveis → 422 NOT_ALLOWED', async () => {
    const [{ total: before }] = (await db.admin<{ total: string }>(
      'SELECT count(*) AS total FROM suppliers WHERE tenant_id = $1',
      [A],
    )) as [{ total: string }];

    const cnpj = await create({
      documentType: 'CNPJ',
      documentNumber: '11.222.333/0001-00',
      legalName: 'Inválida',
    });
    expect(cnpj.status).toBe(422);
    expect(problemDetailsSchema.parse(cnpj.body).errors).toEqual([
      expect.objectContaining({ field: 'documentNumber', code: 'INVALID_CNPJ' }),
    ]);
    const cpf = await create({
      documentType: 'CPF',
      documentNumber: '111.444.777-00',
      legalName: 'Inválida',
    });
    expect(problemDetailsSchema.parse(cpf.body).errors).toEqual([
      expect.objectContaining({ field: 'documentNumber', code: 'INVALID_CPF' }),
    ]);
    const [{ total: after }] = (await db.admin<{ total: string }>(
      'SELECT count(*) AS total FROM suppliers WHERE tenant_id = $1',
      [A],
    )) as [{ total: string }];
    expect(after).toBe(before);

    const target = await supplier('60746948000112', 'Documento Fixo Ltda');
    const changed = await call('patch', `/${target.id}`, 'sub-carla')
      .set('If-Match', '"1"')
      .send({ documentNumber: CNPJ });
    expect(changed.status).toBe(422);
    expect(problemDetailsSchema.parse(changed.body).errors).toEqual([
      expect.objectContaining({ field: 'documentNumber', code: 'NOT_ALLOWED' }),
    ]);
    // Na camada do banco, o gatilho também impede a troca do documento.
    await expect(
      db.admin(`UPDATE suppliers SET document_number = '99999999000191' WHERE id = '${target.id}'`),
    ).rejects.toThrow(/imutáveis/);
  });

  it('[Banco] checks: CPF sempre mascarado e cifrado; hash hexadecimal; CNPJ no formato', async () => {
    const insert = (values: string) =>
      db.admin(
        `INSERT INTO suppliers (id, tenant_id, document_type, document_number,
                                document_number_encrypted, document_number_hash, legal_name)
         VALUES ${values}`,
      );
    const hash = 'c'.repeat(64);
    await expect(
      insert(`('${randomUUID()}', '${A}', 'CPF', '${CPF}', '\\x00', '${hash}', 'CPF em claro')`),
    ).rejects.toThrow(/suppliers_cpf_protected/);
    await expect(
      insert(
        `('${randomUUID()}', '${A}', 'CPF', '***.444.777-**', NULL, '${hash}', 'CPF sem cifra')`,
      ),
    ).rejects.toThrow(/suppliers_cpf_protected/);
    await expect(
      insert(`('${randomUUID()}', '${A}', 'CNPJ', '${CNPJ}', '\\x00', '${hash}', 'CNPJ cifrado')`),
    ).rejects.toThrow(/suppliers_cpf_protected/);
    await expect(
      insert(`('${randomUUID()}', '${A}', 'CNPJ', '${CNPJ}', NULL, 'curto', 'Hash inválido')`),
    ).rejects.toThrow(/suppliers_document_hash_format/);
    await expect(
      insert(`('${randomUUID()}', '${A}', 'CNPJ', '123', NULL, '${hash}', 'CNPJ curto')`),
    ).rejects.toThrow(/suppliers_cnpj_format/);
  });

  it('[Permissão] sem SUPPLIER_MANAGE → 403 e access.denied; SUPPLIER_VIEW consulta', async () => {
    const target = await supplier('33000167000101', 'Protegida Ltda');

    const denied = await create(
      { documentType: 'CNPJ', documentNumber: '04252011000110', legalName: 'Negada' },
      'sub-bruno',
    );
    expect(denied.status).toBe(403);
    expect(codeOf(denied)).toBe('PERMISSION_DENIED');
    const [{ total }] = (await db.admin<{ total: string }>(
      `SELECT count(*) AS total FROM audit_logs
        WHERE action = 'access.denied' AND reason_code = 'SUPPLIER_MANAGE' AND actor_user_id = $1`,
      [BRUNO],
    )) as [{ total: string }];
    expect(Number(total)).toBeGreaterThanOrEqual(1);
    expect(
      (
        await call('patch', `/${target.id}`, 'sub-bruno')
          .set('If-Match', '"1"')
          .send({ notes: 'x' })
      ).status,
    ).toBe(403);
    expect((await call('delete', `/${target.id}`, 'sub-bruno').set('If-Match', '"1"')).status).toBe(
      403,
    );
    expect((await call('get', `/${target.id}`, 'sub-bruno')).status).toBe(200);
    expect((await lookup('33000167000101', 'sub-bruno')).status).toBe(200);
  });

  it('[Tenant incorreto] lookup, detalhe, edição e exclusão não alcançam outro tenant; RLS isola a tabela', async () => {
    const createdB = await create(
      { documentType: 'CNPJ', documentNumber: '34028316000103', legalName: 'Fornecedora LEAK-B' },
      'sub-beto',
      B,
    );
    expect(createdB.status, JSON.stringify(createdB.body)).toBe(201);
    const idB = (createdB.body as { data: SupplierDto }).data.id;
    const before = await digestOfB();

    const found = await lookup('34.028.316/0001-03');
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ data: null });
    for (const attempt of [
      call('get', `/${idB}`, 'sub-carla'),
      call('patch', `/${idB}`, 'sub-carla').set('If-Match', '"1"').send({ legalName: 'Invadida' }),
      call('delete', `/${idB}`, 'sub-carla').set('If-Match', '"1"'),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(404);
      expect(codeOf(response)).toBe('NOT_FOUND');
    }
    expect(JSON.stringify((await call('get', '?q=LEAK-B', 'sub-carla')).body)).not.toContain(
      'LEAK-B',
    );
    expect(await digestOfB()).toBe(before);

    // O mesmo CNPJ nos dois tenants: a unicidade é por tenant.
    const sameInA = await create({
      documentType: 'CNPJ',
      documentNumber: '34028316000103',
      legalName: 'Mesma Empresa no A',
    });
    expect(sameInA.status, JSON.stringify(sameInA.body)).toBe(201);
    expect(await digestOfB()).toBe(before);

    // RLS + extensão de isolamento: a transação de A não lê B nem com filtro explícito.
    const app = db.client('cf_app');
    await expect(
      asTenant(A, () =>
        app.$tenantTransaction((tx) => tx.supplier.findMany({ where: { tenantId: B } })),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationViolationError);
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) =>
          tx.$queryRaw<
            { total: bigint }[]
          >`SELECT count(*) AS total FROM suppliers WHERE id = ${idB}::uuid`,
      ),
    );
    expect(Number(visible[0]?.total)).toBe(0);
  });

  it('[Duplicidade] mesmo documento no tenant → 409 e uma só linha (CPF com e sem máscara)', async () => {
    await supplier('07526557000100', 'Original Ltda');
    const dup = await create({
      documentType: 'CNPJ',
      documentNumber: '07.526.557/0001-00',
      legalName: 'Duplicada Ltda',
    });
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('SUPPLIER_ALREADY_EXISTS');

    await supplier('529.982.247-25', 'Maria', 'CPF');
    const dupCpf = await create({
      documentType: 'CPF',
      documentNumber: '52998224725',
      legalName: 'Maria de novo',
    });
    expect(dupCpf.status).toBe(409);
    expect(codeOf(dupCpf)).toBe('SUPPLIER_ALREADY_EXISTS');
    const [{ total }] = (await db.admin<{ total: string }>(
      `SELECT count(*) AS total FROM suppliers WHERE tenant_id = $1 AND legal_name IN ('Original Ltda', 'Duplicada Ltda', 'Maria', 'Maria de novo')`,
      [A],
    )) as [{ total: string }];
    expect(Number(total)).toBe(2);
  });

  it('[Concorrência] duas criações simultâneas do mesmo CNPJ → uma 201 e uma 409; uma só linha', async () => {
    const body = {
      documentType: 'CNPJ',
      documentNumber: '27865757000102',
      legalName: 'Corrida Ltda',
    };

    const responses = await Promise.all([create(body), create(body), create(body)]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    for (const loser of responses.filter((response) => response.status === 409)) {
      expect(codeOf(loser)).toBe('SUPPLIER_ALREADY_EXISTS');
    }
    const [{ total }] = (await db.admin<{ total: string }>(
      `SELECT count(*) AS total FROM suppliers WHERE tenant_id = $1 AND legal_name = 'Corrida Ltda'`,
      [A],
    )) as [{ total: string }];
    expect(Number(total)).toBe(1);
  });

  it('[Concorrência] duas edições com o mesmo If-Match → uma 200 e uma 412', async () => {
    const target = await supplier('00360305000104', 'Edição Concorrente Ltda');
    const edit = (notes: string) =>
      call('patch', `/${target.id}`, 'sub-carla').set('If-Match', '"1"').send({ notes });

    const responses = await Promise.all([edit('a'), edit('b')]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect((await row(target.id))?.version).toBe(2);
  });

  it('[Fornecedor em uso] excluir referenciado → 409 SUPPLIER_IN_USE e a linha permanece', async () => {
    const target = await supplier('00394460000141', 'Em Uso Ltda');
    api.app.get(SupplierFacade).registerUsageProvider({
      isInUse: (_tx, supplierId) => Promise.resolve(supplierId === target.id),
    });

    const response = await call('delete', `/${target.id}`, 'sub-carla').set('If-Match', '"1"');

    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe('SUPPLIER_IN_USE');
    expect((await row(target.id))?.deleted_at).toBeNull();
    const off = await call('patch', `/${target.id}`, 'sub-carla')
      .set('If-Match', '"1"')
      .send({ isActive: false });
    expect(off.status).toBe(200);
  });

  it('[Falha de banco] banco indisponível no cadastro → 503 DEPENDENCY_UNAVAILABLE com Retry-After', async () => {
    dbStopped = true;
    await db.container.stop();

    const response = await create({
      documentType: 'CNPJ',
      documentNumber: '15436940000103',
      legalName: 'Sem Banco Ltda',
    });

    expect(response.status).toBe(503);
    expect(codeOf(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});

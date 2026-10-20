// Versões imutáveis do documento sobre PostgreSQL real (US-066 · Sucesso, Concorrência, Falha de
// banco, Falha de integração, Tenant incorreto, Imutabilidade): a API inteira como `cf_app` (RLS)
// com os seeders reais, o processo criado pelo PRC-02 e o documento pela fábrica única. Prova: o
// "Salvar versão" grava versão `MANUAL` (hash reproduzível do snapshot canônico), aponta o documento,
// audita e deixa o evento `PENDING` num commit; dois pedidos simultâneos serializam pelo
// `FOR UPDATE` e viram versões consecutivas; falha induzida no outbox não deixa versão; DOC-15/16/
// 17/18 com ids de outro tenant → 404 e a RLS esconde as versões; a versão MANUAL não muda nem some.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_TRANSACTIONS } from '#modules/document/application/ports.js';
import type { DocumentTransactions } from '#modules/document/application/ports.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { documentFacadeOf, openStageForAnyType } from '../support/document-fixtures.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c066-0000-7000-8000-00000000010a';
const B = '0192c066-0000-7000-8000-00000000010b';
const ORG_A = '0192c066-0000-7000-8000-0000000010a0';
const ORG_B = '0192c066-0000-7000-8000-0000000010b0';
const OBRAS = '0192c066-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c066-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c066-0000-7000-8000-0000000010b1';
const LUCIA = '0192c066-0000-7000-8000-0000000010c2';
const BETO = '0192c066-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c066-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us066', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us066', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${LUCIA}', 'sub-lucia-us066', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us066', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c066-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: Versões imutáveis do documento sobre PostgreSQL (US-066)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let openStages: Set<string>;
  let despacho: string;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (
    method: 'get' | 'post',
    url: string,
    options: { subject?: string; tenant?: string; body?: object; key?: string } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us066', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method === 'post') pending = pending.set('Idempotency-Key', options.key ?? randomUUID());
    return options.body === undefined ? pending : pending.send(options.body);
  };

  const save = (
    id: string,
    body: object = {},
    options: { subject?: string; tenant?: string } = {},
  ) => call('post', `/documents/${id}/versions`, { body, ...options });

  async function newProcess(): Promise<string> {
    const catalog = async (type: string, code: string) => {
      const [row] = await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [A, type, code],
      );
      return row?.id ?? '';
    };
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-lucia-us066', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalog('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: await catalog('PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    openStages.add(id);
    return id;
  }

  /** Cria o documento na transação real do módulo, no contexto de Lúcia. */
  async function newDocument(): Promise<{ id: string }> {
    const processId = await newProcess();
    const transactions = api.app.get<DocumentTransactions>(DOCUMENT_TRANSACTIONS);
    return runWithRequestContext(
      { correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' },
      () => {
        updateRequestContext({
          tenantId: A,
          actor: { type: 'USER', userId: LUCIA, membershipId: LUCIA_M },
          amr: MFA,
        });
        return transactions.run((tx) =>
          documentFacadeOf(api).createIn(tx, {
            processId,
            documentTypeId: despacho,
            title: 'ETP 0003/2026 — rascunho',
            templateVersionId: null,
          }),
        );
      },
    );
  }

  const count = async (sql: string, params: unknown[]) =>
    Number((await db.admin<{ count: string }>(sql, params))[0]?.count ?? 0);

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
      DATABASE_POOL_SIZE: '20',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    openStages = openStageForAnyType(api);
    const [type] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DESPACHO'",
      [A],
    );
    despacho = type?.id ?? '';
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] salvar versão grava MANUAL com hash reproduzível, aponta o documento, audita e deixa o evento PENDING', async () => {
    const document = await newDocument();
    const response = await save(document.id, { changeSummary: 'Ajuste na justificativa' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: { id: string; contentHash: string } }).data;

    const [version] = await db.admin<{
      id: string;
      version_number: number;
      reason: string;
      status_at_creation: string;
      change_summary: string;
      content: unknown;
      content_hash: string;
    }>(
      'SELECT id, version_number, reason, status_at_creation, change_summary, content, content_hash FROM document_versions WHERE document_id = $1',
      [document.id],
    );
    expect(version).toMatchObject({
      id: created.id,
      version_number: 1,
      reason: 'MANUAL',
      status_at_creation: 'DRAFT',
      change_summary: 'Ajuste na justificativa',
      content_hash: created.contentHash,
    });
    // DEC-084: recalcular o hash do snapshot gravado reproduz o valor.
    expect(version?.content_hash).toBe(sha256Hex(canonicalJson(version?.content)));
    const [row] = await db.admin<{ status: string; version: number; current_version_id: string }>(
      'SELECT status, version, current_version_id FROM documents WHERE id = $1',
      [document.id],
    );
    expect(row).toEqual({ status: 'DRAFT', version: 2, current_version_id: created.id });

    const events = await db.admin<{ event_type: string; status: string; routing_key: string }>(
      "SELECT event_type, status, routing_key FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DocumentVersionCreated'",
      [document.id],
    );
    expect(events).toEqual([
      {
        event_type: 'DocumentVersionCreated',
        status: 'PENDING',
        routing_key: 'document.version_created.despacho',
      },
    ]);
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'document.version_create'",
        [A, document.id],
      ),
    ).toBe(1);

    // Listagem e comparação leem o que foi gravado.
    const second = await save(document.id);
    expect(second.status).toBe(201);
    const list = await call('get', `/documents/${document.id}/versions`);
    expect(list.status).toBe(200);
    const ids = (list.body as { data: { id: string; versionNumber: number }[] }).data;
    expect(ids.map((item) => item.versionNumber)).toEqual([2, 1]);
    const diff = await call(
      'get',
      `/documents/${document.id}/versions/compare?from=${ids[1]?.id}&to=${ids[0]?.id}`,
    );
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
  });

  it('[Concorrência] dois "Salvar versão" simultâneos na versão 3 viram 4 e 5 (FOR UPDATE), sem lacuna', async () => {
    const document = await newDocument();
    for (let index = 0; index < 3; index += 1) expect((await save(document.id)).status).toBe(201);
    const responses = await Promise.all([save(document.id), save(document.id), save(document.id)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const rows = await db.admin<{ version_number: number }>(
      'SELECT version_number FROM document_versions WHERE document_id = $1 ORDER BY version_number',
      [document.id],
    );
    expect(rows.map((row) => row.version_number)).toEqual([1, 2, 3, 4, 5, 6]);
    const [current] = await db.admin<{ version_number: number }>(
      'SELECT v.version_number FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = $1',
      [document.id],
    );
    expect(current?.version_number).toBe(6);
  });

  it('[Falha de banco] falha induzida no outbox não deixa versão, auditoria nem mudança no documento', async () => {
    const document = await newDocument();
    await db.admin(`
      CREATE FUNCTION test_fail_version_created() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'DocumentVersionCreated' AND NEW.aggregate_id = '${document.id}' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_version_created BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_version_created();
    `);
    try {
      expect((await save(document.id)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_version_created ON outbox_events; DROP FUNCTION test_fail_version_created();',
      );
    }
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [document.id]),
    ).toBe(0);
    const [row] = await db.admin<{ version: number; current_version_id: string | null }>(
      'SELECT version, current_version_id FROM documents WHERE id = $1',
      [document.id],
    );
    expect(row).toEqual({ version: 1, current_version_id: null });
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'document.version_create'",
        [A, document.id],
      ),
    ).toBe(0);
    // A próxima tentativa (sem a falha) cria a versão 1 — sem lacuna.
    const retry = await save(document.id);
    expect(retry.status).toBe(201);
    expect((retry.body as { data: { versionNumber: number } }).data.versionNumber).toBe(1);
  });

  it('[Tenant incorreto] DOC-15/16/17/18 com ids do tenant A chamados de B → 404; RLS esconde as versões', async () => {
    const document = await newDocument();
    const v1 = (await save(document.id)).body as { data: { id: string } };
    const v2 = (await save(document.id)).body as { data: { id: string } };
    const asBeto = { subject: 'sub-beto-us066', tenant: B };
    for (const response of [
      await call('get', `/documents/${document.id}/versions`, asBeto),
      await call('get', `/document-versions/${v1.data.id}`, asBeto),
      await call(
        'get',
        `/documents/${document.id}/versions/compare?from=${v1.data.id}&to=${v2.data.id}`,
        asBeto,
      ),
      await save(document.id, {}, asBeto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('ETP 0003/2026');
    }
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [document.id]),
    ).toBe(2);

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<
              Row[]
            >`SELECT id FROM document_versions WHERE document_id = ${document.id}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Imutabilidade] a versão MANUAL não muda nem é apagada (gatilho só-INSERT)', async () => {
    const document = await newDocument();
    expect((await save(document.id, { changeSummary: 'Original' })).status).toBe(201);
    await expect(
      db.admin(
        "UPDATE document_versions SET change_summary = 'Adulterado' WHERE document_id = $1",
        [document.id],
      ),
    ).rejects.toThrow(/imutável/);
    await expect(
      db.admin('DELETE FROM document_versions WHERE document_id = $1', [document.id]),
    ).rejects.toThrow(/imutável/);
    const [row] = await db.admin<{ change_summary: string }>(
      'SELECT change_summary FROM document_versions WHERE document_id = $1',
      [document.id],
    );
    expect(row?.change_summary).toBe('Original');
  });
});

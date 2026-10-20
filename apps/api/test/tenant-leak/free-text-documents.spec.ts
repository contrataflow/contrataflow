// Documento livre sobre PostgreSQL real (US-063 · Sucesso, Concorrência, Falha de banco, Falha de
// integração, Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders reais (inclusive
// a biblioteca de templates — o DESPACHO nasce com o modelo padrão publicado), o processo pelo
// PRC-02, o documento pelo DOC-02 e o autosave pelo DOC-05. Prova: a criação grava o documento com o
// rascunho do template, a sequência `(tipo, ano)`, a auditoria e o evento `PENDING` num commit;
// duas criações simultâneas recebem números consecutivos distintos; falha induzida no outbox não
// deixa documento, número, auditoria nem evento; o autosave avança a revisão da seção sem versão;
// o tipo de B é invisível em A (RLS → 422 REFERENCE_NOT_FOUND) e os ids de A chamados de B → 404.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, richTextFromPlainText } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { openStageForAnyType } from '../support/document-fixtures.js';
import { PROCESS_PREREQUISITE_SEEDERS, runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c063-0000-7000-8000-00000000010a';
const B = '0192c063-0000-7000-8000-00000000010b';
const ORG_A = '0192c063-0000-7000-8000-0000000010a0';
const ORG_B = '0192c063-0000-7000-8000-0000000010b0';
const OBRAS = '0192c063-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c063-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c063-0000-7000-8000-0000000010b1';
const LUCIA = '0192c063-0000-7000-8000-0000000010c2';
const BETO = '0192c063-0000-7000-8000-0000000010c3';
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us063', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us063', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us063', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us063', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c063-0000-7000-8000-0000000010d2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c063-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Documento livre a partir de template sobre PostgreSQL (US-063)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let openStages: Set<string>;
  let despacho: string;
  let despachoB: string;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (
    method: 'get' | 'post' | 'put',
    url: string,
    options: { subject?: string; tenant?: string; body?: object; ifMatch?: string } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us063', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method === 'post') pending = pending.set('Idempotency-Key', randomUUID());
    if (options.ifMatch !== undefined) pending = pending.set('If-Match', options.ifMatch);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  async function newProcess(): Promise<string> {
    const catalog = async (type: string, code: string) => {
      const [row] = await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [A, type, code],
      );
      return row?.id ?? '';
    };
    const response = await call('post', '/processes', {
      body: {
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalog('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: await catalog('PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    openStages.add(id);
    return id;
  }

  /** DOC-02 do DESPACHO. */
  const createDespacho = (processId: string, documentTypeId = despacho) =>
    call('post', `/processes/${processId}/documents`, {
      body: { documentTypeId, title: 'Encaminhamento à Secretaria de Obras' },
    });

  const count = async (sql: string, params: unknown[]) =>
    Number((await db.admin<{ count: string }>(sql, params))[0]?.count ?? 0);

  const sequenceValue = async () =>
    Number(
      (
        await db.admin<{ last_value: string }>(
          "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = 'DOCUMENT:DESPACHO:*:2026'",
          [A],
        )
      )[0]?.last_value ?? 0,
    );

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
    const seeders = [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary'];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    openStages = openStageForAnyType(api);
    const typeOf = async (tenantId: string) =>
      (
        await db.admin<{ id: string }>(
          "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DESPACHO'",
          [tenantId],
        )
      )[0]?.id ?? '';
    despacho = await typeOf(A);
    despachoB = await typeOf(B);
    expect(despacho).not.toBe('');
    expect(despachoB).not.toBe('');
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] DOC-02 grava o documento com o rascunho do template, o número, a auditoria e o evento PENDING; DOC-05 avança a seção sem versão', async () => {
    const processId = await newProcess();
    const response = await createDespacho(processId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const { id, code } = (response.body as { data: { id: string; code: string } }).data;

    const [row] = await db.admin<{
      status: string;
      code: string;
      template_version_id: string;
      draft_content: { sections: Record<string, { state: string; revision: number }> };
    }>('SELECT status, code, template_version_id, draft_content FROM documents WHERE id = $1', [
      id,
    ]);
    expect(row).toMatchObject({ status: 'DRAFT', code });
    expect(code).toMatch(/^DESP \d{4}\/2026$/);
    expect(row?.draft_content.sections.CONTENT).toMatchObject({ state: 'FILLED', revision: 1 });
    const [published] = await db.admin<{ status: string }>(
      'SELECT status FROM document_template_versions WHERE id = $1',
      [row?.template_version_id ?? ''],
    );
    expect(published?.status).toBe('PUBLISHED');
    expect(
      await db.admin<{ status: string; routing_key: string }>(
        "SELECT status, routing_key FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DocumentCreated'",
        [id],
      ),
    ).toEqual([{ status: 'PENDING', routing_key: 'document.created.despacho' }]);
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'document.create'",
        [A, id],
      ),
    ).toBe(1);

    const saved = await call('put', `/documents/${id}/sections/CONTENT`, {
      ifMatch: '"s1"',
      body: { content: richTextFromPlainText('Encaminhem-se os autos.'), notApplicable: false },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const [after] = await db.admin<{
      version: number;
      draft_content: { sections: Record<string, { revision: number }> };
    }>('SELECT version, draft_content FROM documents WHERE id = $1', [id]);
    expect(after?.version).toBe(1);
    expect(after?.draft_content.sections.CONTENT?.revision).toBe(2);
    expect(await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [id])).toBe(
      0,
    );
  });

  it('[Concorrência] duas criações simultâneas do mesmo tipo recebem números consecutivos distintos', async () => {
    const processId = await newProcess();
    const responses = await Promise.all([createDespacho(processId), createDespacho(processId)]);
    const numbers = responses.map((response) => {
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return (response.body as { data: { number: number } }).data.number;
    });
    expect(new Set(numbers).size).toBe(2);
    expect(Math.abs((numbers[0] ?? 0) - (numbers[1] ?? 0))).toBe(1);
  });

  it('[Falha de banco] falha induzida no outbox não deixa documento, número, auditoria nem evento', async () => {
    const processId = await newProcess();
    const before = await sequenceValue();
    await db.admin(`
      CREATE FUNCTION test_fail_free_text() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'DocumentCreated' AND NEW.process_id = '${processId}' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_free_text BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_free_text();
    `);
    try {
      expect((await createDespacho(processId)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_free_text ON outbox_events; DROP FUNCTION test_fail_free_text();',
      );
    }
    expect(await count('SELECT count(*) FROM documents WHERE process_id = $1', [processId])).toBe(
      0,
    );
    expect(await sequenceValue()).toBe(before);
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND process_id = $2 AND action = 'document.create'",
        [A, processId],
      ),
    ).toBe(0);
  });

  it('[Tenant incorreto] tipo de B é invisível em A (RLS → 422 REFERENCE_NOT_FOUND); ids de A chamados de B → 404', async () => {
    const processId = await newProcess();
    const crossed = await createDespacho(processId, despachoB);
    expect(crossed.status, JSON.stringify(crossed.body)).toBe(422);
    const problem = problemDetailsSchema.parse(crossed.body);
    expect(problem.code).toBe('VALIDATION_ERROR');
    expect(problem.errors[0]).toMatchObject({
      field: 'documentTypeId',
      code: 'REFERENCE_NOT_FOUND',
    });
    expect(await count('SELECT count(*) FROM documents WHERE process_id = $1', [processId])).toBe(
      0,
    );

    const own = await createDespacho(processId);
    const { id } = (own.body as { data: { id: string } }).data;
    const asBeto = { subject: 'sub-beto-us063', tenant: B };
    for (const response of [
      await call('post', `/processes/${processId}/documents`, {
        ...asBeto,
        body: { documentTypeId: despachoB, title: 'Encaminhamento à Secretaria de Obras' },
      }),
      await call('get', `/documents/${id}`, asBeto),
      await call('put', `/documents/${id}/sections/CONTENT`, {
        ...asBeto,
        ifMatch: '"s1"',
        body: { content: richTextFromPlainText('Intruso'), notApplicable: false },
      }),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Encaminhamento');
    }
    const [row] = await db.admin<{
      draft_content: { sections: Record<string, { revision: number }> };
    }>('SELECT draft_content FROM documents WHERE id = $1', [id]);
    expect(row?.draft_content.sections.CONTENT?.revision).toBe(1);
  });
});

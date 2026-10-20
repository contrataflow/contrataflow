// Sigilo do orçamento estimado sobre PostgreSQL real (US-013 · Sucesso, Tenant incorreto,
// Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os
// seeders reais do provisionamento, o processo criado pelo PRC-02 e o PRC-33. Prova a cascata para o
// documento de pesquisa de preços (RN-PROC-139) na mesma transação, o rollback total por falha
// induzida DEPOIS de gravar processo e documento (processo, documento, timeline, auditoria e
// outbox), duas alterações com o mesmo `If-Match` (uma 200, outra 412), o evento `PENDING` e a RLS
// (processo de outro tenant = 404 e a pesquisa de preços do outro tenant intocada).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
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
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c013-0000-7000-8000-00000000010a';
const B = '0192c013-0000-7000-8000-00000000010b';
const ORG_A = '0192c013-0000-7000-8000-0000000010a0';
const ORG_B = '0192c013-0000-7000-8000-0000000010b0';
const OBRAS = '0192c013-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c013-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c013-0000-7000-8000-0000000010b1';
const SETOR_X = '0192c013-0000-7000-8000-0000000010b2';
const ANA = '0192c013-0000-7000-8000-0000000010c1';
const LUCIA = '0192c013-0000-7000-8000-0000000010c2';
const BETO = '0192c013-0000-7000-8000-0000000010c3';
const ANA_M = '0192c013-0000-7000-8000-0000000010d1';
const BETO_M = '0192c013-0000-7000-8000-0000000010d3';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES', 'REQUISITANTE'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us013', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us013', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us013', 'ana@a.test', true, 'Ana Souza'),
  ('${LUCIA}', 'sub-lucia-us013', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us013', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c013-0000-7000-8000-0000000010d2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('${BETO_M}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c013-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c013-0000-7000-8000-0000000010e3', '${B}', '${BETO_M}', '${SETOR_X}', true);
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

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

describe('Feature: Sigilo do orçamento estimado sobre PostgreSQL (US-013)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const catalogs = new Map<string, { contractingType: string; origin: string; pp: string }>();

  const tenantOf = (subject: string) => (subject === 'sub-beto-us013' ? B : A);
  const create = async (subject = 'sub-ana-us013'): Promise<ProcessDto> => {
    const tenant = tenantOf(subject);
    const catalog = catalogs.get(tenant);
    if (!catalog) throw new Error('catálogo ausente');
    const units = tenant === A ? [OBRAS, MANUTENCAO] : [OBRAS_B, SETOR_X];
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenant)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: units[0],
        requestingDepartmentId: units[1],
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  };
  /** Pesquisa de preços FINALIZED (INTERNAL) no processo, gravada pelo superusuário. */
  const priceResearchOf = async (tenantId: string, processId: string, createdById: string) => {
    const id = randomUUID();
    await db.admin(
      `INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status, created_by_id)
       VALUES ($1, $2, $3, $4, 'Pesquisa de preços', 'FINALIZED', $5)`,
      [id, tenantId, processId, catalogs.get(tenantId)?.pp, createdById],
    );
    return id;
  };
  const put = (
    id: string,
    isBudgetConfidential: boolean,
    ifMatch: number,
    subject = 'sub-lucia-us013',
  ) =>
    request(api.server)
      .put(`/api/v1/processes/${id}/confidentiality`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('If-Match', `"${String(ifMatch)}"`)
      .send({ isBudgetConfidential });
  const lookup = async (tenantId: string, sql: string, params: unknown[]) => {
    const [row] = await db.admin<{ id: string }>(sql, [tenantId, ...params]);
    if (!row) throw new Error(`${String(params)} ausente`);
    return row.id;
  };
  /** Tudo que o PRC-33 grava (para provar o rollback). */
  const effects = async (processId: string, documentId: string) => ({
    process: (
      await db.admin<Row>(
        'SELECT is_budget_confidential, version, updated_by_id FROM processes WHERE id = $1',
        [processId],
      )
    )[0],
    document: (
      await db.admin<Row>('SELECT confidentiality::text, version FROM documents WHERE id = $1', [
        documentId,
      ])
    )[0],
    timeline: await db.admin<Row>(
      "SELECT params, visibility::text FROM process_timeline_entries WHERE process_id = $1 AND type = 'CONFIDENTIALITY_CHANGED'",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT changes, metadata FROM audit_logs WHERE entity_id = $1 AND action = 'process.confidentiality_change'",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT payload, status::text FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ProcessConfidentialityChanged'",
      [processId],
    ),
  });

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
      DATABASE_POOL_SIZE: '10',
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
    for (const tenant of [A, B]) {
      catalogs.set(tenant, {
        contractingType: await lookup(
          tenant,
          'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
          ['CONTRACTING_TYPE', 'AQUISICAO_BENS'],
        ),
        origin: await lookup(
          tenant,
          'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
          ['PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'],
        ),
        pp: await lookup(
          tenant,
          'SELECT id FROM document_types WHERE tenant_id = $1 AND code = $2',
          ['PRICE_RESEARCH'],
        ),
      });
    }
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] ativar e desativar: processo, pesquisa de preços, timeline STANDARD, auditoria e evento PENDING no mesmo commit', async () => {
    const created = await create();
    const documentId = await priceResearchOf(A, created.id, ANA);

    const response = await put(created.id, true, 1);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    const after = await effects(created.id, documentId);
    expect(after.process).toEqual({
      is_budget_confidential: true,
      version: 2,
      updated_by_id: LUCIA,
    });
    expect(after.document).toEqual({ confidentiality: 'RESTRICTED', version: 2 });
    expect(after.timeline).toEqual([
      { params: { isBudgetConfidential: true }, visibility: 'STANDARD' },
    ]);
    expect(after.audit).toEqual([
      {
        changes: [{ path: 'isBudgetConfidential', old: false, new: true }],
        metadata: expect.objectContaining({ version: 2, documentsChanged: 1 }) as unknown,
      },
    ]);
    // [Falha de integração] relay fora: o evento fica PENDING até o relay voltar.
    expect(after.events).toEqual([{ payload: { isBudgetConfidential: true }, status: 'PENDING' }]);

    const reverted = await put(created.id, false, 2);
    expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
    expect((await effects(created.id, documentId)).document).toEqual({
      confidentiality: 'INTERNAL',
      version: 3,
    });
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar processo e documento desfaz tudo', async () => {
    const created = await create();
    const documentId = await priceResearchOf(A, created.id, ANA);
    await db.admin(`
      CREATE FUNCTION test_fail_confidentiality() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'CONFIDENTIALITY_CHANGED' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_confidentiality BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_confidentiality();`);
    try {
      const before = await effects(created.id, documentId);
      const failed = await put(created.id, true, 1);
      expect(failed.status).toBe(500);
      expect(await effects(created.id, documentId)).toEqual(before);
      expect(before.process).toMatchObject({ is_budget_confidential: false, version: 1 });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_confidentiality ON process_timeline_entries; DROP FUNCTION test_fail_confidentiality();',
      );
    }
  });

  it('[Concorrência] duas alterações com o mesmo If-Match: uma 200, a outra 412 com currentVersion 2', async () => {
    const created = await create();
    const documentId = await priceResearchOf(A, created.id, ANA);
    const responses = await Promise.all([put(created.id, true, 1), put(created.id, true, 1)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const conflict = responses.find((response) => response.status === 412);
    expect(conflict?.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    const after = await effects(created.id, documentId);
    expect(after.process).toMatchObject({ is_budget_confidential: true, version: 2 });
    expect(after.document).toEqual({ confidentiality: 'RESTRICTED', version: 2 });
    expect(after.events).toHaveLength(1);
  });

  it('[Tenant incorreto] processo de A pelo tenant B: 404 PROCESS_NOT_FOUND; a cascata de A não toca B', async () => {
    const created = await create();
    const documentId = await priceResearchOf(A, created.id, ANA);
    const before = await effects(created.id, documentId);
    const response = await put(created.id, true, 1, 'sub-beto-us013');
    expect(response.status).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PROCESS_NOT_FOUND');
    expect(await effects(created.id, documentId)).toEqual(before);

    // B ativa o próprio processo: só a pesquisa de preços de B muda.
    const foreign = await create('sub-beto-us013');
    const foreignDocument = await priceResearchOf(B, foreign.id, BETO);
    expect((await put(foreign.id, true, 1, 'sub-beto-us013')).status).toBe(200);
    expect((await effects(foreign.id, foreignDocument)).document).toMatchObject({
      confidentiality: 'RESTRICTED',
    });
    expect((await effects(created.id, documentId)).document).toEqual(before.document);
  });
});

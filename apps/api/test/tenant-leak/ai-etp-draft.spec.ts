// Rascunho do ETP com IA sobre PostgreSQL real (US-118 · Sucesso, Tenant incorreto): a API inteira
// como `cf_app` (RLS), com os seeders reais, o processo pelo PRC-02 (Ana) com o DFD do DFD-02, o
// ETP pelo ETP-02 (Rui) nos estudos preliminares, o gerador REAL `draft.etp` (contexto pelas
// fachadas de leitura de `document`, `dfd`, `etp`, `price-research` e `process`, na transação do
// tenant), o portão de teste e o `FakeAiProvider` com a fixture `draft.etp/padrao`. Prova: o
// contexto enviado ao provedor não contém dados de outro tenant — a pesquisa de preços concluída da
// Prefeitura B é invisível (o ETP de A sai com `MISSING_PRICE_RESEARCH`); a aplicação (DOC-26) grava
// as seções do ETP com a geração `APPLIED` e `AiContentApplied` PENDING sem tocar `etps`; o ETP e a
// geração de A são invisíveis ao tenant B (404 sem revelar nada).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { EtpDto, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiTenantGateRegistry } from '#modules/ai/application/ai-extension-points.js';
import { AI_PROVIDER } from '#modules/ai/application/ai-provider.port.js';
import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from '#modules/ai/infrastructure/fake-ai.provider.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { InMemoryJobQueue } from '#modules/platform/infrastructure/queues/in-memory-job-queue.js';
import { InMemoryAiCircuitStore } from '#modules/platform/infrastructure/redis/in-memory-ai-circuit.store.js';
import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { DFD_CLOCK } from '../../src/modules/dfd/application/ports.js';
import { ETP_CLOCK } from '../../src/modules/etp/application/ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import { TestAiGate, runAiJob } from '../support/ai-fixtures.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c118-0000-7000-8000-00000000010a';
const B = '0192c118-0000-7000-8000-00000000010b';
const ORG_A = '0192c118-0000-7000-8000-0000000010a0';
const ORG_B = '0192c118-0000-7000-8000-0000000010b0';
const OBRAS = '0192c118-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c118-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c118-0000-7000-8000-0000000010b1';
const ANA = '0192c118-0000-7000-8000-0000000010c1';
const RUI = '0192c118-0000-7000-8000-0000000010c2';
const BETO = '0192c118-0000-7000-8000-0000000010c3';
const ANA_M = '0192c118-0000-7000-8000-0000000010d1';
const PROCESS_B = '0192c118-0000-7000-8000-0000000010f1';
const RESEARCH_B = '0192c118-0000-7000-8000-0000000010f2';
const NOW = new Date('2026-10-19T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['PLANEJAMENTO'],
  [BETO]: ['PLANEJAMENTO'],
};

const SUBJECTS = { ana: 'sub-ana-us118', rui: 'sub-rui-us118', beto: 'sub-beto-us118' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us118', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us118', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Educação', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Tecnologia', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Educação LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana-us118@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui-us118@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto-us118@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c118-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c118-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c118-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

/** Pesquisa de preços FINALIZED da Prefeitura B (SQL com as FKs desligadas — só o id importa). */
const TENANT_B_RESEARCH_SQL = (documentTypeId: string) => `
SET session_replication_role = replica;
INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
  requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
  origin_id, pca_status, created_by_id)
VALUES ('${PROCESS_B}', '${B}', '${ORG_B}', 2026, 'Processo LEAK-B', 'Objeto do processo LEAK-B',
  '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}', '${OBRAS_B}',
  'NOT_APPLICABLE', '${BETO}');
INSERT INTO documents (id, tenant_id, process_id, document_type_id, code, title, status, created_by_id)
VALUES ('${RESEARCH_B}', '${B}', '${PROCESS_B}', '${documentTypeId}', 'PP 0009/2026',
  'Pesquisa LEAK-B', 'FINALIZED', '${BETO}');
INSERT INTO price_research (id, tenant_id, process_id, document_id, reference_date, default_method,
  cv_threshold_percent, min_quotations, direct_quote_max_age_days, similar_contract_max_age_days,
  outlier_lower_percent, outlier_upper_percent, unit_price_decimals, rounding_mode,
  total_estimated_value)
VALUES ('${RESEARCH_B}', '${B}', '${PROCESS_B}', '${RESEARCH_B}', '2026-10-01', 'AUTO_CV', 25, 3,
  180, 365, 70, 130, 2, 'HALF_UP', 777777.77);
SET session_replication_role = origin;
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

const words = () => randomUUID().replaceAll('-', '').slice(0, 10);

describe('Feature: Rascunho do ETP com IA sobre PostgreSQL (US-118)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const provider = new FakeAiProvider(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR));
  const queue = new InMemoryJobQueue();

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  const catalogId = async (tenant: string, type: string, code: string) =>
    (
      await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [tenant, type, code],
      )
    )[0]?.id ?? '';

  const versionOf = async (documentId: string): Promise<number> =>
    (
      await db.admin<{ version: number }>('SELECT version FROM documents WHERE id = $1', [
        documentId,
      ])
    )[0]?.version ?? 0;

  /** Processo (PRC-02, Ana) com um item e o DFD (DFD-02); o ETP (ETP-02, Rui) nos estudos preliminares. */
  async function background(): Promise<{ processId: string; etpId: string }> {
    const created = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const processId = (created.body as { data: ProcessDto }).data.id;
    const item = await call(
      request(api.server).post(`/api/v1/processes/${processId}/items`),
      SUBJECTS.ana,
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        kind: 'GOOD',
        description: 'Computador desktop',
        unitOfMeasureId: await catalogId(A, 'UNIT_OF_MEASURE', 'UN'),
      });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    const dfd = await call(
      request(api.server).post(`/api/v1/processes/${processId}/dfds`),
      SUBJECTS.ana,
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(dfd.status, JSON.stringify(dfd.body)).toBe(201);
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'ESTUDOS_PRELIMINARES'`,
      [processId, RUI],
    );
    const etp = await call(request(api.server).post(`/api/v1/processes/${processId}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etp.status, JSON.stringify(etp.body)).toBe(201);
    const etpDto = (etp.body as { data: EtpDto }).data;
    const items = await call(
      request(api.server).put(`/api/v1/documents/${etpDto.documentId}/items`),
    )
      .set('If-Match', `"${String(etpDto.documentVersion)}"`)
      .send({
        items: [
          { processItemId: (item.body as { data: ProcessItemDto }).data.id, quantity: '120' },
        ],
      });
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    return { processId, etpId: etpDto.documentId };
  }

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
        { token: DFD_CLOCK, value: () => NOW },
        { token: ETP_CLOCK, value: () => NOW },
        { token: AI_PROVIDER, value: provider },
        { token: JOB_QUEUE, value: queue },
        { token: AI_CIRCUIT_STORE, value: new InMemoryAiCircuitStore() },
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
    const seeders = [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    const [researchType] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'PRICE_RESEARCH'",
      [B],
    );
    await db.admin(TENANT_B_RESEARCH_SQL(researchType?.id ?? ''));
    // Gerador REAL (`draft.etp`); só o portão do órgão é de teste (US-116 tem a suíte própria).
    api.app.get(AiTenantGateRegistry).register(new TestAiGate());
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] o contexto da geração não contém dados do tenant B; DOC-26 grava o ETP sem tocar `etps`', async () => {
    const target = await background();
    const response = await call(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({ targetModule: 'ETP', kind: 'DRAFT', documentId: target.etpId });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const id = (response.body as { data: { id: string } }).data.id;
    await runAiJob(api, id);

    const [generation] = await db.admin<Row>(
      `SELECT status, prompt_key, output -> 'warnings' AS warnings,
              input_refs::text AS refs
         FROM ai_generations WHERE id = $1`,
      [id],
    );
    expect(generation).toMatchObject({ status: 'SUCCEEDED', prompt_key: 'draft.etp' });
    // A pesquisa concluída da Prefeitura B é invisível (RLS): o ETP de A não tem pesquisa.
    expect(generation?.warnings).toEqual(
      expect.arrayContaining([
        { code: 'MISSING_PRICE_RESEARCH' },
        { code: 'USED_DRAFT_INPUTS', params: { input: 'DFD' } },
      ]),
    );
    expect(String(generation?.refs)).not.toContain(RESEARCH_B);
    const sent = JSON.stringify(provider.calls.at(-1));
    expect(sent).not.toContain('LEAK-B');
    expect(sent).not.toContain('777');
    expect(sent).toContain('Computador desktop');

    const [etpBefore] = await db.admin<Row>(
      'SELECT conclusion, parceling_decision, recommended_alternative_id, version FROM etps WHERE id = $1',
      [target.etpId],
    );
    const applied = await call(
      request(api.server).post(`/api/v1/documents/${target.etpId}/ai-apply`),
    )
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(await versionOf(target.etpId))}"`)
      .send({ generationId: id, sectionKeys: ['NEED_DESCRIPTION', 'CONCLUSION'] });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const [document] = await db.admin<Row>(
      `SELECT draft_content -> 'sections' -> 'CONCLUSION' ->> 'state' AS state,
              draft_content -> 'sections' -> 'CONCLUSION' -> 'ai' ->> 'generationId' AS generation
         FROM documents WHERE id = $1`,
      [target.etpId],
    );
    expect(document).toEqual({ state: 'FILLED', generation: id });
    const [etpAfter] = await db.admin<Row>(
      'SELECT conclusion, parceling_decision, recommended_alternative_id, version FROM etps WHERE id = $1',
      [target.etpId],
    );
    expect(etpAfter).toEqual(etpBefore);
    expect(etpAfter).toMatchObject({ conclusion: 'PENDING', parceling_decision: null });
    const events = await db.admin<{ status: string; routing_key: string }>(
      "SELECT status, routing_key FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AiContentApplied'",
      [target.etpId],
    );
    expect(events).toEqual([{ status: 'PENDING', routing_key: 'document.ai_content_applied.etp' }]);
  });

  it('[Tenant incorreto] ETP e geração de A são invisíveis ao tenant B: 404 sem revelar nada (RLS)', async () => {
    const target = await background();
    const response = await call(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({ targetModule: 'ETP', kind: 'DRAFT', documentId: target.etpId });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const id = (response.body as { data: { id: string } }).data.id;

    const get = await call(request(api.server).get(`/api/v1/ai-generations/${id}`), SUBJECTS.beto);
    expect(get.status).toBe(404);
    expect(problemDetailsSchema.parse(get.body).code).toBe('AI_GENERATION_NOT_FOUND');

    const crossed = await call(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
      SUBJECTS.beto,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ targetModule: 'ETP', kind: 'DRAFT', documentId: target.etpId });
    expect(crossed.status).toBe(404);
    expect(JSON.stringify(crossed.body)).not.toContain(target.etpId);

    const applyForeign = await call(
      request(api.server).post(`/api/v1/documents/${target.etpId}/ai-apply`),
      SUBJECTS.beto,
    )
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"1"')
      .send({ generationId: id, sectionKeys: ['NEED_DESCRIPTION'] });
    expect(applyForeign.status).toBe(404);
    const [untouched] = await db.admin<Row>('SELECT status FROM ai_generations WHERE id = $1', [
      id,
    ]);
    expect(untouched).toMatchObject({ status: 'QUEUED' });
  });
});

// Proposta do mapa de riscos com IA sobre PostgreSQL real (US-119 · Sucesso, Concorrência, Falha de
// banco, Tenant incorreto): a API inteira como `cf_app` (RLS), com os seeders reais, o DFD do
// DFD-02, o gerador REAL `draft.risk_map` (contexto pelas fachadas de leitura, na transação do
// tenant), o portão de teste e o `FakeAiProvider` com a fixture `draft.risk_map/padrao`. Prova: o
// RSK-11 grava riscos, tratamentos, geração `APPLIED`, auditoria, outbox e timeline no MESMO
// commit; uma falha induzida depois de gravar os riscos desfaz tudo; duas aplicações simultâneas
// resultam em uma 201 e uma 409, com códigos sem repetição; a proposta e os riscos de outro tenant
// são invisíveis (404 e contexto sem nada da Prefeitura B).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
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
import { RiskChangeRecorder } from '#modules/risk/application/risk.support.js';
import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { DFD_CLOCK } from '../../src/modules/dfd/application/ports.js';
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
import { PROCESS_PREREQUISITE_SEEDERS, runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c119-0000-7000-8000-00000000010a';
const B = '0192c119-0000-7000-8000-00000000010b';
const ORG_A = '0192c119-0000-7000-8000-0000000010a0';
const ORG_B = '0192c119-0000-7000-8000-0000000010b0';
const OBRAS = '0192c119-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c119-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c119-0000-7000-8000-0000000010b1';
const ANA = '0192c119-0000-7000-8000-0000000010c1';
const BETO = '0192c119-0000-7000-8000-0000000010c3';
const ANA_M = '0192c119-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-18T16:00:00.000Z');
const MFA = ['pwd', 'otp'];
const FOREIGN_RISK = 'RISCO-LEAK-B da Prefeitura B';
/** `rationale` da fixture: só existe na proposta (nunca em auditoria, outbox ou timeline). */
const RATIONALE = 'O DFD descreve a necessidade de forma geral.';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE', 'GESTOR_CONTRATACOES'],
  [BETO]: ['REQUISITANTE', 'GESTOR_CONTRATACOES'],
};

const SUBJECTS = { ana: 'sub-ana-us119', beto: 'sub-beto-us119' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us119', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us119', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Educação', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Tecnologia', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Educação LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'carla@a.test', true, 'Carla Mendes'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c119-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c119-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

const FOUR_WITH_SEVEN = [
  { proposalKey: 'R1', treatments: ['R1.T1', 'R1.T2'] },
  { proposalKey: 'R2', treatments: ['R2.T1', 'R2.T2'] },
  { proposalKey: 'R3', treatments: ['R3.T1', 'R3.T2'] },
  { proposalKey: 'R4', treatments: ['R4.T1'] },
];

describe('Feature: Proposta do mapa de riscos com IA sobre PostgreSQL (US-119)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const provider = new FakeAiProvider(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR));
  const queue = new InMemoryJobQueue();

  const subjectOf = (tenant: string) => (tenant === A ? SUBJECTS.ana : SUBJECTS.beto);
  const call = (test: request.Test, tenant: string = A) =>
    test
      .set('Authorization', api.bearer(subjectOf(tenant), { amr: MFA }))
      .set('X-Tenant-Id', tenant);

  const catalogId = async (tenant: string, type: string, code: string) =>
    (
      await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [tenant, type, code],
      )
    )[0]?.id ?? '';

  /** Processo (PRC-02) + DFD (DFD-02), depois na etapa do mapa de riscos, em andamento. */
  async function newProcess(tenant = A): Promise<string> {
    const created = await call(request(api.server).post('/api/v1/processes'), tenant)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalogId(tenant, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: tenant === A ? OBRAS : OBRAS_B,
        requestingDepartmentId: tenant === A ? MANUTENCAO : OBRAS_B,
        originId: await catalogId(tenant, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const processId = (created.body as { data: ProcessDto }).data.id;
    const dfd = await call(request(api.server).post(`/api/v1/processes/${processId}/dfds`), tenant)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(dfd.status, JSON.stringify(dfd.body)).toBe(201);
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'ESTUDOS_PRELIMINARES'`,
      [processId],
    );
    return processId;
  }

  /** Proposta `SUCCEEDED` do solicitante (AI-01 + job). */
  async function proposal(processId: string, tenant = A): Promise<string> {
    const response = await call(
      request(api.server).post(`/api/v1/processes/${processId}/ai-generations`),
      tenant,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ targetModule: 'RISK_MAP', kind: 'DRAFT' });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const id = (response.body as { data: { id: string } }).data.id;
    await runAiJob(api, id);
    const [row] = await db.admin<Row>(
      'SELECT status, error_code FROM ai_generations WHERE id = $1',
      [id],
    );
    expect(row).toMatchObject({ status: 'SUCCEEDED' });
    return id;
  }

  const apply = (processId: string, body: object, tenant = A) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/risks/ai-apply`), tenant)
      .set('Idempotency-Key', randomUUID())
      .send(body);

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
    const seeders = [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary'];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    // Gerador REAL (`draft.risk_map`); só o portão do órgão é de teste (US-116 tem a suíte própria).
    api.app.get(AiTenantGateRegistry).register(new TestAiGate());
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] RSK-11 grava riscos, tratamentos, APPLIED, auditoria, outbox e timeline no mesmo commit; RSK-12 revisa', async () => {
    const processId = await newProcess();
    const id = await proposal(processId);
    const response = await apply(processId, { generationId: id, risks: FOUR_WITH_SEVEN });
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const risks = await db.admin<Row>(
      `SELECT id, code, level, status, ai_generation_id, ai_reviewed_at, owner_id, version
         FROM risks WHERE process_id = $1 ORDER BY code`,
      [processId],
    );
    expect(risks.map((row) => [row.code, row.level, row.status])).toEqual([
      ['R01', 'HIGH', 'IN_TREATMENT'],
      ['R02', 'MEDIUM', 'IN_TREATMENT'],
      ['R03', 'MEDIUM', 'IN_TREATMENT'],
      ['R04', 'MEDIUM', 'IN_TREATMENT'],
    ]);
    expect(risks.every((row) => row.ai_generation_id === id && row.ai_reviewed_at === null)).toBe(
      true,
    );
    const [treatments] = await db.admin<Row>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ai_generation_id = $2 AND status = 'PLANNED'
                                 AND responsible_id IS NULL AND due_date IS NULL)::int AS planned
         FROM risk_treatments WHERE process_id = $1`,
      [processId, id],
    );
    expect(treatments).toEqual({ total: 7, planned: 7 });
    const [generation] = await db.admin<Row>(
      `SELECT status, jsonb_array_length(applied_targets -> 'riskIds') AS applied
         FROM ai_generations WHERE id = $1`,
      [id],
    );
    expect(generation).toEqual({ status: 'APPLIED', applied: 4 });
    const [counts] = await db.admin<Row>(
      `SELECT (SELECT count(*)::int FROM audit_logs WHERE process_id = $1 AND action = 'risk.create') AS creates,
              (SELECT count(*)::int FROM audit_logs WHERE process_id = $1 AND action = 'risk.treatment_create') AS treatments,
              (SELECT count(*)::int FROM audit_logs WHERE process_id = $1 AND action = 'ai.content_apply') AS applies,
              (SELECT count(*)::int FROM outbox_events WHERE process_id = $1 AND event_type = 'RiskCreated') AS created_events,
              (SELECT count(*)::int FROM process_timeline_entries WHERE process_id = $1 AND type = 'AI_CONTENT_APPLIED') AS timeline`,
      [processId],
    );
    expect(counts).toEqual({
      creates: 4,
      treatments: 7,
      applies: 1,
      created_events: 4,
      timeline: 1,
    });
    const applied = await db.admin<{ status: string; routing_key: string }>(
      "SELECT status, routing_key FROM outbox_events WHERE process_id = $1 AND event_type = 'AiContentApplied'",
      [processId],
    );
    expect(applied).toEqual([
      { status: 'PENDING', routing_key: 'document.ai_content_applied.risk_map' },
    ]);

    const first = risks[0];
    const reviewed = await call(
      request(api.server).post(`/api/v1/processes/${processId}/risks/ai-review`),
    ).send({ riskIds: [first?.id], expectedVersions: { [String(first?.id)]: first?.version } });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const [after] = await db.admin<Row>(
      'SELECT ai_reviewed_by_id, version FROM risks WHERE id = $1',
      [first?.id],
    );
    expect(after).toEqual({ ai_reviewed_by_id: ANA, version: Number(first?.version) + 1 });

    const leaks = await db.admin<{ source: string }>(
      `SELECT 'audit' AS source FROM audit_logs WHERE (metadata::text || coalesce(changes::text, '')) LIKE ANY ($1)
       UNION ALL SELECT 'outbox' FROM outbox_events WHERE (payload::text || metadata::text) LIKE ANY ($1)
       UNION ALL SELECT 'timeline' FROM process_timeline_entries WHERE params::text LIKE ANY ($1)`,
      [[`%${RATIONALE}%`, '%Levantamento de requisitos feito sem%']],
    );
    expect(leaks).toEqual([]);
  });

  it('[Falha de banco] falha depois de gravar os riscos desfaz tudo: riscos, tratamentos, geração, auditoria e outbox', async () => {
    const processId = await newProcess();
    const id = await proposal(processId);
    const spy = vi
      .spyOn(RiskChangeRecorder.prototype, 'treatmentCreated')
      .mockRejectedValueOnce(new DatabaseUnavailableError(new Error('ECONNRESET')));
    try {
      const response = await apply(processId, { generationId: id, risks: FOUR_WITH_SEVEN });
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
    const [counts] = await db.admin<Row>(
      `SELECT (SELECT count(*)::int FROM risks WHERE process_id = $1) AS risks,
              (SELECT count(*)::int FROM risk_treatments WHERE process_id = $1) AS treatments,
              (SELECT count(*)::int FROM audit_logs WHERE process_id = $1 AND action IN ('risk.create', 'ai.content_apply')) AS audits,
              (SELECT count(*)::int FROM outbox_events WHERE process_id = $1 AND event_type IN ('RiskCreated', 'AiContentApplied')) AS events`,
      [processId],
    );
    expect(counts).toEqual({ risks: 0, treatments: 0, audits: 0, events: 0 });
    const [generation] = await db.admin<Row>('SELECT status FROM ai_generations WHERE id = $1', [
      id,
    ]);
    expect(generation).toMatchObject({ status: 'SUCCEEDED' });
    // A mesma proposta continua aplicável depois da falha.
    const retry = await apply(processId, { generationId: id, risks: FOUR_WITH_SEVEN });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  });

  it('[Concorrência] duas aplicações simultâneas: uma 201 e outra 409 AI_GENERATION_NOT_APPLICABLE; códigos sem repetição', async () => {
    const processId = await newProcess();
    const id = await proposal(processId);
    const body = { generationId: id, risks: FOUR_WITH_SEVEN };
    const responses = await Promise.all([apply(processId, body), apply(processId, body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(problemDetailsSchema.parse(conflict?.body).code).toBe('AI_GENERATION_NOT_APPLICABLE');
    const codes = await db.admin<{ code: string }>(
      'SELECT code FROM risks WHERE process_id = $1 ORDER BY code',
      [processId],
    );
    expect(codes.map((row) => row.code)).toEqual(['R01', 'R02', 'R03', 'R04']);
  });

  it('[Tenant incorreto] proposta de outro tenant: 404 AI_GENERATION_NOT_FOUND; o contexto não leva riscos nem textos de B (RLS)', async () => {
    const foreignProcess = await newProcess(B);
    const risk = await call(
      request(api.server).post(`/api/v1/processes/${foreignProcess}/risks`),
      B,
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        title: FOREIGN_RISK,
        categoryId: await catalogId(B, 'RISK_CATEGORY', 'PRAZO'),
        phase: 'PLANNING',
        cause: 'Causa LEAK-B do outro tenant',
        consequence: 'Consequência LEAK-B do outro tenant',
        probability: 2,
        impact: 2,
      });
    expect(risk.status, JSON.stringify(risk.body)).toBe(201);
    const foreign = await proposal(foreignProcess, B);

    const own = await newProcess();
    const crossed = await apply(own, {
      generationId: foreign,
      risks: [{ proposalKey: 'R1', treatments: [] }],
    });
    expect(crossed.status).toBe(404);
    expect(problemDetailsSchema.parse(crossed.body).code).toBe('AI_GENERATION_NOT_FOUND');
    expect(JSON.stringify(crossed.body)).not.toContain(foreignProcess);

    provider.reset();
    await proposal(own);
    const sent = JSON.stringify(provider.calls);
    expect(sent).not.toContain('LEAK-B');
    const [untouched] = await db.admin<Row>('SELECT status FROM ai_generations WHERE id = $1', [
      foreign,
    ]);
    expect(untouched).toMatchObject({ status: 'SUCCEEDED' });
  });
});

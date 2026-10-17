// IA no órgão sobre PostgreSQL real (US-116 · Tenant incorreto, Duplicidade, Concorrência): a API
// inteira como `cf_app` (RLS) com os seeders reais, o processo do PRC-02, o DFD da fábrica única, o
// gerador de teste, o portão REAL do órgão e o `FakeAiProvider`. Prova: AI-06 soma só as gerações
// do próprio tenant (RLS nas somas); AI-05 com processo de outro tenant → 404; o
// `pg_advisory_xact_lock` por tenant serializa a verificação + inserção do AI-01 (exatamente um
// pedido leva os últimos tokens); e o aviso de 80% é gravado UMA vez no outbox (`eventId`
// determinístico + `ON CONFLICT DO NOTHING`), no tenant da geração.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { aiUsageSchema, problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiGeneratorRegistry } from '#modules/ai/application/ai-generator.js';
import { AI_PROVIDER } from '#modules/ai/application/ai-provider.port.js';
import { AiTenantGateService } from '#modules/ai/application/ai-tenant-gate.service.js';
import { AI_GENERATION_REPOSITORY, AI_TRANSACTIONS } from '#modules/ai/application/ports.js';
import type { AiGenerationRepository, AiTransactions } from '#modules/ai/application/ports.js';
import { FakeAiProvider } from '#modules/ai/infrastructure/fake-ai.provider.js';
import { DOCUMENT_TRANSACTIONS } from '#modules/document/application/ports.js';
import type { DocumentTransactions } from '#modules/document/application/ports.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { InMemoryJobQueue } from '#modules/platform/infrastructure/queues/in-memory-job-queue.js';
import { InMemoryAiCircuitStore } from '#modules/platform/infrastructure/redis/in-memory-ai-circuit.store.js';
import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import { TestAiGenerator, runAiJob, validOutput } from '../support/ai-fixtures.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { documentFacadeOf } from '../support/document-fixtures.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c116-0000-7000-8000-00000000010a';
const B = '0192c116-0000-7000-8000-00000000010b';
const ORG_A = '0192c116-0000-7000-8000-0000000010a0';
const ORG_B = '0192c116-0000-7000-8000-0000000010b0';
const OBRAS = '0192c116-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c116-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c116-0000-7000-8000-0000000010b1';
const LUCIA = '0192c116-0000-7000-8000-0000000010c2';
const MARTA = '0192c116-0000-7000-8000-0000000010c4';
const BETO = '0192c116-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c116-0000-7000-8000-0000000010d2';
const MARTA_M = '0192c116-0000-7000-8000-0000000010d4';
const BETO_M = '0192c116-0000-7000-8000-0000000010d3';
const MFA = ['pwd', 'otp'];
const SUMMARY = 'Aquisição de 30 computadores para os laboratórios das escolas municipais.';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [MARTA]: ['ADMIN_ORGAO'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS: Readonly<Record<string, { userId: string; membershipId: string; tenant: string }>> =
  {
    'sub-lucia-us116': { userId: LUCIA, membershipId: LUCIA_M, tenant: A },
    'sub-marta-us116': { userId: MARTA, membershipId: MARTA_M, tenant: A },
    'sub-beto-us116': { userId: BETO, membershipId: BETO_M, tenant: B },
  };

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us116', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us116', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us116', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${MARTA}', 'sub-marta-us116', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${BETO}', 'sub-beto-us116', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('${MARTA_M}', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('${BETO_M}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(problemDetailsSchema.parse(response.body).code).toBe(code);
}

describe('Feature: IA no órgão sobre PostgreSQL (US-116)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const provider = new FakeAiProvider();
  const queue = new InMemoryJobQueue();
  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (
    method: 'get' | 'post',
    url: string,
    options: { subject?: string; body?: object } = {},
  ) => {
    const subject = options.subject ?? 'sub-lucia-us116';
    const agent = request(api.server);
    const pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', SUBJECTS[subject]?.tenant ?? A)
      .set('Idempotency-Key', randomUUID());
    return options.body === undefined ? pending : pending.send(options.body);
  };

  /** Contexto de tenant fora do pipeline HTTP (o que o guard faria). */
  const inTenant = <T>(subject: string, work: () => Promise<T>) => {
    const actor = SUBJECTS[subject];
    if (!actor) throw new Error(subject);
    return runWithRequestContext(
      { correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' },
      () => {
        updateRequestContext({
          tenantId: actor.tenant,
          actor: { type: 'USER', userId: actor.userId, membershipId: actor.membershipId },
          amr: MFA,
        });
        return work();
      },
    );
  };

  async function setAi(tenant: string, values: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await db.admin(
        `INSERT INTO tenant_settings (id, tenant_id, key, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, version = tenant_settings.version + 1`,
        [tenant, key, JSON.stringify(value)],
      );
    }
  }

  async function newDfd(subject = 'sub-lucia-us116') {
    const tenant = SUBJECTS[subject]?.tenant ?? A;
    const catalog = async (type: string, code: string) =>
      (
        await db.admin<{ id: string }>(
          'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
          [tenant, type, code],
        )
      )[0]?.id ?? '';
    const created = await call('post', '/processes', {
      subject,
      body: {
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalog('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: tenant === A ? OBRAS : OBRAS_B,
        requestingDepartmentId: tenant === A ? MANUTENCAO : OBRAS_B,
        originId: await catalog('PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const processId = (created.body as { data: { id: string } }).data.id;
    const [type] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DFD'",
      [tenant],
    );
    const transactions = api.app.get<DocumentTransactions>(DOCUMENT_TRANSACTIONS);
    const document = await inTenant(subject, () =>
      transactions.run((tx) =>
        documentFacadeOf(api).createIn(tx, {
          processId,
          documentTypeId: type?.id ?? '',
          title: 'DFD dos laboratórios',
          templateVersionId: null,
        }),
      ),
    );
    return { processId, documentId: document.id };
  }

  const requestDraft = (
    target: { processId: string; documentId: string },
    subject = 'sub-lucia-us116',
  ) =>
    call('post', `/processes/${target.processId}/ai-generations`, {
      subject,
      body: {
        targetModule: 'DFD',
        kind: 'DRAFT',
        documentId: target.documentId,
        needSummary: SUMMARY,
      },
    });

  /** Gera e conclui uma geração com `tokens` de consumo real. */
  async function consume(tokens: number, subject = 'sub-lucia-us116'): Promise<string> {
    const response = await requestDraft(await newDfd(subject), subject);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const id = (response.body as { data: { id: string } }).data.id;
    provider.enqueue({
      kind: 'output',
      output: validOutput(),
      usage: { inputTokens: tokens, outputTokens: 0 },
    });
    await runAiJob(api, id);
    return id;
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
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    // Portão REAL do órgão (registrado pelo módulo); só o gerador é de teste.
    api.app.get(AiGeneratorRegistry).register(new TestAiGenerator());
    await setAi(A, { 'ai.enabled': true, 'ai.termsAcceptedVersion': '2026-10' });
    await setAi(B, {
      'ai.enabled': true,
      'ai.termsAcceptedVersion': '2026-10',
      'ai.monthlyTokenLimit': 10_000_000,
    });
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] AI-06 soma só o próprio tenant; AI-05 com processo de outro tenant → 404', async () => {
    await setAi(A, { 'ai.monthlyTokenLimit': 10_000_000 });
    for (let index = 0; index < 3; index += 1) await consume(7_000, 'sub-beto-us116');
    await consume(5_000);

    const response = await call('get', '/ai/usage', { subject: 'sub-marta-us116' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const report = aiUsageSchema.parse((response.body as { data: unknown }).data);
    expect(report.generations.total).toBe(1);
    expect(report.usedTokens).toBe(5_000);
    expect(report.byUser).toEqual([
      { userId: LUCIA, name: 'Lúcia Matos', generations: 1, totalTokens: 5_000 },
    ]);
    expect(JSON.stringify(report)).not.toContain('LEAK-B');

    const ofB = await newDfd('sub-beto-us116');
    expectProblem(
      await call('get', `/ai/availability?processId=${ofB.processId}`),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await call('get', `/ai/availability?processId=${ofB.processId}&documentId=${ofB.documentId}`),
      404,
      'NOT_FOUND',
    );
  });

  it('[Concorrência] dois pedidos simultâneos pelos últimos tokens: exatamente um 202 e um 422', async () => {
    const used = Number(
      (
        await db.admin<{ used: string }>(
          `SELECT COALESCE(SUM(total_tokens), 0) AS used FROM ai_generations
            WHERE tenant_id = $1 AND status NOT IN ('QUEUED', 'RUNNING')`,
          [A],
        )
      )[0]?.used ?? 0,
    );
    // Restam 20 mil: cabe um DFD (15 mil), não dois.
    await setAi(A, { 'ai.monthlyTokenLimit': used + 20_000 });
    const [first, second] = [await newDfd(), await newDfd()];
    const responses = await Promise.all([requestDraft(first), requestDraft(second)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 422]);
    expect(
      (responses.find((response) => response.status === 422)?.body as { code: string }).code,
    ).toBe('AI_USAGE_LIMIT_REACHED');
    const [active] = await db.admin<{ count: string }>(
      "SELECT count(*) AS count FROM ai_generations WHERE tenant_id = $1 AND status = 'QUEUED'",
      [A],
    );
    expect(Number(active?.count)).toBe(1);
  });

  it('[Duplicidade] o aviso de 80% é gravado uma vez no outbox do tenant (ON CONFLICT DO NOTHING)', async () => {
    // Concluir a geração pendente do teste anterior e fixar o limite para cruzar 80% agora.
    const pending = await db.admin<{ id: string }>(
      "SELECT id FROM ai_generations WHERE tenant_id = $1 AND status = 'QUEUED'",
      [A],
    );
    for (const { id } of pending) {
      provider.enqueue({
        kind: 'output',
        output: validOutput(),
        usage: { inputTokens: 1, outputTokens: 0 },
      });
      await runAiJob(api, id);
    }
    const used = Number(
      (
        await db.admin<{ used: string }>(
          'SELECT COALESCE(SUM(total_tokens), 0) AS used FROM ai_generations WHERE tenant_id = $1',
          [A],
        )
      )[0]?.used ?? 0,
    );
    await setAi(A, { 'ai.monthlyTokenLimit': Math.max(used + 20_000, 50_000) });
    const limit = Math.max(used + 20_000, 50_000);
    const crossing = Math.ceil(limit * 0.8) - used + 1;
    const id = await consume(crossing);

    const events = () =>
      db.admin<{ id: string; tenant_id: string; payload: { threshold: number } }>(
        "SELECT id, tenant_id, payload FROM outbox_events WHERE event_type = 'AiUsageThresholdReached'",
      );
    const first = await events();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ tenant_id: A, payload: { threshold: 80 } });

    // Término reprocessado (mesma geração): o id determinístico não grava de novo.
    const transactions = api.app.get<AiTransactions>(AI_TRANSACTIONS);
    const repository = api.app.get<AiGenerationRepository>(AI_GENERATION_REPOSITORY);
    const gate = api.app.get(AiTenantGateService);
    await inTenant('sub-lucia-us116', () =>
      transactions.run(async (tx) => {
        const generation = await repository.findById(tx, id);
        if (generation === null) throw new Error('geração ausente');
        await gate.settle(tx, generation, crossing);
      }),
    );
    expect(await events()).toEqual(first);
  });
});

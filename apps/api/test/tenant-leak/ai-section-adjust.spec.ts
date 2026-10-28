// Ajuste de seção com IA sobre PostgreSQL real (US-121 · Sucesso, Concorrência, Tenant incorreto,
// Falha de banco): a API inteira como `cf_app` (RLS), com os seeders reais, o DFD do DFD-02, o
// gerador REAL `SectionAdjustGenerator` (contexto pelas fachadas de leitura, na transação do
// tenant), o portão de teste e o `FakeAiProvider`. Prova: a `baseRevision` gravada é a revisão da
// seção no pedido; o DOC-26 sobre a seção editada no meio responde 410 sem tocar em nada; a
// aplicação grava seção, proveniência, geração `APPLIED`, auditoria e outbox no MESMO commit, sem
// `DocumentVersion`; uma falha induzida desfaz tudo; a sugestão e o texto de outro tenant são
// invisíveis (404, e nada dele chega ao provedor).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DfdDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiTenantGateRegistry } from '#modules/ai/application/ai-extension-points.js';
import { AI_PROVIDER } from '#modules/ai/application/ai-provider.port.js';
import { FakeAiProvider } from '#modules/ai/infrastructure/fake-ai.provider.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { InMemoryJobQueue } from '#modules/platform/infrastructure/queues/in-memory-job-queue.js';
import { InMemoryAiCircuitStore } from '#modules/platform/infrastructure/redis/in-memory-ai-circuit.store.js';
import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import { AiSuggestionSourceRegistry } from '#shared/ai/ai-suggestion-source.js';
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
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c121-0000-7000-8000-00000000010a';
const B = '0192c121-0000-7000-8000-00000000010b';
const ORG_A = '0192c121-0000-7000-8000-0000000010a0';
const ORG_B = '0192c121-0000-7000-8000-0000000010b0';
const OBRAS = '0192c121-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c121-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c121-0000-7000-8000-0000000010b1';
const ANA = '0192c121-0000-7000-8000-0000000010c1';
const BETO = '0192c121-0000-7000-8000-0000000010c3';
const ANA_M = '0192c121-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-19T13:00:00.000Z');
const MFA = ['pwd', 'otp'];
const TEXT =
  'A Secretaria de Educação precisa substituir os computadores obsoletos dos laboratórios das escolas municipais, que estão sem suporte e prejudicam as aulas.';
const FOREIGN_TEXT =
  'Texto exclusivo da Prefeitura B LEAK-B sobre os postos de saúde rurais e suas necessidades.';
const SUGGESTED = 'Os laboratórios das escolas municipais operam com computadores obsoletos.';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = { ana: 'sub-ana-us121', beto: 'sub-beto-us121' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us121', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us121', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Educação', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Tecnologia', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Saúde LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'carla@a.test', true, 'Carla Andrade'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c121-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c121-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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
interface Target {
  readonly processId: string;
  readonly documentId: string;
}

const words = () => randomUUID().replaceAll('-', '').slice(0, 10);
const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Feature: Ajuste de seção com IA sobre PostgreSQL (US-121)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const provider = new FakeAiProvider();
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

  const sectionRow = async (documentId: string) =>
    (
      await db.admin<Row>(
        `SELECT (draft_content -> 'sections' -> 'JUSTIFICATION' ->> 'revision')::int AS revision,
                draft_content -> 'sections' -> 'JUSTIFICATION' ->> 'state' AS state,
                draft_content -> 'sections' -> 'JUSTIFICATION' -> 'ai' ->> 'generationId' AS generation,
                draft_content -> 'sections' -> 'JUSTIFICATION' -> 'ai' ->> 'reviewedAt' AS reviewed,
                draft_content::text AS content, draft_revision, version
           FROM documents WHERE id = $1`,
        [documentId],
      )
    )[0];

  /** DOC-05 da "JUSTIFICATION" sobre a revisão atual (o autosave do editor). */
  async function saveSection(target: Target, text: string, tenant = A): Promise<void> {
    const current = Number((await sectionRow(target.documentId))?.revision ?? 0);
    const response = await call(
      request(api.server).put(`/api/v1/documents/${target.documentId}/sections/JUSTIFICATION`),
      tenant,
    )
      .set('If-Match', `"s${String(current)}"`)
      .send({ content: paragraph(text), notApplicable: false, justification: null });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  /** Processo (PRC-02) + DFD (DFD-02) com a "JUSTIFICATION" preenchida (um autosave). */
  async function newDfd(tenant = A, text = TEXT): Promise<Target> {
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
    const target = { processId, documentId: (dfd.body as { data: DfdDto }).data.documentId };
    await saveSection(target, text, tenant);
    return target;
  }

  /** Sugestão `SUCCEEDED` de "REWRITE" para a "JUSTIFICATION" (AI-01 + job). */
  async function suggestion(target: Target, tenant = A): Promise<string> {
    provider.enqueue({
      kind: 'output',
      output: {
        sections: [
          { sectionKey: 'JUSTIFICATION', blocks: [{ type: 'paragraph', text: SUGGESTED }] },
        ],
      },
    });
    const response = await call(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
      tenant,
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        targetModule: 'DFD',
        kind: 'SECTION',
        action: 'REWRITE',
        sectionKey: 'JUSTIFICATION',
        documentId: target.documentId,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const id = (response.body as { data: { id: string } }).data.id;
    await runAiJob(api, id);
    const [row] = await db.admin<Row>('SELECT status FROM ai_generations WHERE id = $1', [id]);
    expect(row).toMatchObject({ status: 'SUCCEEDED' });
    return id;
  }

  const apply = async (documentId: string, generationId: string, tenant = A) =>
    call(request(api.server).post(`/api/v1/documents/${documentId}/ai-apply`), tenant)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(Number((await sectionRow(documentId))?.version ?? 0))}"`)
      .send({ generationId, sectionKeys: ['JUSTIFICATION'], confirmReplaceFilled: true });

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
    const seeders = [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    // Gerador REAL (`SECTION`); só o portão do órgão é de teste (US-116 tem a suíte própria).
    api.app.get(AiTenantGateRegistry).register(new TestAiGate());
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Concorrência + Sucesso] seção editada no meio → 410 sem tocar em nada; ajuste novo aplica no mesmo commit, sem versão', async () => {
    const target = await newDfd();
    // A revisão de partida depende do modelo publicado do tipo (US-110): a sugestão fixa a vigente.
    const base = Number((await sectionRow(target.documentId))?.revision);
    const stale = await suggestion(target);
    const [generation] = await db.admin<Row>(
      'SELECT base_revision, kind, action, section_key, prompt_key FROM ai_generations WHERE id = $1',
      [stale],
    );
    expect(generation).toMatchObject({
      base_revision: base,
      kind: 'SECTION',
      action: 'REWRITE',
      section_key: 'JUSTIFICATION',
      prompt_key: 'section.rewrite',
    });

    // Autosave do colega entre o pedido e a aplicação (base + 1): a sugestão ficou obsoleta.
    await saveSection(target, `${TEXT} Ajuste manual feito pela equipe.`);
    const edited = await sectionRow(target.documentId);
    const refused = await apply(target.documentId, stale);
    expect(refused.status, JSON.stringify(refused.body)).toBe(410);
    expect(problemDetailsSchema.parse(refused.body).code).toBe('AI_SUGGESTION_STALE');
    expect(await sectionRow(target.documentId)).toEqual(edited);
    const [kept] = await db.admin<Row>('SELECT status FROM ai_generations WHERE id = $1', [stale]);
    expect(kept).toMatchObject({ status: 'SUCCEEDED' });

    const fresh = await suggestion(target);
    const response = await apply(target.documentId, fresh);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: { versionCreated: unknown } }).data.versionCreated).toBeNull();
    // O autosave do colega e a aplicação: duas revisões depois da base.
    expect(await sectionRow(target.documentId)).toMatchObject({
      revision: base + 2,
      state: 'FILLED',
      generation: fresh,
      reviewed: null,
    });
    const [applied] = await db.admin<Row>(
      'SELECT status, applied_targets FROM ai_generations WHERE id = $1',
      [fresh],
    );
    expect(applied).toMatchObject({
      status: 'APPLIED',
      applied_targets: { sectionKeys: ['JUSTIFICATION'], riskIds: [] },
    });
    const [counts] = await db.admin<Row>(
      `SELECT (SELECT count(*)::int FROM audit_logs WHERE entity_id = $1 AND action = 'ai.content_apply') AS audits,
              (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AiContentApplied'
                 AND routing_key = 'document.ai_content_applied.dfd'
                 AND (payload ->> 'replacedFilledSections')::int = 1) AS events,
              (SELECT count(*)::int FROM document_versions WHERE document_id = $1) AS versions`,
      [target.documentId],
    );
    expect(counts).toEqual({ audits: 1, events: 1, versions: 0 });

    // Nada do texto da seção nem da sugestão fora do documento (logs/eventos/auditoria/timeline).
    const leaks = await db.admin<{ source: string }>(
      `SELECT 'audit' AS source FROM audit_logs WHERE (metadata::text || coalesce(changes::text, '')) LIKE ANY ($1)
       UNION ALL SELECT 'outbox' FROM outbox_events WHERE (payload::text || metadata::text) LIKE ANY ($1)
       UNION ALL SELECT 'timeline' FROM process_timeline_entries WHERE params::text LIKE ANY ($1)`,
      [['%computadores obsoletos%']],
    );
    expect(leaks).toEqual([]);
  });

  it('[Falha de banco] falha depois de gravar o documento desfaz tudo e a geração continua SUCCEEDED', async () => {
    const target = await newDfd();
    const id = await suggestion(target);
    const before = await sectionRow(target.documentId);
    const suggestions = api.app.get(AiSuggestionSourceRegistry);
    const spy = vi
      .spyOn(suggestions, 'markApplied')
      .mockRejectedValueOnce(new DatabaseUnavailableError(new Error('ECONNRESET')));
    try {
      const response = await apply(target.documentId, id);
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
    expect(await sectionRow(target.documentId)).toEqual(before);
    const [generation] = await db.admin<Row>('SELECT status FROM ai_generations WHERE id = $1', [
      id,
    ]);
    expect(generation).toMatchObject({ status: 'SUCCEEDED' });
    const [counts] = await db.admin<Row>(
      `SELECT (SELECT count(*)::int FROM audit_logs WHERE entity_id = $1 AND action = 'ai.content_apply') AS audits,
              (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AiContentApplied') AS events`,
      [target.documentId],
    );
    expect(counts).toEqual({ audits: 0, events: 0 });
  });

  it('[Tenant incorreto] sugestão e documento de outro tenant: 404, e nada do outro tenant chega ao provedor (RLS)', async () => {
    const foreignTarget = await newDfd(B, FOREIGN_TEXT);
    const foreign = await suggestion(foreignTarget, B);
    provider.reset();
    const own = await newDfd();

    const applyForeign = await apply(own.documentId, foreign);
    expect(applyForeign.status).toBe(404);
    expect(problemDetailsSchema.parse(applyForeign.body).code).toBe('AI_GENERATION_NOT_FOUND');

    const crossed = await call(
      request(api.server).post(`/api/v1/processes/${own.processId}/ai-generations`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        targetModule: 'DFD',
        kind: 'SECTION',
        action: 'REWRITE',
        sectionKey: 'JUSTIFICATION',
        documentId: foreignTarget.documentId,
      });
    expect(crossed.status).toBe(404);
    expect(problemDetailsSchema.parse(crossed.body).code).toBe('NOT_FOUND');
    expect(JSON.stringify(crossed.body)).not.toContain(foreignTarget.processId);

    await suggestion(own);
    const sent = JSON.stringify(provider.calls);
    expect(sent).toContain('computadores obsoletos');
    expect(sent).not.toContain('LEAK-B');
    expect(sent).not.toContain(foreignTarget.processId);
    const [untouched] = await db.admin<Row>('SELECT status FROM ai_generations WHERE id = $1', [
      foreign,
    ]);
    expect(untouched).toMatchObject({ status: 'SUCCEEDED' });
  });
});

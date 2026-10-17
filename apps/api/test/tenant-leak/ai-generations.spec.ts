// Camada de IA sobre PostgreSQL real (US-115 · Sucesso, Tenant incorreto, Duplicidade, Concorrência,
// Falha de banco): a API inteira como `cf_app` (RLS) com os seeders reais, o processo do PRC-02, o
// DFD da fábrica única, o gerador/portão de teste e o `FakeAiProvider`. Prova: o registro QUEUED, a
// auditoria e o outbox no mesmo commit, antes de qualquer chamada ao provedor; o job conclui
// gravando proposta, auditoria, evento e timeline numa transação; os únicos parciais de "uma ativa
// por alvo"; a RLS, as FKs compostas e a ausência de DELETE; o trigger dos estados finais; e a
// varredura de "nenhum texto do pedido ou da proposta em auditoria, outbox ou timeline".
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AI_PROVIDER } from '#modules/ai/application/ai-provider.port.js';
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

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import { installAiTestDoubles, runAiJob } from '../support/ai-fixtures.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { documentFacadeOf } from '../support/document-fixtures.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c115-0000-7000-8000-00000000010a';
const B = '0192c115-0000-7000-8000-00000000010b';
const ORG_A = '0192c115-0000-7000-8000-0000000010a0';
const ORG_B = '0192c115-0000-7000-8000-0000000010b0';
const OBRAS = '0192c115-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c115-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c115-0000-7000-8000-0000000010b1';
const LUCIA = '0192c115-0000-7000-8000-0000000010c2';
const BETO = '0192c115-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c115-0000-7000-8000-0000000010d2';
const BETO_M = '0192c115-0000-7000-8000-0000000010d3';
const NOW = new Date('2026-10-16T13:00:00.000Z');
const MFA = ['pwd', 'otp'];
const SUMMARY = 'Aquisição de 30 computadores para os laboratórios TEXTO-SIGILOSO-DO-PEDIDO.';
const OUTPUT_MARKER = 'TEXTO-DA-PROPOSTA-GERADA';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us115', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us115', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us115', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us115', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
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

type Row = Readonly<Record<string, unknown>>;

describe('Feature: Camada de IA sobre PostgreSQL (US-115)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const provider = new FakeAiProvider();
  const queue = new InMemoryJobQueue();
  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const as = (tenant: string) =>
    tenant === A
      ? { subject: 'sub-lucia-us115', userId: LUCIA, membershipId: LUCIA_M }
      : { subject: 'sub-beto-us115', userId: BETO, membershipId: BETO_M };

  const call = (
    method: 'get' | 'post',
    url: string,
    options: { tenant?: string; body?: object } = {},
  ) => {
    const tenant = options.tenant ?? A;
    const agent = request(api.server);
    const pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(as(tenant).subject, { amr: MFA }))
      .set('X-Tenant-Id', tenant)
      .set('Idempotency-Key', randomUUID());
    return options.body === undefined ? pending : pending.send(options.body);
  };

  async function newDfd(tenant = A): Promise<{ processId: string; documentId: string }> {
    const catalog = async (type: string, code: string) =>
      (
        await db.admin<{ id: string }>(
          'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
          [tenant, type, code],
        )
      )[0]?.id ?? '';
    const secretariat = tenant === A ? OBRAS : OBRAS_B;
    const created = await call('post', '/processes', {
      tenant,
      body: {
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalog('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: secretariat,
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
    const actor = as(tenant);
    const document = await runWithRequestContext(
      { correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' },
      () => {
        updateRequestContext({
          tenantId: tenant,
          actor: { type: 'USER', userId: actor.userId, membershipId: actor.membershipId },
          amr: MFA,
        });
        return transactions.run((tx) =>
          documentFacadeOf(api).createIn(tx, {
            processId,
            documentTypeId: type?.id ?? '',
            title: 'DFD dos laboratórios',
            templateVersionId: null,
          }),
        );
      },
    );
    return { processId, documentId: document.id };
  }

  const requestDraft = (target: { processId: string; documentId: string }, tenant = A) =>
    call('post', `/processes/${target.processId}/ai-generations`, {
      tenant,
      body: {
        targetModule: 'DFD',
        kind: 'DRAFT',
        documentId: target.documentId,
        needSummary: SUMMARY,
      },
    });

  async function requested(target: { processId: string; documentId: string }, tenant = A) {
    const response = await requestDraft(target, tenant);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { data: { id: string } }).data.id;
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
    installAiTestDoubles(api);
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] QUEUED + auditoria + outbox no commit; o job grava proposta, auditoria, evento e timeline — sem texto fora da proposta', async () => {
    const target = await newDfd();
    provider.enqueue({
      kind: 'output',
      output: {
        sections: ['NECESSIDADE', 'JUSTIFICATIVA'].map((sectionKey) => ({
          sectionKey,
          blocks: [{ type: 'paragraph', text: `${OUTPUT_MARKER} [a confirmar: quantidade]` }],
        })),
      },
    });
    const id = await requested(target);
    expect(provider.calls).toHaveLength(0);
    const [queued] = await db.admin<Row>(
      'SELECT status, prompt_key, need_summary FROM ai_generations WHERE id = $1',
      [id],
    );
    expect(queued).toMatchObject({
      status: 'QUEUED',
      prompt_key: 'test.draft',
      need_summary: SUMMARY,
    });

    await runAiJob(api, id);
    const [done] = await db.admin<Row>(
      `SELECT status, attempts, context_hash, output_hash, total_tokens, cost_usd::text AS cost,
              expires_at - completed_at AS ttl, jsonb_array_length(input_refs) AS refs
         FROM ai_generations WHERE id = $1`,
      [id],
    );
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 1, cost: '0.000000', refs: 2 });
    expect(String(done?.context_hash)).toMatch(/^[0-9a-f]{64}$/);

    const events = await db.admin<{ event_type: string; status: string }>(
      'SELECT event_type, status FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at, id',
      [id],
    );
    expect(events.map((event) => `${event.event_type}:${event.status}`)).toEqual([
      'AiGenerationRequested:PENDING',
      'AiGenerationCompleted:PENDING',
    ]);
    const audit = await db.admin<{ action: string; category: string }>(
      'SELECT action, category FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at',
      [id],
    );
    expect(audit.map((row) => `${row.action}:${row.category}`)).toEqual([
      'ai.generation_request:DATA_CHANGE',
      'ai.generation_complete:SYSTEM',
    ]);
    const [timeline] = await db.admin<{ type: string; actor_id: string }>(
      "SELECT type, actor_id FROM process_timeline_entries WHERE entity_id = $1 AND type = 'AI_CONTENT_GENERATED'",
      [id],
    );
    expect(timeline).toMatchObject({ actor_id: LUCIA });

    // CA-T-06 · tests.md §3.10: nenhum texto do pedido nem da proposta fora de `ai_generations`.
    const leaks = await db.admin<{ source: string }>(
      `SELECT 'audit' AS source FROM audit_logs WHERE (metadata::text || coalesce(changes::text, '')) LIKE ANY ($1)
       UNION ALL SELECT 'outbox' FROM outbox_events WHERE (payload::text || metadata::text) LIKE ANY ($1)
       UNION ALL SELECT 'timeline' FROM process_timeline_entries WHERE params::text LIKE ANY ($1)`,
      [[`%TEXTO-SIGILOSO-DO-PEDIDO%`, `%${OUTPUT_MARKER}%`]],
    );
    expect(leaks).toEqual([]);
  });

  it('[Duplicidade] o único parcial impede duas ativas no mesmo alvo (409 com a ativa) e libera após o término', async () => {
    const target = await newDfd();
    const first = await requested(target);
    const second = await requestDraft(target);
    expect(second.status).toBe(409);
    expect(problemDetailsSchema.parse(second.body).code).toBe('AI_GENERATION_IN_PROGRESS');
    expect(second.body).toMatchObject({ meta: { generationId: first } });
    // Direto no banco: o índice parcial é a defesa definitiva.
    await expect(
      db.admin(
        `INSERT INTO ai_generations (id, tenant_id, process_id, document_id, target_module, kind,
           provider, prompt_key, prompt_version, reserved_tokens, created_by_id)
         VALUES ($1, $2, $3, $4, 'DFD', 'DRAFT', 'fake', 'test.draft', '1.0.0', 1, $5)`,
        [randomUUID(), A, target.processId, target.documentId, LUCIA],
      ),
    ).rejects.toThrow(/ai_generations_active_draft_key/);
    await runAiJob(api, first);
    expect((await requestDraft(target)).status).toBe(202);
  });

  it('[Concorrência] dois pedidos simultâneos para o mesmo alvo: um 202 e um 409', async () => {
    const target = await newDfd();
    const responses = await Promise.all([requestDraft(target), requestDraft(target)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const [count] = await db.admin<{ count: string }>(
      'SELECT count(*) FROM ai_generations WHERE process_id = $1',
      [target.processId],
    );
    expect(Number(count?.count)).toBe(1);
  });

  it('[Tenant incorreto] geração e processo de B → 404 para A; RLS esconde as linhas; FK composta e sem DELETE', async () => {
    const targetB = await newDfd(B);
    const generationB = await requested(targetB, B);

    const get = await call('get', `/ai-generations/${generationB}`);
    expect(get.status).toBe(404);
    expect(problemDetailsSchema.parse(get.body).code).toBe('AI_GENERATION_NOT_FOUND');
    expect(JSON.stringify(get.body)).not.toContain('LEAK-B');
    const discard = await call('post', `/ai-generations/${generationB}/discard`, { body: {} });
    expect(discard.status).toBe(404);
    const [stillQueued] = await db.admin<{ status: string }>(
      'SELECT status FROM ai_generations WHERE id = $1',
      [generationB],
    );
    expect(stillQueued?.status).toBe('QUEUED');
    expect((await requestDraft(targetB)).status).toBe(404);
    expect((await call('get', `/processes/${targetB.processId}/ai-generations`)).status).toBe(404);

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(A, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<Row[]>`SELECT id FROM ai_generations WHERE tenant_id = ${B}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
      const remove = asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`DELETE FROM ai_generations WHERE id = ${generationB}::uuid`,
        ),
      );
      await expect(remove).rejects.toThrow(/permission denied/);
    } finally {
      await client.$disconnect();
    }
    const targetA = await newDfd();
    await expect(
      db.admin(
        `INSERT INTO ai_generations (id, tenant_id, process_id, document_id, target_module, kind,
           status, provider, prompt_key, prompt_version, reserved_tokens, created_by_id)
         VALUES ($1, $2, $3, $4, 'DFD', 'DRAFT', 'CANCELED', 'fake', 'test.draft', '1.0.0', 1, $5)`,
        [randomUUID(), B, targetB.processId, targetA.documentId, BETO],
      ),
    ).rejects.toThrow(/ai_generations_tenant_id_document_id_fkey/);
  });

  it('[Imutabilidade] estados finais não voltam; identidade e alvo não mudam; FAILED exige errorCode', async () => {
    const target = await newDfd();
    const id = await requested(target);
    const discard = await call('post', `/ai-generations/${id}/discard`, { body: {} });
    expect(discard.status, JSON.stringify(discard.body)).toBe(200);
    await expect(
      db.admin("UPDATE ai_generations SET status = 'QUEUED' WHERE id = $1", [id]),
    ).rejects.toThrow(/status final não muda/);
    await expect(
      db.admin('UPDATE ai_generations SET process_id = $2 WHERE id = $1', [id, randomUUID()]),
    ).rejects.toThrow(/imutáveis/);
    const other = await requested(await newDfd());
    await expect(
      db.admin("UPDATE ai_generations SET status = 'FAILED' WHERE id = $1", [other]),
    ).rejects.toThrow(/ai_generations_failed_has_error/);
  });
});

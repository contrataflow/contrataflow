// Revisão humana do conteúdo gerado por IA sobre PostgreSQL real (US-122 · DOC-27 · Sucesso, Tenant
// incorreto, Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS)
// com os seeders reais, o processo criado pelo PRC-02 e o DFD pela fábrica única
// (`DocumentFacade.createIn`); a proveniência pendente é gravada no `draft_content` como a aplicação
// (DOC-26 — US-117) a deixaria. Prova: revisão, auditoria, timeline e evento `PENDING` num commit
// só; documento de outro tenant → 404 e invisível pela RLS; falha induzida no outbox desfaz tudo;
// duas revisões simultâneas (linha travada) → uma efetiva e um único evento.
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

const A = '0192c122-0000-7000-8000-00000000010a';
const B = '0192c122-0000-7000-8000-00000000010b';
const ORG_A = '0192c122-0000-7000-8000-0000000010a0';
const ORG_B = '0192c122-0000-7000-8000-0000000010b0';
const OBRAS = '0192c122-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c122-0000-7000-8000-0000000010a2';
const LUCIA = '0192c122-0000-7000-8000-0000000010c2';
const BETO = '0192c122-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c122-0000-7000-8000-0000000010d2';
const G1 = '0192c122-0000-7000-8000-0000000010e1';
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us122', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us122', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${LUCIA}', 'sub-lucia-us122', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us122', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c122-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
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

/** Seção aplicada pela IA e ainda não revisada (revisão 4). */
const PENDING_DRAFT = {
  sections: {
    JUSTIFICATION: {
      state: 'FILLED',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texto LEAK-A gerado' }] }],
      },
      justification: null,
      revision: 4,
      updatedAt: '2026-10-16T12:00:00.000Z',
      updatedById: LUCIA,
      ai: {
        generationId: G1,
        appliedAt: '2026-10-16T12:00:00.000Z',
        appliedById: LUCIA,
        reviewedAt: null,
        reviewedById: null,
      },
    },
  },
};

const REVIEW_BODY = { sectionKeys: ['JUSTIFICATION'], expectedRevisions: { JUSTIFICATION: 4 } };

describe('Feature: Revisão do conteúdo gerado por IA sobre PostgreSQL (US-122)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let openStages: Set<string>;
  let dfdType: string;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const review = (id: string, options: { subject?: string; tenant?: string } = {}) =>
    request(api.server)
      .post(`/api/v1/documents/${id}/ai-review`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us122', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A)
      .send(REVIEW_BODY);

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
      .set('Authorization', api.bearer('sub-lucia-us122', { amr: MFA }))
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

  /** DFD criado pela fábrica real, com a seção JUSTIFICATION pendente de revisão. */
  async function newPendingDfd(): Promise<{ id: string; processId: string }> {
    const processId = await newProcess();
    const transactions = api.app.get<DocumentTransactions>(DOCUMENT_TRANSACTIONS);
    const document = await runWithRequestContext(
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
            documentTypeId: dfdType,
            title: 'DFD da aquisição de cadeiras',
            templateVersionId: null,
          }),
        );
      },
    );
    await db.admin('UPDATE documents SET draft_content = $1::jsonb WHERE id = $2', [
      JSON.stringify(PENDING_DRAFT),
      document.id,
    ]);
    return { id: document.id, processId };
  }

  const reviewedAtOf = async (id: string) =>
    (
      await db.admin<{ reviewed_at: string | null; revision: number; version: number }>(
        `SELECT draft_content #>> '{sections,JUSTIFICATION,ai,reviewedAt}' AS reviewed_at,
                (draft_content #>> '{sections,JUSTIFICATION,revision}')::int AS revision, version
           FROM documents WHERE id = $1`,
        [id],
      )
    )[0];

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
    dfdType =
      (
        await db.admin<{ id: string }>(
          "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DFD'",
          [A],
        )
      )[0]?.id ?? '';
    expect(dfdType).not.toBe('');
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso/Falha de integração] revisão, auditoria, timeline e evento PENDING num commit só', async () => {
    const document = await newPendingDfd();
    const response = await review(document.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: { reviewedSectionKeys: string[] } }).data).toMatchObject({
      reviewedSectionKeys: ['JUSTIFICATION'],
    });

    const row = await reviewedAtOf(document.id);
    expect(row?.reviewed_at).not.toBeNull();
    expect(row).toMatchObject({ revision: 5, version: 2 });
    const events = await db.admin<{ status: string; routing_key: string; payload: Row }>(
      "SELECT status, routing_key, payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AiContentReviewed'",
      [document.id],
    );
    // Sem relay: o evento fica PENDING até a publicação.
    expect(events).toEqual([
      expect.objectContaining({
        status: 'PENDING',
        routing_key: 'document.ai_content_reviewed.dfd',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('Texto LEAK-A');
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'ai.content_review'",
        [A, document.id],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) FROM process_timeline_entries WHERE process_id = $1 AND type = 'AI_CONTENT_REVIEWED'",
        [document.processId],
      ),
    ).toBe(1);
  });

  it('[Tenant incorreto] DOC-27 em documento de outro tenant → 404; RLS esconde o rascunho', async () => {
    const document = await newPendingDfd();
    const foreign = await review(document.id, { subject: 'sub-beto-us122', tenant: B });
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-A');
    expect((await reviewedAtOf(document.id))?.reviewed_at).toBeNull();

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<Row[]>`SELECT id FROM documents WHERE id = ${document.id}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Falha de banco] falha induzida no outbox desfaz a revisão e a auditoria', async () => {
    const document = await newPendingDfd();
    await db.admin(`
      CREATE FUNCTION test_fail_ai_review() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'AiContentReviewed' AND NEW.aggregate_id = '${document.id}' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_ai_review BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_ai_review();
    `);
    try {
      expect((await review(document.id)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_ai_review ON outbox_events; DROP FUNCTION test_fail_ai_review();',
      );
    }
    expect(await reviewedAtOf(document.id)).toMatchObject({
      reviewed_at: null,
      revision: 4,
      version: 1,
    });
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'ai.content_review'",
        [A, document.id],
      ),
    ).toBe(0);
    // A próxima tentativa (sem a falha) conclui normalmente.
    expect((await review(document.id)).status).toBe(200);
  });

  it('[Concorrência] duas revisões simultâneas: uma efetiva e um único evento', async () => {
    const document = await newPendingDfd();
    const responses = await Promise.all([review(document.id), review(document.id)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const reviewed = responses.map(
      (response) =>
        (response.body as { data: { reviewedSectionKeys: string[] } }).data.reviewedSectionKeys
          .length,
    );
    expect(reviewed.sort()).toEqual([0, 1]);
    expect(
      await count(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'AiContentReviewed'",
        [document.id],
      ),
    ).toBe(1);
    expect((await reviewedAtOf(document.id))?.revision).toBe(5);
  });
});

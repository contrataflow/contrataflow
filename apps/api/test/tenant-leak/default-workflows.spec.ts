// Workflow padrão e seleção por aplicabilidade sobre PostgreSQL real (US-042 · Sucesso, Tenant
// incorreto, Duplicidade, Concorrência, Falha de banco, Falha de integração): seeders reais de
// catálogo, perfis, tipos de documento e workflows em `TenantTransaction` dos tenants A e B (RLS),
// publicação pela rotina do editor (hash reprodutível no banco), reexecução e corrida do seeder
// pelo índice único `(tenant_id, key)`, troca do padrão serializada pela trava de todos os
// workflows (uma 200 e uma 412), índice único parcial do padrão, atomicidade da troca e o evento
// `WorkflowDefaultChanged` `PENDING` no outbox (o relay não roda aqui). Perfis do vínculo por
// porta de teste (atribuições: US-096). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { WorkflowDto, WorkflowResolutionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { WorkflowFacade } from '#modules/workflow/application/workflow.facade.js';
import { PrismaWorkflowRepository } from '#modules/workflow/infrastructure/prisma-workflow.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';
import { TenantSeederRegistry } from '#shared/tenancy/tenant-seeding.js';
import type { TenantSeedResult } from '#shared/tenancy/tenant-seeding.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000420a';
const B = '0192c000-0000-7000-8000-00000000420b';
const MARTA = '0192c000-0000-7000-8000-0000000420a1';
const OTAVIO = '0192c000-0000-7000-8000-0000000420a2';
const FABIO = '0192c000-0000-7000-8000-0000000420a3';
const BETO = '0192c000-0000-7000-8000-0000000420b1';
const MFA = ['pwd', 'otp'];
const DEFAULT_KEY = 'DEFAULT_PREPARATORY';
const DIRECT_KEY = 'DIRECT_CONTRACTING_ART72';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [OTAVIO]: ['ADMIN_ORGAO'],
  // Só WORKFLOW_VIEW (permissions.md §3.2).
  [FABIO]: ['COMPRAS'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-wf42', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf42', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${OTAVIO}', 'sub-otavio', 'otavio@a.test', true, 'Otávio Campos'),
  ('${FABIO}', 'sub-fabio', 'fabio@a.test', true, 'Bruno Fábio'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000421a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000421a2', '${A}', '${OTAVIO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000421a3', '${A}', '${FABIO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000421b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
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

describe('Feature: workflow padrão e aplicabilidade isolados por tenant no PostgreSQL (US-042)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const tenantOf = (subject: string) => (subject === 'sub-beto' ? B : A);
  const as = (test: request.Test, subject: string) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const list = async (subject = 'sub-marta') => {
    const response = await as(request(api.server).get('/api/v1/workflows'), subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { data: WorkflowDto[] }).data;
  };
  const byKey = async (key: string, subject = 'sub-marta') => {
    const found = (await list(subject)).find((workflow) => workflow.key === key);
    if (!found) throw new Error(`workflow ${key} ausente`);
    return found;
  };
  const setDefault = (subject: string, id: string, version: number) =>
    as(request(api.server).post(`/api/v1/workflows/${id}/set-default`), subject).set(
      'If-Match',
      `"${version}"`,
    );
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

  const seedStep = (tenantId: string, key: string): Promise<TenantSeedResult> => {
    const seeder = api.app
      .get(TenantSeederRegistry)
      .all()
      .find((candidate) => candidate.key === key);
    if (!seeder) throw new Error(`Seeder ${key} não registrado.`);
    return runAsSystem({ name: 'Provisionamento de tenant', tenantId }, () =>
      seeder.seed({ tenantId, slug: 'teste', now: new Date(), request: null }),
    );
  };
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const processBody = async (tenantId: string, modality: string) => ({
    contractingTypeId: await catalogId(tenantId, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
    modalityId: await catalogId(tenantId, 'MODALITY', modality),
    originId: await catalogId(tenantId, 'PROCESS_ORIGIN', 'PCA'),
    organizationId: '0192c000-0000-7000-8000-0000000422a1',
    isPriceRegistration: false,
  });
  const resolve = async (subject: string, body: object) => {
    const response = await as(request(api.server).post('/api/v1/workflows/resolve'), subject).send(
      body,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { data: WorkflowResolutionDto }).data;
  };
  const workflowRows = (tenantId: string) =>
    db.admin<Row>(
      `SELECT id, key, is_default, version, current_published_version_id FROM workflows
        WHERE tenant_id = $1 ORDER BY key`,
      [tenantId],
    );
  const digestOf = async (tenantId: string) => {
    const digests = [];
    for (const table of ['workflows', 'workflow_versions', 'workflow_stages', 'workflow_rules']) {
      const [row] = await db.admin<{ digest: string }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
           FROM ${table} t WHERE tenant_id = $1`,
        [tenantId],
      );
      digests.push(row?.digest);
    }
    return digests.join(':');
  };
  const events = (tenantId: string, type: string) =>
    db.admin<Row>(
      `SELECT routing_key, status, payload FROM outbox_events
        WHERE tenant_id = $1 AND event_type = $2 ORDER BY occurred_at, id`,
      [tenantId, type],
    );
  const audits = (tenantId: string, action: string) =>
    db.admin<Row>(
      `SELECT actor_type, entity_id, changes, metadata FROM audit_logs
        WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
      [tenantId, action],
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
    // Background: tenants em provisionamento, com MODALITY (DISPENSA/INEXIGIBILIDADE), perfis e
    // tipos de documento — os pré-requisitos do seeder de workflows.
    for (const tenantId of [A, B]) {
      for (const key of ['catalog.items', 'access.defaultRoles', 'document.systemTypes']) {
        await seedStep(tenantId, key);
      }
    }
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] o seeder cria os dois workflows publicados, um padrão, com hash reprodutível no banco', async () => {
    const digestOfB = await digestOf(B);

    expect(await seedStep(A, 'workflow.seedWorkflows')).toEqual({ created: 2, skipped: 0 });

    const rows = await workflowRows(A);
    expect(rows.map((row) => [row.key, row.is_default])).toEqual([
      [DEFAULT_KEY, true],
      [DIRECT_KEY, false],
    ]);
    for (const row of rows) {
      const [version] = await db.admin<Row>(
        `SELECT status, version_number, definition_snapshot, definition_hash FROM workflow_versions
          WHERE id = $1`,
        [row.current_published_version_id],
      );
      expect(version).toMatchObject({ status: 'PUBLISHED', version_number: 1 });
      expect(sha256Hex(canonicalJson(version?.definition_snapshot))).toBe(version?.definition_hash);
    }
    const [stages] = await db.admin<{ count: string }>(
      'SELECT count(*) FROM workflow_stages WHERE tenant_id = $1',
      [A],
    );
    expect(Number(stages?.count)).toBe(7 + 5);
    expect((await audits(A, 'workflow.version_publish')).map((r) => r.actor_type)).toEqual([
      'SYSTEM',
      'SYSTEM',
    ]);
    expect(await events(A, 'WorkflowCreated')).toHaveLength(2);
    expect(await events(A, 'WorkflowDefaultChanged')).toHaveLength(0);
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Duplicidade] reexecução e corrida do seeder não duplicam nem sobrescrevem', async () => {
    const before = await digestOf(A);
    expect(await seedStep(A, 'workflow.seedWorkflows')).toEqual({ created: 0, skipped: 2 });
    expect(await digestOf(A)).toBe(before);

    // Duas execuções simultâneas no tenant B: o índice único decide, sem erro nem duplicata.
    const [first, second] = await Promise.all([
      seedStep(B, 'workflow.seedWorkflows'),
      seedStep(B, 'workflow.seedWorkflows'),
    ]);
    expect(first.created + second.created).toBe(2);
    const rowsOfB = await workflowRows(B);
    expect(rowsOfB.map((row) => row.key)).toEqual([DEFAULT_KEY, DIRECT_KEY]);
    expect(rowsOfB.filter((row) => row.is_default)).toHaveLength(1);
  });

  it('[Sucesso] DISPENSA resolve para a contratação direta e PREGAO para o padrão', async () => {
    const direct = await byKey(DIRECT_KEY);
    const standard = await byKey(DEFAULT_KEY);
    expect(await resolve('sub-fabio', await processBody(A, 'DISPENSA'))).toMatchObject({
      workflowId: direct.id,
      workflowVersionId: direct.currentPublishedVersion?.id,
      initialStage: { key: 'ABERTURA', name: 'Formalização da demanda' },
    });
    expect((await resolve('sub-fabio', await processBody(A, 'PREGAO'))).workflowId).toBe(
      standard.id,
    );
  });

  it('[Tenant incorreto] resolução e troca nunca usam workflows de outro tenant (RLS)', async () => {
    const idsOfB = new Set((await workflowRows(B)).map((row) => row.id));
    const digestOfB = await digestOf(B);
    for (const modality of ['DISPENSA', 'INEXIGIBILIDADE', 'PREGAO']) {
      const resolved = await resolve('sub-marta', await processBody(A, modality));
      expect(idsOfB.has(resolved.workflowId)).toBe(false);
    }
    const directOfB = await byKey(DIRECT_KEY, 'sub-beto');
    const foreign = await setDefault('sub-marta', directOfB.id, directOfB.version);
    expect(foreign.status).toBe(404);
    expect(problemCode(foreign)).toBe('NOT_FOUND');
    // Item de catálogo de B na resolução de A = inexistente.
    const crossed = await as(
      request(api.server).post('/api/v1/workflows/resolve'),
      'sub-marta',
    ).send(await processBody(B, 'DISPENSA'));
    expect(crossed.status).toBe(422);
    expect(problemCode(crossed)).toBe('VALIDATION_ERROR');
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Permissão] só WORKFLOW_VIEW → 403 e o padrão não muda', async () => {
    const direct = await byKey(DIRECT_KEY, 'sub-fabio');
    const response = await setDefault('sub-fabio', direct.id, direct.version);
    expect(response.status).toBe(403);
    expect(problemCode(response)).toBe('PERMISSION_DENIED');
    expect((await workflowRows(A)).filter((row) => row.is_default).map((row) => row.key)).toEqual([
      DEFAULT_KEY,
    ]);
  });

  it('[Falha de banco] falha no meio da troca desfaz tudo: o padrão anterior permanece', async () => {
    const direct = await byKey(DIRECT_KEY);
    const before = await digestOf(A);
    // A troca acontece de fato (desmarca e marca) e só então a conexão "cai".
    const repository = api.app.get(PrismaWorkflowRepository);
    const original = repository.switchDefault.bind(repository);
    const failing = vi.spyOn(repository, 'switchDefault').mockImplementation(async (tx, change) => {
      await original(tx, change);
      throw new DatabaseUnavailableError(new Error('conexão perdida'));
    });
    try {
      const response = await setDefault('sub-marta', direct.id, direct.version);
      expect(response.status).toBe(503);
      expect(problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      failing.mockRestore();
    }
    expect(await digestOf(A)).toBe(before);
    expect(await audits(A, 'workflow.set_default')).toHaveLength(0);
    expect(await events(A, 'WorkflowDefaultChanged')).toHaveLength(0);
  });

  it('[Falha de integração] troca com sucesso: auditoria na transação e evento PENDING até o relay', async () => {
    const standard = await byKey(DEFAULT_KEY);
    const direct = await byKey(DIRECT_KEY);

    const response = await setDefault('sub-marta', direct.id, direct.version);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await workflowRows(A)).filter((row) => row.is_default).map((row) => row.key)).toEqual([
      DIRECT_KEY,
    ]);
    expect(await audits(A, 'workflow.set_default')).toEqual([
      expect.objectContaining({
        actor_type: 'USER',
        entity_id: direct.id,
        metadata: expect.objectContaining({ previousWorkflowId: standard.id }) as unknown,
      }),
    ]);
    expect(await events(A, 'WorkflowDefaultChanged')).toEqual([
      {
        routing_key: 'workflow.default_changed',
        status: 'PENDING',
        payload: { workflowId: direct.id },
      },
    ]);
  });

  it('[Concorrência] duas trocas simultâneas da mesma leitura: uma 200, outra 412, um único padrão', async () => {
    // Terceiro workflow publicado (cópia da v1 do padrão) para disputar com o padrão semeado.
    const standard = await byKey(DEFAULT_KEY);
    const created = await as(request(api.server).post('/api/v1/workflows'), 'sub-marta')
      .set('Idempotency-Key', randomUUID())
      .send({
        key: 'PILOTO_OBRAS',
        name: 'Piloto de obras',
        copyFromVersionId: standard.currentPublishedVersion?.id,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const piloto = (created.body as { data: WorkflowDto }).data;
    await runAsSystem({ name: 'test.publisher', tenantId: A }, () =>
      api.app
        .get(WorkflowFacade, { strict: false })
        .publish({ versionId: piloto.draftVersion?.id ?? '' }),
    );
    const snapshot = await list();
    const versionOf = (key: string) => snapshot.find((w) => w.key === key)?.version ?? 0;
    const idOf = (key: string) => snapshot.find((w) => w.key === key)?.id ?? '';

    const responses = await Promise.all([
      setDefault('sub-marta', idOf(DEFAULT_KEY), versionOf(DEFAULT_KEY)),
      setDefault('sub-otavio', idOf('PILOTO_OBRAS'), versionOf('PILOTO_OBRAS')),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const loser = responses.find((response) => response.status === 412);
    expect(loser && problemCode(loser)).toBe('VERSION_CONFLICT');
    const defaults = (await workflowRows(A)).filter((row) => row.is_default);
    expect(defaults).toHaveLength(1);
    const winner = responses.find((response) => response.status === 200);
    expect(defaults[0]?.id).toBe((winner?.body as { data: WorkflowDto }).data.id);
  });

  it('[Falha de banco] o índice único parcial recusa um segundo padrão mesmo por SQL direto', async () => {
    const [other] = (await workflowRows(A)).filter((row) => !row.is_default);
    await expect(
      db.admin('UPDATE workflows SET is_default = true WHERE id = $1', [other?.id]),
    ).rejects.toThrow(/workflows_tenant_id_default_key/);
  });

  it('[Falha de banco] banco indisponível ao trocar o padrão → 503 DEPENDENCY_UNAVAILABLE', async () => {
    const direct = await byKey(DIRECT_KEY);
    dbStopped = true;
    await db.container.stop();
    const response = await setDefault('sub-marta', direct.id, direct.version);
    expect(response.status).toBe(503);
    expect(problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
  });
});

// Regras de workflow e "Testar regra" sobre PostgreSQL real (US-044 · Tenant incorreto,
// Concorrência, Duplicidade, RN-WF-56): regra de outro tenant → 404 sem vazar nada e sem tocar na
// linha; regra/teste na versão de outro tenant → 404; processo de outro tenant no teste → 404 igual
// ao inexistente; dois PATCH com o mesmo If-Match (um 200, outro 412); testar repetidamente não
// grava regra, auditoria nem outbox. O agregado `Process` vem do store em memória (a porta
// `PROCESS_RUNTIME_READER`, como em `process-actions.spec.ts`); workflow, identidade e transação
// são os reais. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowRuleDto,
  WorkflowRuleTestResult,
  WorkflowStageDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { PROCESS_RUNTIME_READER } from '#modules/process/application/ports.js';
import { InMemoryProcessRuntimeStore } from '#modules/process/infrastructure/process-runtime.readers.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { etp, processRuntime } from '../support/workflow-engine-fixtures.js';

const A = '0192c044-0000-7000-8000-00000000000a';
const B = '0192c044-0000-7000-8000-00000000000b';
const CARLA = '0192c044-0000-7000-8000-0000000000a1';
const DIEGO = '0192c044-0000-7000-8000-0000000000a2';
const BETO = '0192c044-0000-7000-8000-0000000000b1';
const PROCESS_A = '0192c044-0000-7000-8000-0000000003a1';
const PROCESS_B = '0192c044-0000-7000-8000-0000000003b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['ADMIN_ORGAO'],
  [DIEGO]: ['ADMIN_ORGAO'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-wf-rules', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf-rules', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Mendes'),
  ('${DIEGO}', 'sub-diego', 'diego@a.test', true, 'Diego Lima'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c044-0000-7000-8000-0000000001a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c044-0000-7000-8000-0000000001a2', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c044-0000-7000-8000-0000000001b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real. */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: regras de workflow isoladas por tenant sobre PostgreSQL (US-044)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const store = new InMemoryProcessRuntimeStore();

  const tenantOf = (subject: string) => (subject === 'sub-beto' ? B : A);
  const as = (test: request.Test, subject: string) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const post = (subject: string, path: string, body: object) =>
    as(request(api.server).post(`/api/v1${path}`), subject)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const patch = (subject: string, path: string, body: object, version: number) =>
    as(request(api.server).patch(`/api/v1${path}`), subject)
      .set('If-Match', `"${version}"`)
      .send(body);
  const remove = (subject: string, path: string, version: number) =>
    as(request(api.server).delete(`/api/v1${path}`), subject).set('If-Match', `"${version}"`);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;
  const count = async (table: string) =>
    (await db.admin<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]?.n;

  /** Rascunho com a etapa ESTUDOS_PRELIMINARES e uma regra REQUIRED_FIELD. */
  const draftWithRule = async (subject: string, key: string) => {
    const created = await post(subject, '/workflows', { key, name: `Fluxo ${key}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const draftId = data<WorkflowDto>(created).draftVersion?.id ?? '';
    const stage = await post(subject, `/workflow-versions/${draftId}/stages`, {
      key: 'ESTUDOS_PRELIMINARES',
      name: 'Estudos preliminares',
      type: 'TASK',
    });
    expect(stage.status, JSON.stringify(stage.body)).toBe(201);
    const stageId = data<WorkflowStageDto>(stage).id;
    const rule = await post(subject, `/workflow-versions/${draftId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId,
      type: 'REQUIRED_FIELD',
      name: 'Ano informado',
      config: { field: 'process.year' },
      message: 'Informe o ano do processo.',
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    return { draftId, stageId, rule: data<WorkflowRuleDto>(rule) };
  };

  let draftA: Awaited<ReturnType<typeof draftWithRule>>;
  let draftB: Awaited<ReturnType<typeof draftWithRule>>;

  const testBody = (processId: string) => ({
    type: 'REQUIRED_DOCUMENT',
    config: { documentTypeCode: 'ETP', minStatus: 'EXISTS' },
    message: 'Anexe o ETP.',
    processId,
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
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_RUNTIME_READER, value: store },
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
    draftA = await draftWithRule('sub-carla', 'FASE_PREPARATORIA');
    draftB = await draftWithRule('sub-beto', 'FLUXO_LEAK_B');
    // O motor lê a versão FIXADA no processo; um rascunho não tem snapshot (sem passagens a casar).
    store.save(
      processRuntime({
        id: PROCESS_A,
        tenantId: A,
        workflowVersionId: draftA.draftId,
        passes: [],
        documents: [etp('DRAFT', false)],
      }),
    );
    store.save(
      processRuntime({ id: PROCESS_B, tenantId: B, workflowVersionId: draftB.draftId, passes: [] }),
    );
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] regra e versão de outro tenant → 404 sem revelar nada nem tocar na linha', async () => {
    for (const response of [
      await patch('sub-carla', `/workflow-rules/${draftB.rule.id}`, { name: 'Invasão' }, 1),
      await remove('sub-carla', `/workflow-rules/${draftB.rule.id}`, 1),
      await post('sub-carla', `/workflow-versions/${draftB.draftId}/rules`, {
        scope: 'STAGE_EXIT',
        stageId: draftB.stageId,
        type: 'REQUIRED_FIELD',
        name: 'Invasão',
        config: { field: 'process.year' },
        message: 'Mensagem de invasão.',
      }),
      await post(
        'sub-carla',
        `/workflow-versions/${draftB.draftId}/rules/test`,
        testBody(PROCESS_A),
      ),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemCode(response)).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    const [row] = await db.admin<Row>('SELECT name, version FROM workflow_rules WHERE id = $1', [
      draftB.rule.id,
    ]);
    expect(row).toEqual({ name: 'Ano informado', version: 1 });
    // A RLS: só as regras do próprio tenant no rascunho de A.
    expect(
      await db.admin<Row>('SELECT tenant_id FROM workflow_rules WHERE workflow_version_id = $1', [
        draftA.draftId,
      ]),
    ).toEqual([{ tenant_id: A }]);
  });

  it('[Tenant incorreto] testar regra com processo de outro tenant → 404 igual ao inexistente', async () => {
    const other = await post(
      'sub-carla',
      `/workflow-versions/${draftA.draftId}/rules/test`,
      testBody(PROCESS_B),
    );
    const missing = await post(
      'sub-carla',
      `/workflow-versions/${draftA.draftId}/rules/test`,
      testBody('0192c044-0000-7000-8000-0000000003ff'),
    );
    expect([other.status, missing.status]).toEqual([404, 404]);
    expect(problemDetailsSchema.parse(other.body).detail).toBe(
      problemDetailsSchema.parse(missing.body).detail,
    );
    expect(JSON.stringify(other.body)).not.toContain(PROCESS_B);
  });

  it('[Duplicidade] testar a mesma regra três vezes: mesmo resultado, sem regra, auditoria nem outbox', async () => {
    const before = {
      rules: await count('workflow_rules'),
      audits: await count('audit_logs'),
      events: await count('outbox_events'),
    };
    const results: WorkflowRuleTestResult[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(
        'sub-carla',
        `/workflow-versions/${draftA.draftId}/rules/test`,
        testBody(PROCESS_A),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      results.push(data<WorkflowRuleTestResult>(response));
    }
    expect(results[0]).toMatchObject({ satisfied: true, message: 'Regra satisfeita.' });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(await count('workflow_rules')).toBe(before.rules);
    expect(await count('audit_logs')).toBe(before.audits);
    expect(await count('outbox_events')).toBe(before.events);
  });

  it('[Concorrência] dois PATCH simultâneos na mesma regra com o mesmo If-Match: um 200, outro 412', async () => {
    const [carla, diego] = await Promise.all([
      patch('sub-carla', `/workflow-rules/${draftA.rule.id}`, { severity: 'WARNING' }, 1),
      patch('sub-diego', `/workflow-rules/${draftA.rule.id}`, { name: 'Ano do processo' }, 1),
    ]);
    expect([carla.status, diego.status].sort()).toEqual([200, 412]);
    expect(problemCode(carla.status === 412 ? carla : diego)).toBe('VERSION_CONFLICT');
    const [row] = await db.admin<Row>('SELECT version FROM workflow_rules WHERE id = $1', [
      draftA.rule.id,
    ]);
    expect(row?.version).toBe(2);
  });

  it('RN-WF-56: REQUIRED_FIELD com caminho fora do schema é gravado no rascunho', async () => {
    const response = await post('sub-carla', `/workflow-versions/${draftA.draftId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: draftA.stageId,
      type: 'REQUIRED_FIELD',
      name: 'Campo colado',
      config: { field: 'process.codigoInterno' },
      message: 'Preencha o código interno.',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [row] = await db.admin<Row>('SELECT config FROM workflow_rules WHERE id = $1', [
      data<WorkflowRuleDto>(response).id,
    ]);
    expect(row?.config).toEqual({ field: 'process.codigoInterno' });
  });
});

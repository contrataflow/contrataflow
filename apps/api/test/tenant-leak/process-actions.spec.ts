// Motor de execução (US-041) sobre PostgreSQL real: PRC-08/PRC-09 leem o grafo PUBLICADO do
// workflow padrão (DEC-015) do banco — snapshot da versão fixada, sob a RLS do tenant — nas 7
// etapas; processo de outro tenant responde 404 sem revelar nada; a RLS de workflow_versions/
// workflow_rules impede ler a definição de B mesmo com o id em mãos; as consultas não gravam
// auditoria nem outbox. O agregado `Process` nasce na US-001: o runtime vem do store em memória
// (a porta `PROCESS_RUNTIME_READER`); identidade, unidades, workflow e transação são os reais.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import type { ActionEntry, ProcessChecklist, ProcessStatus } from '@contrataflow/validation';
import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { PROCESS_RUNTIME_READER } from '#modules/process/application/ports.js';
import type { ProcessStagePass } from '#modules/process/domain/process-runtime.js';
import { InMemoryProcessRuntimeStore } from '#modules/process/infrastructure/process-runtime.readers.js';
import {
  buildWorkflowSnapshot,
  workflowSnapshotHash,
} from '#modules/workflow/domain/workflow-snapshot.js';
import { PrismaWorkflowRepository } from '#modules/workflow/infrastructure/prisma-workflow.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import {
  dec015Workflow,
  etp,
  pass,
  processRuntime,
  RISK_MAP_MESSAGE,
} from '../support/workflow-engine-fixtures.js';
import { DefinitionBuilder, replaceAt } from '../support/workflow-fixtures.js';

const A = '0192c000-0000-7000-8000-00000000041a';
const B = '0192c000-0000-7000-8000-00000000041b';
const LUCIA = '0192c000-0000-7000-8000-0000000041a1';
const ANA = '0192c000-0000-7000-8000-0000000041a2';
const HEITOR = '0192c000-0000-7000-8000-0000000041b1';
const VERSION_A = '0192c000-0000-7000-8000-0000000042a1';
const VERSION_B = '0192c000-0000-7000-8000-0000000042b1';
const WORKFLOW_A = '0192c000-0000-7000-8000-0000000046a1';
const WORKFLOW_B = '0192c000-0000-7000-8000-0000000046b1';
const PROCESS_A = '0192c000-0000-7000-8000-0000000043a1';
const PROCESS_B = '0192c000-0000-7000-8000-0000000043b1';
const FORGED = '0192c000-0000-7000-8000-0000000043a9';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [ANA]: ['REQUISITANTE'],
  [HEITOR]: ['GESTOR_CONTRATACOES'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'prefeitura-sao-jose-us041', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us041', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${LUCIA}', 'sub-lucia', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${ANA}', 'sub-ana', 'ana@a.test', true, 'Ana Souza'),
  ('${HEITOR}', 'sub-heitor', 'heitor@b.test', true, 'Heitor LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000044a1', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000044a2', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000044b1', '${B}', '${HEITOR}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (perfis como registro: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

/** DEC-015 sem unidade fixa (a etapa de Compras usaria uma unidade cadastrada). */
function workflowFor(versionId: string): DefinitionBuilder {
  const builder = dec015Workflow(new DefinitionBuilder(versionId));
  const index = builder.stages.findIndex((stage) => stage.key === 'PESQUISA_PRECOS');
  replaceAt(builder.stages, index, {
    departmentResolution: 'REQUESTING_DEPARTMENT',
    fixedDepartmentId: null,
  });
  return builder;
}

const STAGE_ORDER = [
  'ABERTURA',
  'APROVACAO_DFD',
  'ESTUDOS_PRELIMINARES',
  'PESQUISA_PRECOS',
  'TERMO_REFERENCIA',
  'APROVACAO_AUTORIDADE',
  'CONCLUSAO',
] as const;

const STATUS_AT: Readonly<Record<(typeof STAGE_ORDER)[number], ProcessStatus>> = {
  ABERTURA: 'DRAFT',
  APROVACAO_DFD: 'AWAITING_APPROVAL',
  ESTUDOS_PRELIMINARES: 'IN_PROGRESS',
  PESQUISA_PRECOS: 'IN_PROGRESS',
  TERMO_REFERENCIA: 'IN_PROGRESS',
  APROVACAO_AUTORIDADE: 'AWAITING_APPROVAL',
  CONCLUSAO: 'COMPLETED',
};

/** Ações de tramitação esperadas em cada etapa do workflow padrão (passagens anteriores concluídas). */
const EXPECTED: Readonly<Record<(typeof STAGE_ORDER)[number], readonly string[]>> = {
  // Sem DFD no processo: a regra "DFD completo" bloqueia o envio.
  ABERTURA: ['FORWARD→APROVACAO_DFD:off'],
  APROVACAO_DFD: ['RETURN→ABERTURA:off'],
  ESTUDOS_PRELIMINARES: ['FORWARD→PESQUISA_PRECOS:on', 'RETURN→ABERTURA:on'],
  PESQUISA_PRECOS: [
    'FORWARD→TERMO_REFERENCIA:off',
    'RETURN→ESTUDOS_PRELIMINARES:on',
    'RETURN→ABERTURA:on',
  ],
  TERMO_REFERENCIA: ['FORWARD→APROVACAO_AUTORIDADE:off', 'RETURN→PESQUISA_PRECOS:on'],
  APROVACAO_AUTORIDADE: ['RETURN→TERMO_REFERENCIA:off'],
  CONCLUSAO: [],
};

describe('Feature: motor de execução sobre PostgreSQL e isolado por tenant (US-041)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const store = new InMemoryProcessRuntimeStore();
  const builderA = workflowFor(VERSION_A);
  const builderB = workflowFor(VERSION_B);

  const tenantOf = (subject: string) => (subject === 'sub-heitor' ? B : A);
  const get = (subject: string, path: string) =>
    request(api.server)
      .get(`/api/v1${path}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

  /** Publica a versão pelos repositórios reais (rascunho → definição → snapshot + hash). */
  async function seedPublished(tenantId: string, builder: DefinitionBuilder, workflowId: string) {
    const now = new Date('2026-10-01T12:00:00.000Z');
    const control = {
      tenantId,
      createdAt: now,
      updatedAt: now,
      createdById: null,
      updatedById: null,
      version: 1,
    };
    const definition = builder.build();
    const owned = {
      stages: definition.stages.map((stage) => ({ ...stage, tenantId })),
      transitions: definition.transitions.map((transition) => ({ ...transition, tenantId })),
      rules: definition.rules.map((rule) => ({ ...rule, tenantId })),
    };
    const snapshot = buildWorkflowSnapshot(owned);
    const repository = api.app.get(PrismaWorkflowRepository);
    await runAsSystem({ name: 'test.seed', tenantId }, () =>
      api.app.get(TenantTransaction).run(async (tx) => {
        await repository.insertWorkflow(tx, {
          ...control,
          id: workflowId,
          key: 'FASE_PREPARATORIA',
          name: 'Fase preparatória — Lei 14.133/2021',
          description: null,
          isActive: true,
          isDefault: true,
          applicabilityRule: null,
          applicabilityPriority: 0,
          currentPublishedVersionId: null,
        });
        await repository.insertVersion(tx, {
          ...control,
          id: builder.versionId,
          workflowId,
          versionNumber: 1,
          status: 'DRAFT',
          initialStageId: null,
          changeNotes: null,
          publishedAt: null,
          publishedById: null,
          retiredAt: null,
          retiredById: null,
          definitionSnapshot: null,
          definitionHash: null,
        });
        await repository.insertDefinition(tx, owned);
        await repository.publishVersion(tx, {
          id: builder.versionId,
          initialStageId: builder.stageId('ABERTURA'),
          changeNotes: null,
          snapshot,
          hash: workflowSnapshotHash(snapshot),
          publishedAt: now,
          publishedById: null,
        });
        await repository.setCurrentPublished(tx, workflowId, builder.versionId, {
          now,
          userId: null,
        });
      }),
    );
  }

  /** Passagens até `key` (anteriores concluídas, a etapa `key` ativa). */
  function passesUntil(builder: DefinitionBuilder, key: (typeof STAGE_ORDER)[number]) {
    const until = STAGE_ORDER.indexOf(key);
    return STAGE_ORDER.slice(0, until + 1).map((stageKey, index): ProcessStagePass =>
      pass(
        builder,
        stageKey,
        index + 1,
        index === until ? { status: 'ACTIVE', exitedAt: null } : {},
      ),
    );
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
    await seedPublished(A, builderA, WORKFLOW_A);
    await seedPublished(B, builderB, WORKFLOW_B);
    store.save(
      processRuntime({
        id: PROCESS_A,
        tenantId: A,
        workflowVersionId: VERSION_A,
        passes: passesUntil(builderA, 'ESTUDOS_PRELIMINARES'),
        currentResponsibleId: LUCIA,
        documents: [etp('DRAFT', true)],
      }),
    );
    store.save(
      processRuntime({
        id: PROCESS_B,
        tenantId: B,
        workflowVersionId: VERSION_B,
        passes: passesUntil(builderB, 'ESTUDOS_PRELIMINARES'),
        currentResponsibleId: HEITOR,
      }),
    );
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] lê o grafo publicado do banco: FORWARD habilitado e o aviso no checklist', async () => {
    const actions = await get('sub-lucia', `/processes/${PROCESS_A}/available-actions`);
    expect(actions.status, JSON.stringify(actions.body)).toBe(200);
    expect(data<ActionEntry[]>(actions)[0]).toMatchObject({
      action: 'FORWARD',
      toStageKey: 'PESQUISA_PRECOS',
      enabled: true,
      departmentResolution: { mode: 'REQUESTING_DEPARTMENT' },
    });
    const checklist = await get('sub-lucia', `/processes/${PROCESS_A}/checklist`);
    expect(data<ProcessChecklist>(checklist).violations).toEqual([
      expect.objectContaining({ severity: 'WARNING', message: RISK_MAP_MESSAGE }),
    ]);
  });

  it('workflow padrão (DEC-015): botões de tramitação corretos em cada uma das 7 etapas', async () => {
    for (const key of STAGE_ORDER) {
      const id = `0192c000-0000-7000-8000-0000000045${String(STAGE_ORDER.indexOf(key)).padStart(2, '0')}`;
      store.save(
        processRuntime({
          id,
          tenantId: A,
          workflowVersionId: VERSION_A,
          status: STATUS_AT[key],
          passes: passesUntil(builderA, key),
          currentResponsibleId: LUCIA,
          documents: [etp('DRAFT', true)],
        }),
      );
      const response = await get('sub-lucia', `/processes/${id}/available-actions`);
      expect(response.status, `${key}: ${JSON.stringify(response.body)}`).toBe(200);
      const routing = data<ActionEntry[]>(response)
        .filter((entry) => ['FORWARD', 'COMPLETE', 'RETURN'].includes(entry.action))
        .map(
          (entry) => `${entry.action}→${entry.toStageKey ?? ''}:${entry.enabled ? 'on' : 'off'}`,
        );
      expect(routing, key).toEqual(EXPECTED[key]);
    }
  });

  it('[Tenant incorreto] processo de B → 404 para A sem revelar nada; B lê o próprio', async () => {
    const leaked = await get('sub-lucia', `/processes/${PROCESS_B}/available-actions`);
    expect(leaked.status).toBe(404);
    expect(problemCode(leaked)).toBe('NOT_FOUND');
    expect(JSON.stringify(leaked.body)).not.toMatch(/LEAK-B|ESTUDOS|PESQUISA/);
    expect((await get('sub-lucia', `/processes/${PROCESS_B}/checklist`)).status).toBe(404);
    expect((await get('sub-heitor', `/processes/${PROCESS_B}/available-actions`)).status).toBe(200);
  });

  it('[Permissão] REQUISITANTE sem lotação nas unidades do processo → 404 (lotações e chefias lidas do banco)', async () => {
    const response = await get('sub-ana', `/processes/${PROCESS_A}/available-actions`);
    expect(response.status).toBe(404);
    expect(problemCode(response)).toBe('NOT_FOUND');
  });

  it('RLS: com o id da versão de B em mãos, A não lê a definição nem as regras de B', async () => {
    store.save(
      processRuntime({
        id: FORGED,
        tenantId: A,
        workflowVersionId: VERSION_B,
        passes: passesUntil(builderB, 'ESTUDOS_PRELIMINARES'),
        currentResponsibleId: LUCIA,
      }),
    );
    const response = await get('sub-lucia', `/processes/${FORGED}/available-actions`);
    expect(response.status).toBe(500);
    expect(problemCode(response)).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toMatch(/LEAK-B|ESTUDOS|PESQUISA|RISK_MAP/);

    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT DISTINCT tenant_id FROM workflow_rules
          UNION SELECT tenant_id FROM workflow_versions WHERE id = ${VERSION_B}::uuid`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
  });

  it('[Duplicidade] consultas não gravam auditoria nem outbox', async () => {
    const count = async (table: string) =>
      (await db.admin<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]?.n;
    const audits = await count('audit_logs');
    const events = await count('outbox_events');
    const first = await get('sub-lucia', `/processes/${PROCESS_A}/available-actions`);
    const second = await get('sub-lucia', `/processes/${PROCESS_A}/available-actions`);
    expect(second.body).toEqual(first.body);
    expect(await count('audit_logs')).toBe(audits);
    expect(await count('outbox_events')).toBe(events);
  });
});

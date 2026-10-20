// Definição de workflow versionada na API inteira sobre PostgreSQL real (US-040 · Sucesso,
// Tenant incorreto, Concorrência, Falha de banco): administradores nos tenants A e B, auditoria e
// outbox reais na mesma transação, RLS das 5 tabelas, FKs compostas com a versão, índice parcial
// de rascunho único, gatilhos de imutabilidade por SQL direto do papel da aplicação, publicação
// atômica (falha induzida depois do hash) e a serialização edição × publicação pela trava da
// versão. Perfis ainda não existem como registro (US-096): o vínculo ganha `roleKeys` por uma
// porta de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { WorkflowDefinitionService } from '#modules/workflow/application/workflow-definition.service.js';
import { WorkflowFacade } from '#modules/workflow/application/workflow.facade.js';
import { PrismaWorkflowRepository } from '#modules/workflow/infrastructure/prisma-workflow.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { DocumentTypeUsageRegistry } from '#shared/document/document-type-usage.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000040a';
const B = '0192c000-0000-7000-8000-00000000040b';
const MARTA = '0192c000-0000-7000-8000-0000000040a1';
const OTAVIO = '0192c000-0000-7000-8000-0000000040a2';
const FABIO = '0192c000-0000-7000-8000-0000000040a3';
const BETO = '0192c000-0000-7000-8000-0000000040b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [OTAVIO]: ['ADMIN_ORGAO'],
  // Só WORKFLOW_VIEW (permissions.md §3.2).
  [FABIO]: ['COMPRAS'],
  [BETO]: ['ADMIN_ORGAO'],
};

const docType = (id: string, tenant: string, code: string) =>
  `('${id}', '${tenant}', '${code}', '${code} LEAK-${tenant === B ? 'B' : 'A'}', 'FREE_TEXT')`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'prefeitura-a-wf', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${OTAVIO}', 'sub-otavio', 'otavio@a.test', true, 'Otávio Campos'),
  ('${FABIO}', 'sub-fabio', 'fabio@a.test', true, 'Fábio Nunes'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000041a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000041a2', '${A}', '${OTAVIO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000041a3', '${A}', '${FABIO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000041b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO document_types (id, tenant_id, code, name, kind) VALUES
  ${docType('0192c000-0000-7000-8000-0000000042a1', A, 'DFD')},
  ${docType('0192c000-0000-7000-8000-0000000042a2', A, 'ETP')},
  ${docType('0192c000-0000-7000-8000-0000000042a3', A, 'TR')},
  ${docType('0192c000-0000-7000-8000-0000000042b1', B, 'DFD')};
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (perfis como registro: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;
const TABLES = [
  'workflows',
  'workflow_versions',
  'workflow_stages',
  'workflow_transitions',
  'workflow_rules',
] as const;

describe('Feature: definição de workflow isolada por tenant sobre PostgreSQL (US-040)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string) => api.bearer(subject, { amr: MFA });
  const tenantOf = (subject: string) => (subject === 'sub-beto' ? B : A);
  const get = (subject: string, path: string) =>
    request(api.server)
      .get(`/api/v1${path}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenantOf(subject));
  const post = (subject: string, path: string, body: object) =>
    request(api.server)
      .post(`/api/v1${path}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const patch = (subject: string, path: string, body: object, version: number) =>
    request(api.server)
      .patch(`/api/v1${path}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('If-Match', `"${version}"`)
      .send(body);
  const remove = (subject: string, path: string, version: number) =>
    request(api.server)
      .delete(`/api/v1${path}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('If-Match', `"${version}"`);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

  const digestOf = async (tenantId: string) => {
    const digests = [];
    for (const table of TABLES) {
      const [row] = await db.admin<{ digest: string }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
           FROM ${table} t WHERE tenant_id = $1`,
        [tenantId],
      );
      digests.push(row?.digest);
    }
    return digests.join(':');
  };
  const versionRow = async (id: string) =>
    (
      await db.admin<Row>(
        `SELECT status, version, initial_stage_id, definition_snapshot, definition_hash, published_at
           FROM workflow_versions WHERE id = $1`,
        [id],
      )
    )[0];
  const audits = (tenantId: string, action: string) =>
    db.admin<Row>(
      `SELECT action, result, reason_code, entity_type, entity_id, metadata FROM audit_logs
        WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
      [tenantId, action],
    );
  const events = (tenantId: string, type: string) =>
    db.admin<Row>(
      `SELECT routing_key, status, payload FROM outbox_events
        WHERE tenant_id = $1 AND event_type = $2 ORDER BY occurred_at, id`,
      [tenantId, type],
    );

  const createWorkflow = async (subject: string, key: string) => {
    const response = await post(subject, '/workflows', { key, name: `Workflow ${key}` });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowDto>(response);
  };
  const addStage = async (subject: string, versionId: string, body: object) => {
    const response = await post(subject, `/workflow-versions/${versionId}/stages`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };
  const addTransition = async (versionId: string, body: object) => {
    const response = await post('sub-marta', `/workflow-versions/${versionId}/transitions`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowTransitionDto>(response);
  };
  const versionOf = async (versionId: string) =>
    data<WorkflowVersionDetailDto>(await get('sub-marta', `/workflow-versions/${versionId}`));

  /** ABERTURA → ANALISE → APROVACAO → FIM (4 etapas, 6 transições, 1 regra). */
  const buildValidDraft = async (versionId: string) => {
    const base = { instructions: 'Siga o roteiro.' };
    const abertura = await addStage('sub-marta', versionId, {
      ...base,
      key: 'ABERTURA',
      name: 'Abertura',
      type: 'START',
      documentTypeCodes: ['DFD'],
    });
    const analise = await addStage('sub-marta', versionId, {
      ...base,
      key: 'ANALISE',
      name: 'Análise',
      type: 'TASK',
      slaDays: 5,
    });
    const aprovacao = await addStage('sub-marta', versionId, {
      ...base,
      key: 'APROVACAO',
      name: 'Aprovação',
      type: 'APPROVAL',
      slaDays: 3,
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    });
    const fim = await addStage('sub-marta', versionId, { key: 'FIM', name: 'Fim', type: 'END' });
    const edge = (key: string, from: string, to: string, action: string) =>
      addTransition(versionId, { key, name: key, fromStageId: from, toStageId: to, action });
    await edge('ENVIAR_ANALISE', abertura.id, analise.id, 'FORWARD');
    await edge('ENVIAR_APROVACAO', analise.id, aprovacao.id, 'FORWARD');
    await edge('DEVOLVER_ABERTURA', analise.id, abertura.id, 'RETURN');
    await edge('APROVAR', aprovacao.id, fim.id, 'APPROVE');
    await edge('DEVOLVER_ANALISE', aprovacao.id, analise.id, 'RETURN');
    await edge('INDEFERIR', aprovacao.id, abertura.id, 'REJECT');
    const rule = await post('sub-marta', `/workflow-versions/${versionId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: abertura.id,
      type: 'REQUIRED_DOCUMENT',
      name: 'DFD completo',
      message: 'Conclua o DFD antes de seguir.',
      config: { documentTypeCode: 'DFD', minStatus: 'COMPLETE' },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    return { abertura, analise, aprovacao, fim };
  };

  const facade = () => api.app.get(WorkflowFacade, { strict: false });
  const publish = (versionId: string) =>
    runAsSystem({ name: 'test.publisher', tenantId: A }, () => facade().publish({ versionId }));

  let obras: WorkflowDto;
  let v1: string;
  let stages: Awaited<ReturnType<typeof buildValidDraft>>;

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
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] cria, edita e publica: linhas só em A, auditoria, eventos PENDING e hash reprodutível no banco', async () => {
    const digestOfB = await digestOf(B);
    obras = await createWorkflow('sub-marta', 'OBRAS_ENGENHARIA');
    v1 = obras.draftVersion?.id ?? '';
    stages = await buildValidDraft(v1);
    expect(await versionRow(v1)).toMatchObject({
      status: 'DRAFT',
      initial_stage_id: stages.abertura.id,
      // 1 + 4 etapas + 6 transições + 1 regra (RN-WF-06).
      version: 12,
    });

    const result = await publish(v1);

    const row = await versionRow(v1);
    expect(row).toMatchObject({ status: 'PUBLISHED', definition_hash: result.definitionHash });
    // O jsonb reordena as chaves; o JCS recompõe a forma canônica e o hash bate.
    expect(sha256Hex(canonicalJson(row?.definition_snapshot))).toBe(row?.definition_hash);
    const [workflow] = await db.admin<Row>(
      'SELECT current_published_version_id FROM workflows WHERE id = $1',
      [obras.id],
    );
    expect(workflow?.current_published_version_id).toBe(v1);
    expect(await audits(A, 'workflow.create')).toHaveLength(1);
    expect(await audits(A, 'workflow.version_publish')).toEqual([
      expect.objectContaining({ entity_id: v1, result: 'SUCCESS' }),
    ]);
    expect((await audits(A, 'workflow.update')).length).toBe(11);
    expect(await events(A, 'WorkflowCreated')).toEqual([
      expect.objectContaining({ routing_key: 'workflow.created', status: 'PENDING' }),
    ]);
    expect(await events(A, 'WorkflowVersionPublished')).toEqual([
      expect.objectContaining({
        routing_key: 'workflow.version_published',
        payload: expect.objectContaining({ workflowVersionId: v1, versionNumber: 1 }) as unknown,
      }),
    ]);
    expect(await digestOf(B)).toBe(digestOfB);

    // WF-09 da publicada vem do snapshot; o uso do DFD (RN-DOC-09) lê as tabelas reais.
    expect((await versionOf(v1)).stages.map((stage) => stage.key)).toEqual([
      'ABERTURA',
      'ANALISE',
      'APROVACAO',
      'FIM',
    ]);
    const usage = await runAsSystem({ name: 'test', tenantId: A }, () =>
      api.app
        .get(TenantTransaction)
        .read((tx) => api.app.get(DocumentTypeUsageRegistry).usageOf(tx, 'DFD')),
    );
    expect(usage).toEqual({
      blockingRules: [{ workflowName: 'Workflow OBRAS_ENGENHARIA', stageName: 'Abertura' }],
      referencingWorkflows: 1,
    });
  });

  it('[Falha de banco] gatilhos: o papel da aplicação não altera etapa, transição, regra nem o hash da versão publicada', async () => {
    const app = db.client('cf_app');
    const before = await digestOf(A);
    const attempts: (() => Promise<unknown>)[] = [
      () =>
        asTenant(A, () =>
          app.$tenantTransaction(
            (tx) =>
              tx.$executeRaw`UPDATE workflow_stages SET name = 'Invasão' WHERE id = ${stages.analise.id}::uuid`,
          ),
        ),
      () =>
        asTenant(A, () =>
          app.$tenantTransaction(
            (tx) =>
              tx.$executeRaw`UPDATE workflow_versions SET definition_hash = ${'0'.repeat(64)} WHERE id = ${v1}::uuid`,
          ),
        ),
      () =>
        asTenant(A, () =>
          app.$tenantTransaction((tx) =>
            tx.workflowTransition.deleteMany({ where: { workflowVersionId: v1 } }),
          ),
        ),
      () =>
        asTenant(A, () =>
          app.$tenantTransaction((tx) =>
            tx.workflowRule.updateMany({
              where: { workflowVersionId: v1 },
              data: { isActive: false },
            }),
          ),
        ),
      () =>
        asTenant(A, () =>
          app.$tenantTransaction((tx) => tx.workflowVersion.deleteMany({ where: { id: v1 } })),
        ),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toSatisfy((error: unknown) =>
        /cf_wf_version_not_draft|cf_wf_version_immutable/.test(String(error)),
      );
    }
    // Nem o superusuário escapa dos gatilhos.
    await expect(
      db.admin(`INSERT INTO workflow_stages (id, tenant_id, workflow_version_id, key, name, type,
                  display_order, department_resolution)
                VALUES ('${randomUUID()}', '${A}', '${v1}', 'NOVA', 'Nova', 'TASK', 9, 'REQUESTING_DEPARTMENT')`),
    ).rejects.toThrow(/cf_wf_version_not_draft/);
    await expect(
      db.admin(`UPDATE workflow_versions SET status = 'DRAFT' WHERE id = '${v1}'`),
    ).rejects.toThrow(/cf_wf_version_immutable/);
    await expect(
      db.admin(`UPDATE workflows SET key = 'OUTRA' WHERE id = '${obras.id}'`),
    ).rejects.toThrow(/imutáveis/);
    expect(await digestOf(A)).toBe(before);
    // A API devolve 409 antes de chegar ao banco (FA-06).
    const response = await patch(
      'sub-marta',
      `/workflow-stages/${stages.analise.id}`,
      { name: 'Invasão' },
      1,
    );
    expect(response.status).toBe(409);
    expect(problemCode(response)).toBe('WORKFLOW_VERSION_NOT_DRAFT');
  });

  it('[Banco] FK composta impede transição entre versões; índice parcial impede dois rascunhos', async () => {
    const draft = data<WorkflowVersionDetailDto>(
      await post('sub-marta', `/workflows/${obras.id}/versions`, {}),
    );
    expect(draft).toMatchObject({ versionNumber: 2, status: 'DRAFT' });
    const draftStage = draft.stages[0] as WorkflowStageDto;
    // Destino é etapa da v1 (mesmo tenant, outra versão).
    await expect(
      db.admin(`INSERT INTO workflow_transitions (id, tenant_id, workflow_version_id, key, name,
                  from_stage_id, to_stage_id, action)
                VALUES ('${randomUUID()}', '${A}', '${draft.id}', 'CRUZADA', 'Cruzada',
                        '${draftStage.id}', '${stages.fim.id}', 'COMPLETE')`),
    ).rejects.toThrow(/workflow_transitions_to_stage_fkey/);
    await expect(
      db.admin(`INSERT INTO workflow_versions (id, tenant_id, workflow_id, version_number)
                VALUES ('${randomUUID()}', '${A}', '${obras.id}', 3)`),
    ).rejects.toThrow(/workflow_versions_single_draft_key/);
    // A API traduz o mesmo caso em 409 WORKFLOW_DRAFT_EXISTS com o rascunho existente.
    const second = await post('sub-marta', `/workflows/${obras.id}/versions`, {});
    expect(second.status).toBe(409);
    expect(problemDetailsSchema.parse(second.body)).toMatchObject({
      code: 'WORKFLOW_DRAFT_EXISTS',
      meta: { draftVersionId: draft.id },
    });
  });

  it('[Tenant incorreto] ids de B → 404; etapa de B como destino → 422 REFERENCE_NOT_FOUND; RLS limita as 5 tabelas', async () => {
    const other = await createWorkflow('sub-beto', 'FLUXO_B');
    const otherVersion = other.draftVersion?.id ?? '';
    const otherStage = await addStage('sub-beto', otherVersion, {
      key: 'ETAPA_B',
      name: 'Etapa LEAK-B',
      type: 'TASK',
      documentTypeCodes: ['DFD'],
    });
    const digestOfB = await digestOf(B);

    for (const response of [
      await get('sub-marta', `/workflow-versions/${otherVersion}`),
      await get('sub-marta', `/workflows/${other.id}`),
      await get('sub-marta', `/workflows/${other.id}/versions`),
      await patch('sub-marta', `/workflows/${other.id}`, { name: 'Invasão' }, 1),
      await post('sub-marta', `/workflows/${other.id}/versions`, {}),
      await patch('sub-marta', `/workflow-stages/${otherStage.id}`, { name: 'Invasão' }, 1),
      await remove('sub-marta', `/workflow-stages/${otherStage.id}`, 1),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemCode(response)).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }

    const draft = (
      await db.admin<Row>(
        `SELECT id FROM workflow_versions WHERE workflow_id = $1 AND status = 'DRAFT'`,
        [obras.id],
      )
    )[0]?.id as string;
    const mine = await versionOf(draft);
    const cross = await post('sub-marta', `/workflow-versions/${draft}/transitions`, {
      key: 'PARA_B',
      name: 'Para B',
      fromStageId: mine.stages[0]?.id,
      toStageId: otherStage.id,
      action: 'FORWARD',
    });
    expect(cross.status).toBe(422);
    expect(problemDetailsSchema.parse(cross.body).errors).toEqual([
      expect.objectContaining({ field: 'toStageId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expect(await digestOf(B)).toBe(digestOfB);

    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT tenant_id FROM workflows UNION SELECT tenant_id FROM workflow_versions
          UNION SELECT tenant_id FROM workflow_stages UNION SELECT tenant_id FROM workflow_transitions
          UNION SELECT tenant_id FROM workflow_rules`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
  });

  it('[Permissão] COMPRAS lê (200) e não escreve (403 + access.denied WORKFLOW_MANAGE)', async () => {
    expect((await get('sub-fabio', `/workflow-versions/${v1}`)).status).toBe(200);
    const denied = await post('sub-fabio', `/workflow-versions/${v1}/stages`, {
      key: 'NEGADA',
      name: 'Negada',
      type: 'TASK',
    });
    expect(denied.status).toBe(403);
    expect(problemCode(denied)).toBe('PERMISSION_DENIED');
    expect(await audits(A, 'access.denied')).toEqual([
      expect.objectContaining({ reason_code: 'WORKFLOW_MANAGE', result: 'DENIED' }),
    ]);
  });

  it('[Concorrência] dois PATCH com o mesmo If-Match: um 200 e o outro 412 VERSION_CONFLICT', async () => {
    const draft = (
      await db.admin<Row>(
        `SELECT id FROM workflow_versions WHERE workflow_id = $1 AND status = 'DRAFT'`,
        [obras.id],
      )
    )[0]?.id as string;
    const analise = (await versionOf(draft)).stages.find((stage) => stage.key === 'ANALISE');
    const version = analise?.version ?? 1;
    const results = await Promise.all([
      patch('sub-marta', `/workflow-stages/${analise?.id ?? ''}`, { slaDays: 10 }, version),
      patch(
        'sub-otavio',
        `/workflow-stages/${analise?.id ?? ''}`,
        { name: 'Análise técnica' },
        version,
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const loser = results.find((result) => result.status === 412);
    expect(problemCode(loser as request.Response)).toBe('VERSION_CONFLICT');
  });

  it('[Concorrência] edição concorrente com a publicação: a exclusão espera a trava e recebe 409; o snapshot tem a transição', async () => {
    const draft = (
      await db.admin<Row>(
        `SELECT id FROM workflow_versions WHERE workflow_id = $1 AND status = 'DRAFT'`,
        [obras.id],
      )
    )[0]?.id as string;
    const detail = await versionOf(draft);
    const target = detail.transitions.find((transition) => transition.key === 'APROVAR');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = api.app.get(WorkflowDefinitionService, { strict: false });
    const validateIn = service.validateIn.bind(service);
    const spy = vi.spyOn(service, 'validateIn').mockImplementation(async (...args) => {
      // A versão já está travada (FOR UPDATE) pelo publicador quando a validação começa.
      await gate;
      return validateIn(...args);
    });
    try {
      const publishing = publish(draft);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const deleting = remove(
        'sub-otavio',
        `/workflow-transitions/${target?.id ?? ''}`,
        target?.version ?? 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [published, deleted] = await Promise.all([publishing, deleting]);
      expect(published.workflowVersionId).toBe(draft);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
      expect(problemCode(deleted)).toBe('WORKFLOW_VERSION_NOT_DRAFT');
    } finally {
      spy.mockRestore();
    }
    const snapshot = (await versionRow(draft))?.definition_snapshot as {
      transitions: { key: string }[];
    };
    expect(snapshot.transitions.map((transition) => transition.key)).toContain('APROVAR');
    // A v1 foi supersedida pela v2 (RN-WF-20).
    expect((await versionRow(v1))?.status).toBe('RETIRED');
    expect(await events(A, 'WorkflowVersionRetired')).toHaveLength(1);
  });

  it('[Falha de banco] publicação atômica: falha induzida depois do hash → nada muda', async () => {
    const draft = data<WorkflowVersionDetailDto>(
      await post('sub-marta', `/workflows/${obras.id}/versions`, {}),
    );
    const before = await digestOf(A);
    const publishedEvents = (await events(A, 'WorkflowVersionPublished')).length;
    const spy = vi
      .spyOn(PrismaWorkflowRepository.prototype, 'setCurrentPublished')
      .mockRejectedValue(new Error('falha induzida'));
    try {
      await expect(publish(draft.id)).rejects.toThrow('falha induzida');
    } finally {
      spy.mockRestore();
    }
    expect(await digestOf(A)).toBe(before);
    expect(await versionRow(draft.id)).toMatchObject({ status: 'DRAFT', definition_hash: null });
    expect(await events(A, 'WorkflowVersionPublished')).toHaveLength(publishedEvents);
  });

  it('[Falha de banco] banco indisponível ao criar workflow → 503 com Retry-After', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await post('sub-marta', '/workflows', { key: 'SEM_BANCO', name: 'Sem banco' });
    expect(response.status).toBe(503);
    expect(problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});

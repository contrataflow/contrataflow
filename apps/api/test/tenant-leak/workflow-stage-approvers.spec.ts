// Aprovadores ordenados da etapa sobre PostgreSQL real (US-132 · WF-65 · DEC-193 · M2-04):
// substituição atômica com `sequence` 1..n e espelho da linha 1, corrida real com o mesmo If-Match
// (um 200, outro 412 e a lista do vencedor), etapa e aprovador de outro tenant (404/422 sem tocar
// em nada de B), RLS de `workflow_stage_approvers`, FK composta com a etapa da mesma versão, checks
// de tipo × coluna, gatilho de imutabilidade depois da publicação e a cópia (WF-08) com ids novos.
// `pnpm --filter @contrataflow/api exec vitest run --config vitest.integration.config.ts test/tenant-leak/workflow-stage-approvers.spec.ts`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c132-0000-7000-8000-00000000000a';
const B = '0192c132-0000-7000-8000-00000000000b';
const CARLA = '0192c132-0000-7000-8000-0000000000a1';
const DIEGO = '0192c132-0000-7000-8000-0000000000a2';
const MARCOS = '0192c132-0000-7000-8000-0000000000a3';
const ROBERTO = '0192c132-0000-7000-8000-0000000000a4';
const BETO = '0192c132-0000-7000-8000-0000000000b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['ADMIN_ORGAO'],
  [DIEGO]: ['ADMIN_ORGAO'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'prefeitura-a-wf-approvers', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf-approvers', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Mendes'),
  ('${DIEGO}', 'sub-diego', 'diego@a.test', true, 'Diego Alves'),
  ('${MARCOS}', 'sub-marcos', 'marcos@a.test', true, 'Marcos Procurador'),
  ('${ROBERTO}', 'sub-roberto', 'roberto@a.test', true, 'Roberto Secretário'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c132-0000-7000-8000-0000000001a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c132-0000-7000-8000-0000000001a2', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c132-0000-7000-8000-0000000001a3', '${A}', '${MARCOS}', 'INTERNAL', 'ACTIVE'),
  ('0192c132-0000-7000-8000-0000000001a4', '${A}', '${ROBERTO}', 'INTERNAL', 'ACTIVE'),
  ('0192c132-0000-7000-8000-0000000001b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
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

const userLine = (userId: string) => ({ approverType: 'USER', approverUserId: userId });
const requestingHead = {
  approverType: 'DEPARTMENT_HEAD',
  approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
  label: 'Secretário da pasta',
};

describe('Feature: aprovadores ordenados da etapa isolados por tenant sobre PostgreSQL (US-132)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const tenantOf = (subject: string) => (subject === 'sub-beto' ? B : A);
  const as = (test: request.Test, subject: string) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const get = (subject: string, path: string) =>
    as(request(api.server).get(`/api/v1${path}`), subject);
  const post = (subject: string, path: string, body: object) =>
    as(request(api.server).post(`/api/v1${path}`), subject)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const put = (subject: string, stageId: string, body: object, version: number) =>
    as(request(api.server).put(`/api/v1/workflow-stages/${stageId}/approvers`), subject)
      .set('If-Match', `"${version}"`)
      .send(body);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

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
  const linesOf = (stageId: string) =>
    db.admin<Row>(
      `SELECT sequence, approver_type, approver_user_id, workflow_version_id, label, tenant_id
         FROM workflow_stage_approvers WHERE workflow_stage_id = $1 ORDER BY sequence`,
      [stageId],
    );

  /** START → APPROVAL (aprovador único do MVP 1) → END, publicável. */
  const buildFlow = async (subject: string, versionId: string) => {
    const abertura = await addStage(subject, versionId, {
      key: 'ABERTURA',
      name: 'Abertura',
      type: 'START',
    });
    const autorizacao = await addStage(subject, versionId, {
      key: 'AUTORIZACAO_LICITACAO',
      name: 'Autorização da licitação',
      type: 'APPROVAL',
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    });
    const fim = await addStage(subject, versionId, { key: 'FIM', name: 'Fim', type: 'END' });
    for (const [key, from, to, action] of [
      ['ENVIAR', abertura.id, autorizacao.id, 'FORWARD'],
      ['AUTORIZAR', autorizacao.id, fim.id, 'APPROVE'],
      ['DEVOLVER', autorizacao.id, abertura.id, 'RETURN'],
      ['INDEFERIR', autorizacao.id, abertura.id, 'REJECT'],
    ] as const) {
      const response = await post(subject, `/workflow-versions/${versionId}/transitions`, {
        key,
        name: key,
        fromStageId: from,
        toStageId: to,
        action,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    return autorizacao;
  };

  let fase: WorkflowDto;
  let draftId: string;
  let autorizacao: WorkflowStageDto;

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
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] etapa existente sem configuração: ANY, sem linhas (M2-04 sem backfill)', async () => {
    fase = await createWorkflow('sub-carla', 'FASE_PREPARATORIA');
    draftId = fase.draftVersion?.id ?? '';
    autorizacao = await buildFlow('sub-carla', draftId);
    const [stage] = await db.admin<Row>(
      `SELECT decision_policy, decision_policy_rules FROM workflow_stages WHERE id = $1`,
      [autorizacao.id],
    );
    expect(stage).toEqual({ decision_policy: 'ANY', decision_policy_rules: [] });
    expect(await linesOf(autorizacao.id)).toEqual([]);
  });

  it('[Sucesso] WF-65 grava as linhas 1..n, espelha a linha 1 e incrementa etapa e versão na mesma transação', async () => {
    const [before] = await db.admin<Row>('SELECT version FROM workflow_versions WHERE id = $1', [
      draftId,
    ]);
    const response = await put(
      'sub-carla',
      autorizacao.id,
      { decisionPolicy: 'SEQUENTIAL', approvers: [userLine(MARCOS), requestingHead] },
      autorizacao.version ?? 1,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await linesOf(autorizacao.id)).toEqual([
      expect.objectContaining({
        sequence: 1,
        approver_type: 'USER',
        approver_user_id: MARCOS,
        workflow_version_id: draftId,
        tenant_id: A,
      }),
      expect.objectContaining({
        sequence: 2,
        approver_type: 'DEPARTMENT_HEAD',
        label: 'Secretário da pasta',
      }),
    ]);
    const [stage] = await db.admin<Row>(
      `SELECT decision_policy, approver_type, approver_user_id, approver_department_resolution, version
         FROM workflow_stages WHERE id = $1`,
      [autorizacao.id],
    );
    expect(stage).toEqual({
      decision_policy: 'SEQUENTIAL',
      approver_type: 'USER',
      approver_user_id: MARCOS,
      approver_department_resolution: null,
      version: (autorizacao.version ?? 1) + 1,
    });
    const [after] = await db.admin<Row>('SELECT version FROM workflow_versions WHERE id = $1', [
      draftId,
    ]);
    expect(after?.version).toBe(Number(before?.version) + 1);
    const [audit] = await db.admin<Row>(
      `SELECT metadata FROM audit_logs WHERE tenant_id = $1 AND action = 'workflow.update'
         AND entity_id = $2 ORDER BY occurred_at DESC LIMIT 1`,
      [A, autorizacao.id],
    );
    expect(audit?.metadata).toMatchObject({ decisionPolicy: 'SEQUENTIAL', approversCount: 2 });
    autorizacao = { ...autorizacao, version: (autorizacao.version ?? 1) + 1 };
  });

  it('[Concorrência] dois PUT simultâneos com o mesmo If-Match: um 200, outro 412, e só a lista do vencedor fica', async () => {
    const etag = autorizacao.version ?? 1;
    const carlaBody = { decisionPolicy: 'ALL', approvers: [userLine(ROBERTO), userLine(MARCOS)] };
    const diegoBody = {
      decisionPolicy: 'SEQUENTIAL',
      approvers: [userLine(MARCOS), userLine(ROBERTO)],
    };
    const [carla, diego] = await Promise.all([
      put('sub-carla', autorizacao.id, carlaBody, etag),
      put('sub-diego', autorizacao.id, diegoBody, etag),
    ]);
    expect([carla.status, diego.status].sort()).toEqual([200, 412]);
    const loser = carla.status === 412 ? carla : diego;
    expect(problemCode(loser)).toBe('VERSION_CONFLICT');
    const winner = carla.status === 200 ? carlaBody : diegoBody;
    const lines = await linesOf(autorizacao.id);
    expect(lines.map((line) => line.approver_user_id)).toEqual(
      winner.approvers.map((line) => line.approverUserId),
    );
    expect(lines.map((line) => line.sequence)).toEqual([1, 2]);
    autorizacao = { ...autorizacao, version: etag + 1 };
  });

  it('[Tenant incorreto] etapa de B → 404 sem tocar nas linhas de B; usuário de B na linha → 422; RLS só mostra A', async () => {
    const other = await createWorkflow('sub-beto', 'FLUXO_B');
    const otherStage = await buildFlow('sub-beto', other.draftVersion?.id ?? '');
    const seeded = await put(
      'sub-beto',
      otherStage.id,
      { decisionPolicy: 'ANY', approvers: [userLine(BETO)] },
      otherStage.version ?? 1,
    );
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    const bLines = await linesOf(otherStage.id);

    const cross = await put(
      'sub-carla',
      otherStage.id,
      { decisionPolicy: 'ALL', approvers: [userLine(MARCOS), userLine(ROBERTO)] },
      (otherStage.version ?? 1) + 1,
    );
    expect(cross.status, JSON.stringify(cross.body)).toBe(404);
    expect(problemCode(cross)).toBe('NOT_FOUND');
    expect(JSON.stringify(cross.body)).not.toContain('LEAK-B');
    expect(await linesOf(otherStage.id)).toEqual(bLines);

    const foreign = await put(
      'sub-carla',
      autorizacao.id,
      { decisionPolicy: 'ALL', approvers: [userLine(BETO), userLine(MARCOS)] },
      autorizacao.version ?? 1,
    );
    expect(foreign.status).toBe(422);
    expect(problemDetailsSchema.parse(foreign.body).errors).toEqual([
      expect.objectContaining({
        field: 'approvers[0].approverUserId',
        code: 'REFERENCE_NOT_FOUND',
      }),
    ]);

    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT DISTINCT tenant_id FROM workflow_stage_approvers`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
    // A leitura do rascunho de B pela API de A também não existe.
    expect(
      (await get('sub-carla', `/workflow-versions/${other.draftVersion?.id ?? ''}`)).status,
    ).toBe(404);
  });

  it('[Banco] FK composta prende a linha à etapa da mesma versão; checks de tipo × coluna e de sequence', async () => {
    const insert = (versionId: string, extra: string) =>
      db.admin(`INSERT INTO workflow_stage_approvers (id, tenant_id, workflow_version_id,
                  workflow_stage_id, sequence, approver_type, approver_user_id)
                VALUES ('${randomUUID()}', '${A}', '${versionId}', '${autorizacao.id}', ${extra})`);
    const [otherVersion] = await db.admin<Row>(
      `SELECT id FROM workflow_versions WHERE tenant_id = $1 AND id <> $2 LIMIT 1`,
      [B, draftId],
    );
    await expect(insert(String(otherVersion?.id), `9, 'USER', '${MARCOS}'`)).rejects.toThrow(
      /workflow_stage_approvers_stage_fkey|cf_wf_definition_immutable/,
    );
    await expect(insert(draftId, `9, 'USER', NULL`)).rejects.toThrow(
      /workflow_stage_approvers_user_by_type/,
    );
    await expect(insert(draftId, `21, 'USER', '${MARCOS}'`)).rejects.toThrow(
      /workflow_stage_approvers_sequence_range/,
    );
    await expect(insert(draftId, `1, 'USER', '${ROBERTO}'`)).rejects.toThrow(
      /workflow_stage_approvers_sequence_key/,
    );
    await expect(
      db.admin(`UPDATE workflow_stages SET decision_policy = 'ALL'
                 WHERE workflow_version_id = '${draftId}' AND type = 'START'`),
    ).rejects.toThrow(/workflow_stages_decision_policy_only_in_approval/);
  });

  it('[Falha de banco] depois da publicação, gatilho barra qualquer escrita nas linhas; a API responde 409', async () => {
    const [version] = await db.admin<Row>('SELECT version FROM workflow_versions WHERE id = $1', [
      draftId,
    ]);
    const published = await as(
      request(api.server).post(`/api/v1/workflow-versions/${draftId}/publish`),
      'sub-carla',
    )
      .set('If-Match', `"${String(version?.version)}"`)
      .send({});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const [snapshot] = await db.admin<Row>(
      'SELECT definition_snapshot FROM workflow_versions WHERE id = $1',
      [draftId],
    );
    const stage = (snapshot?.definition_snapshot as { stages: Row[] }).stages.find(
      (item) => item.key === 'AUTORIZACAO_LICITACAO',
    );
    expect(stage?.decisionPolicy).toBeDefined();
    expect((stage?.approvers as Row[]).map((line) => line.sequence)).toEqual([1, 2]);
    const others = (snapshot?.definition_snapshot as { stages: Row[] }).stages.filter(
      (item) => item.key !== 'AUTORIZACAO_LICITACAO',
    );
    for (const item of others) expect(item).not.toHaveProperty('decisionPolicy');

    const app = db.client('cf_app');
    const attempts: (() => Promise<unknown>)[] = [
      () =>
        asTenant(A, () =>
          app.$tenantTransaction(
            (tx) =>
              tx.$executeRaw`UPDATE workflow_stage_approvers SET label = 'Invasão' WHERE workflow_stage_id = ${autorizacao.id}::uuid`,
          ),
        ),
      () =>
        asTenant(A, () =>
          app.$tenantTransaction((tx) =>
            tx.workflowStageApprover.deleteMany({ where: { workflowStageId: autorizacao.id } }),
          ),
        ),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toSatisfy((error: unknown) =>
        String(error).includes('cf_wf_version_not_draft'),
      );
    }
    await expect(
      db.admin(`INSERT INTO workflow_stage_approvers (id, tenant_id, workflow_version_id,
                  workflow_stage_id, sequence, approver_type, approver_user_id)
                VALUES ('${randomUUID()}', '${A}', '${draftId}', '${autorizacao.id}', 3, 'USER', '${ROBERTO}')`),
    ).rejects.toThrow(/cf_wf_version_not_draft/);
    const response = await put(
      'sub-carla',
      autorizacao.id,
      { decisionPolicy: 'ANY', approvers: [] },
      autorizacao.version ?? 1,
    );
    expect(response.status).toBe(409);
    expect(problemCode(response)).toBe('WORKFLOW_VERSION_NOT_DRAFT');
    expect(await linesOf(autorizacao.id)).toHaveLength(2);
  });

  it('[Sucesso] WF-08 copia as linhas para o novo rascunho com ids novos e a etapa nova', async () => {
    const response = await post('sub-carla', `/workflows/${fase.id}/versions`, {});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const draft = data<WorkflowVersionDetailDto>(response);
    const copied = draft.stages.find((stage) => stage.key === 'AUTORIZACAO_LICITACAO');
    expect(copied?.decisionPolicy).not.toBe('ANY');
    const source = await linesOf(autorizacao.id);
    const lines = await db.admin<Row>(
      `SELECT id, sequence, approver_user_id, workflow_version_id FROM workflow_stage_approvers
        WHERE workflow_stage_id = $1 ORDER BY sequence`,
      [copied?.id],
    );
    expect(lines.map((line) => line.approver_user_id)).toEqual(
      source.map((line) => line.approver_user_id),
    );
    expect(lines.every((line) => line.workflow_version_id === draft.id)).toBe(true);
    const sourceIds = await db.admin<Row>(
      'SELECT id FROM workflow_stage_approvers WHERE workflow_stage_id = $1',
      [autorizacao.id],
    );
    const ids = new Set(sourceIds.map((row) => row.id));
    expect(lines.some((line) => ids.has(line.id))).toBe(false);
  });
});

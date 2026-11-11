// Etapas paralelas sobre PostgreSQL real (US-123 · WF-24 · DEC-194 · M2-01/M2-04): tipos
// `PARALLEL_SPLIT`/`PARALLEL_JOIN` no enum, check de banco (sem prazo nem aprovador), `branch_key`
// gravado na publicação e coberto pelo gatilho de imutabilidade, publicação atômica revertida por
// falha do outbox (versão segue DRAFT, sem `branch_key` nem evento) e isolamento entre tenants
// (WF-24 e escritas com os tipos novos em versão de B → 404; etapa de B como destino → 422; RLS).
// `pnpm --filter @contrataflow/api exec vitest run --config vitest.integration.config.ts test/tenant-leak/workflow-parallel-stages.spec.ts`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowVersionBranchesDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c123-0000-7000-8000-00000000000a';
const B = '0192c123-0000-7000-8000-00000000000b';
const MARINA = '0192c123-0000-7000-8000-0000000000a1';
const BETO = '0192c123-0000-7000-8000-0000000000b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARINA]: ['ADMIN_ORGAO'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'prefeitura-a-wf-parallel', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf-parallel', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARINA}', 'sub-marina', 'marina@a.test', true, 'Marina Souza'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c123-0000-7000-8000-0000000001a1', '${A}', '${MARINA}', 'INTERNAL', 'ACTIVE'),
  ('0192c123-0000-7000-8000-0000000001b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: etapas paralelas isoladas por tenant sobre PostgreSQL (US-123)', () => {
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

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

  const createWorkflow = async (subject: string, key: string) => {
    const response = await post(subject, '/workflows', { key, name: `Workflow ${key}` });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowDto>(response);
  };

  /**
   * ABERTURA → ESTUDOS → RAMIFICACAO → (JURIDICO | CONTROLE_INTERNO) → JUNCAO → AUTORIZACAO → FIM.
   * Devolve as etapas por chave.
   */
  const buildParallelFlow = async (subject: string, versionId: string) => {
    const stages = new Map<string, WorkflowStageDto>();
    for (const body of [
      { key: 'ABERTURA', name: 'Abertura', type: 'START' },
      { key: 'ESTUDOS_PRELIMINARES', name: 'Estudos preliminares', type: 'TASK', slaDays: 5 },
      { key: 'RAMIFICACAO_ANALISES', name: 'Ramificação — Análises', type: 'PARALLEL_SPLIT' },
      { key: 'JURIDICO', name: 'Jurídico', type: 'TASK', slaDays: 5 },
      { key: 'CONTROLE_INTERNO', name: 'Controle interno', type: 'TASK', slaDays: 4 },
      { key: 'JUNCAO_ANALISES', name: 'Junção — Análises', type: 'PARALLEL_JOIN' },
      {
        key: 'AUTORIZACAO_LICITACAO',
        name: 'Autorização da licitação',
        type: 'APPROVAL',
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      },
      { key: 'FIM', name: 'Fim', type: 'END' },
    ]) {
      const response = await post(subject, `/workflow-versions/${versionId}/stages`, body);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      stages.set(body.key, data<WorkflowStageDto>(response));
    }
    const id = (key: string) => stages.get(key)?.id;
    for (const [from, to, action] of [
      ['ABERTURA', 'ESTUDOS_PRELIMINARES', 'FORWARD'],
      ['ESTUDOS_PRELIMINARES', 'RAMIFICACAO_ANALISES', 'FORWARD'],
      ['RAMIFICACAO_ANALISES', 'JURIDICO', 'FORWARD'],
      ['RAMIFICACAO_ANALISES', 'CONTROLE_INTERNO', 'FORWARD'],
      ['JURIDICO', 'JUNCAO_ANALISES', 'FORWARD'],
      ['CONTROLE_INTERNO', 'JUNCAO_ANALISES', 'FORWARD'],
      ['JUNCAO_ANALISES', 'AUTORIZACAO_LICITACAO', 'FORWARD'],
      ['AUTORIZACAO_LICITACAO', 'FIM', 'APPROVE'],
      ['AUTORIZACAO_LICITACAO', 'ESTUDOS_PRELIMINARES', 'RETURN'],
      ['AUTORIZACAO_LICITACAO', 'ABERTURA', 'REJECT'],
    ] as const) {
      const response = await post(subject, `/workflow-versions/${versionId}/transitions`, {
        key: `${from}_${to}_${action}`.slice(0, 60),
        name: `${from} → ${to}`,
        fromStageId: id(from),
        toStageId: id(to),
        action,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    return stages;
  };
  const versionRow = async (versionId: string) =>
    (
      await db.admin<Row>(
        'SELECT status, version, definition_hash, definition_snapshot FROM workflow_versions WHERE id = $1',
        [versionId],
      )
    )[0];
  const branchKeys = (versionId: string) =>
    db.admin<Row>(
      `SELECT key, branch_key FROM workflow_stages WHERE workflow_version_id = $1
         AND branch_key IS NOT NULL ORDER BY key`,
      [versionId],
    );
  const publish = async (versionId: string) => {
    const row = await versionRow(versionId);
    return as(
      request(api.server).post(`/api/v1/workflow-versions/${versionId}/publish`),
      'sub-marina',
    )
      .set('If-Match', `"${String(row?.version)}"`)
      .send({});
  };

  let draftId: string;
  let stages: Map<string, WorkflowStageDto>;

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

  it('[Sucesso] etapas PARALLEL_SPLIT/PARALLEL_JOIN gravadas; WF-24 do rascunho calculado na hora', async () => {
    const fluxo = await createWorkflow('sub-marina', 'LICITACAO_COM_RAMOS');
    draftId = fluxo.draftVersion?.id ?? '';
    stages = await buildParallelFlow('sub-marina', draftId);
    const rows = await db.admin<Row>(
      `SELECT key, type::text AS type, branch_key FROM workflow_stages
         WHERE workflow_version_id = $1 AND type::text LIKE 'PARALLEL_%' ORDER BY key`,
      [draftId],
    );
    expect(rows).toEqual([
      { key: 'JUNCAO_ANALISES', type: 'PARALLEL_JOIN', branch_key: null },
      { key: 'RAMIFICACAO_ANALISES', type: 'PARALLEL_SPLIT', branch_key: null },
    ]);
    const response = await get('sub-marina', `/workflow-versions/${draftId}/branches`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(data<WorkflowVersionBranchesDto>(response).stageBranch).toEqual({
      CONTROLE_INTERNO: 'CONTROLE_INTERNO',
      JURIDICO: 'JURIDICO',
    });
    expect(response.headers.etag).toBe(`"${String((await versionRow(draftId))?.version)}"`);
  });

  it('[Banco] check de split/join sem prazo nem aprovador; branch_key só em TASK/APPROVAL', async () => {
    const split = stages.get('RAMIFICACAO_ANALISES')?.id ?? '';
    await expect(
      db.admin(`UPDATE workflow_stages SET sla_days = 3 WHERE id = '${split}'`),
    ).rejects.toThrow(/workflow_stages_parallel_no_sla_approver/);
    await expect(
      db.admin(`UPDATE workflow_stages SET approver_type = 'USER', approver_user_id = '${MARINA}'
                  WHERE id = '${split}'`),
    ).rejects.toThrow(/workflow_stages_parallel_no_sla_approver|approver/);
    await expect(
      db.admin(`UPDATE workflow_stages SET branch_key = 'X' WHERE id = '${split}'`),
    ).rejects.toThrow(/workflow_stages_branch_key_scope/);
  });

  it('[Falha de integração] falha do outbox na publicação reverte tudo: DRAFT, sem branch_key, sem evento', async () => {
    const writer = api.app.get<OutboxWriterPort>(OUTBOX_WRITER);
    const spy = vi
      .spyOn(writer, 'record')
      .mockRejectedValueOnce(new DatabaseUnavailableError(new Error('outbox indisponível')));
    try {
      const response = await publish(draftId);
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
    expect(await versionRow(draftId)).toMatchObject({
      status: 'DRAFT',
      definition_hash: null,
      definition_snapshot: null,
    });
    expect(await branchKeys(draftId)).toEqual([]);
    const events = await db.admin<Row>(
      `SELECT id FROM outbox_events WHERE tenant_id = $1 AND event_type = 'WorkflowVersionPublished'`,
      [A],
    );
    expect(events).toEqual([]);
  });

  it('[Sucesso] publicação grava branch_key nos ramos, no snapshot e no hash; o gatilho barra mudá-lo depois', async () => {
    const response = await publish(draftId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await branchKeys(draftId)).toEqual([
      { key: 'CONTROLE_INTERNO', branch_key: 'CONTROLE_INTERNO' },
      { key: 'JURIDICO', branch_key: 'JURIDICO' },
    ]);
    const row = await versionRow(draftId);
    const snapshot = row?.definition_snapshot as { stages: Row[] };
    expect(snapshot.stages.find((stage) => stage.key === 'JURIDICO')?.branchKey).toBe('JURIDICO');
    expect(
      snapshot.stages.find((stage) => stage.key === 'RAMIFICACAO_ANALISES'),
    ).not.toHaveProperty('branchKey');
    const [audit] = await db.admin<Row>(
      `SELECT metadata FROM audit_logs WHERE tenant_id = $1 AND action = 'workflow.version_publish'
         AND entity_id = $2`,
      [A, draftId],
    );
    expect(audit?.metadata).toMatchObject({
      parallelBlocks: 1,
      definitionHash: row?.definition_hash,
    });
    const events = await db.admin<Row>(
      `SELECT id FROM outbox_events WHERE tenant_id = $1 AND event_type = 'WorkflowVersionPublished'`,
      [A],
    );
    expect(events).toHaveLength(1);

    await expect(
      db.admin(`UPDATE workflow_stages SET branch_key = 'OUTRO'
                  WHERE workflow_version_id = '${draftId}' AND key = 'JURIDICO'`),
    ).rejects.toThrow(/cf_wf_version_not_draft/);
  });

  it('[Tenant incorreto] WF-24 e escritas com os tipos novos em versão de B → 404; etapa de B como destino → 422; RLS', async () => {
    const other = await createWorkflow('sub-beto', 'FLUXO_B_RAMOS');
    const otherDraft = other.draftVersion?.id ?? '';
    const otherStages = await buildParallelFlow('sub-beto', otherDraft);

    for (const response of [
      await get('sub-marina', `/workflow-versions/${otherDraft}/branches`),
      await post('sub-marina', `/workflow-versions/${otherDraft}/stages`, {
        key: 'JUNCAO_INVASORA',
        name: 'Junção invasora',
        type: 'PARALLEL_JOIN',
      }),
      await post('sub-marina', `/workflow-versions/${otherDraft}/transitions`, {
        key: 'INVASAO',
        name: 'Invasão',
        fromStageId: otherStages.get('RAMIFICACAO_ANALISES')?.id,
        toStageId: otherStages.get('JURIDICO')?.id,
        action: 'FORWARD',
      }),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemCode(response)).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }

    // Rascunho novo de A com destino na etapa de B: a etapa não existe na versão de A.
    const draft = await post(
      'sub-marina',
      `/workflows/${(await versionWorkflow(draftId)) ?? ''}/versions`,
      {},
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const aDraft = (draft.body as { data: { id: string; stages: WorkflowStageDto[] } }).data;
    const split = aDraft.stages.find((stage) => stage.key === 'RAMIFICACAO_ANALISES');
    const foreign = await post('sub-marina', `/workflow-versions/${aDraft.id}/transitions`, {
      key: 'PARA_B',
      name: 'Para B',
      fromStageId: split?.id,
      toStageId: otherStages.get('JURIDICO')?.id,
      action: 'FORWARD',
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
    expect(problemDetailsSchema.parse(foreign.body).errors).toEqual([
      expect.objectContaining({ field: 'toStageId', code: 'REFERENCE_NOT_FOUND' }),
    ]);

    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT DISTINCT tenant_id FROM workflow_stages WHERE type::text LIKE 'PARALLEL_%'`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
  });

  const versionWorkflow = async (versionId: string) =>
    (await db.admin<Row>('SELECT workflow_id FROM workflow_versions WHERE id = $1', [versionId]))[0]
      ?.workflow_id as string | undefined;
});

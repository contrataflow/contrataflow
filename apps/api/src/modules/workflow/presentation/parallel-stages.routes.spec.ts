import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  workflowVersionBranchesSchema,
  workflowVersionDetailSchema,
} from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowValidationResult,
  WorkflowVersionBranchesDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { WORKFLOW_TRANSACTIONS } from '../application/ports.js';
import type { WorkflowTransactions } from '../application/ports.js';
import {
  InMemoryWorkflowRepository,
  InMemoryWorkflowTransactions,
} from '../infrastructure/in-memory-workflow.repository.js';

/*
 * US-123 — Modelar etapas paralelas (ramificação e junção) pelo pipeline HTTP: WF-10/11/13/14
 * com os tipos novos, WF-20 (`WF_PARALLEL_INVALID` com `reason`), WF-21 (gravação do `branchKey`,
 * snapshot e hash) e WF-24 (estrutura de ramos). "Marina" = `sub-marta` (ADMIN_ORGAO com MFA);
 * "Paulo" = `sub-otavio` (segundo administrador); "Bruno" = `sub-fabio` (só `WORKFLOW_VIEW`); a
 * "Prefeitura B" = `sub-heitor`. A reversão real da publicação (falha do outbox), os checks de
 * banco, o gatilho de imutabilidade e o isolamento no PostgreSQL estão em
 * `test/tenant-leak/workflow-parallel-stages.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MFA = ['pwd', 'otp'];

type User = 'sub-marta' | 'sub-otavio' | 'sub-fabio' | 'sub-heitor';

class FlakyTransactions implements WorkflowTransactions {
  down = false;
  private readonly inner = new InMemoryWorkflowTransactions();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return this.inner.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return this.inner.read(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return this.inner.snapshot(work);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const etagOf = (response: request.Response) =>
  Number(String(response.headers.etag).replaceAll('"', ''));

describe('Feature: Modelar etapas paralelas no workflow (US-123)', () => {
  let api: TestApi;
  let repository: InMemoryWorkflowRepository;
  const transactions = new FlakyTransactions();
  const logs: unknown[] = [];

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logs.push(message);
      });
    }
    api = await createTestApi({
      providers: [{ token: WORKFLOW_TRANSACTIONS, value: transactions }],
    });
    repository = api.app.get(InMemoryWorkflowRepository, { strict: false });
    api.app.get(DocumentTypeCatalog).register({
      codesOf: () =>
        Promise.resolve({ active: new Set(['DFD', 'ETP', 'TR']), inactive: new Set<string>() }),
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  const as = (test: request.Test, user: User) =>
    test
      .set('Authorization', api.bearer(user, { amr: MFA }))
      .set('X-Tenant-Id', user === 'sub-heitor' ? B : A);
  const get = (path: string, user: User = 'sub-marta') =>
    as(request(api.server).get(`/api/v1${path}`), user);
  const post = (path: string, body: object | undefined, user: User = 'sub-marta') => {
    const test = as(request(api.server).post(`/api/v1${path}`), user).set(
      'Idempotency-Key',
      randomUUID(),
    );
    return body === undefined ? test : test.send(body);
  };
  const patch = (path: string, body: object, ifMatch: number, user: User = 'sub-marta') =>
    as(request(api.server).patch(`/api/v1${path}`), user)
      .set('If-Match', `"${String(ifMatch)}"`)
      .send(body);
  const remove = (path: string, ifMatch: number, user: User = 'sub-marta') =>
    as(request(api.server).delete(`/api/v1${path}`), user).set('If-Match', `"${String(ifMatch)}"`);
  const publish = (versionId: string, body: object, ifMatch: number, user: User = 'sub-marta') =>
    as(request(api.server).post(`/api/v1/workflow-versions/${versionId}/publish`), user)
      .set('If-Match', `"${String(ifMatch)}"`)
      .send(body);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (type: string) => api.outboxRows().filter((row) => row.eventType === type);
  const logged = (event: string) =>
    logs.filter(
      (entry) =>
        typeof entry === 'object' && entry !== null && 'event' in entry && entry.event === event,
    );

  const versionOf = async (versionId: string, user: User = 'sub-marta') => {
    const response = await get(`/workflow-versions/${versionId}`, user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      version: workflowVersionDetailSchema.parse(data<WorkflowVersionDetailDto>(response)),
      etag: etagOf(response),
    };
  };
  const branchesOf = async (versionId: string, user: User = 'sub-marta') => {
    const response = await get(`/workflow-versions/${versionId}/branches`, user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      branches: workflowVersionBranchesSchema.parse(data<WorkflowVersionBranchesDto>(response)),
      etag: etagOf(response),
    };
  };
  const validate = async (versionId: string) => {
    const response = await post(`/workflow-versions/${versionId}/validate`, undefined);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<WorkflowValidationResult>(response);
  };
  const addStage = async (versionId: string, body: object) => {
    const response = await post(`/workflow-versions/${versionId}/stages`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };
  const stageIds = new Map<string, string>();
  const addTransition = async (versionId: string, from: string, to: string, action: string) => {
    const key = `${from}_${to}`.slice(0, 60);
    const response = await post(`/workflow-versions/${versionId}/transitions`, {
      key,
      name: `${from} → ${to}`,
      fromStageId: stageIds.get(from),
      toStageId: stageIds.get(to),
      action,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowTransitionDto>(response);
  };
  const stageNamed = (version: WorkflowVersionDetailDto, key: string) => {
    const stage = version.stages.find((item) => item.key === key);
    if (!stage) throw new Error(`Etapa ${key} ausente.`);
    return stage;
  };

  let workflow: WorkflowDto;
  let v2: string;

  it('Background: LICITACAO_COM_RAMOS v1 publicada e v2 em rascunho com ESTUDOS_PRELIMINARES e AUTORIZACAO_LICITACAO', async () => {
    const created = await post('/workflows', {
      key: 'LICITACAO_COM_RAMOS',
      name: 'Licitação com ramos',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    workflow = data<WorkflowDto>(created);
    const v1 = workflow.draftVersion?.id ?? '';
    for (const body of [
      { key: 'ABERTURA', name: 'Abertura', type: 'START', instructions: 'Abra.' },
      { key: 'ESTUDOS_PRELIMINARES', name: 'Estudos preliminares', type: 'TASK', slaDays: 5 },
      {
        key: 'AUTORIZACAO_LICITACAO',
        name: 'Autorização da licitação',
        type: 'APPROVAL',
        slaDays: 2,
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      },
      { key: 'FIM', name: 'Fim', type: 'END' },
    ]) {
      stageIds.set(body.key, (await addStage(v1, body)).id);
    }
    await addTransition(v1, 'ABERTURA', 'ESTUDOS_PRELIMINARES', 'FORWARD');
    await addTransition(v1, 'ESTUDOS_PRELIMINARES', 'AUTORIZACAO_LICITACAO', 'FORWARD');
    await addTransition(v1, 'AUTORIZACAO_LICITACAO', 'FIM', 'APPROVE');
    await addTransition(v1, 'AUTORIZACAO_LICITACAO', 'ESTUDOS_PRELIMINARES', 'RETURN');
    const reject = await post(`/workflow-versions/${v1}/transitions`, {
      key: 'INDEFERIR',
      name: 'Indeferir',
      fromStageId: stageIds.get('AUTORIZACAO_LICITACAO'),
      toStageId: stageIds.get('ESTUDOS_PRELIMINARES'),
      action: 'REJECT',
    });
    expect(reject.status, JSON.stringify(reject.body)).toBe(201);
    const published = await publish(v1, {}, (await versionOf(v1)).etag);
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const draft = await post(`/workflows/${workflow.id}/versions`, {});
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    v2 = data<WorkflowVersionDetailDto>(draft).id;
    const { version } = await versionOf(v2);
    for (const stage of version.stages) stageIds.set(stage.key, stage.id);
    // O bloco entra no lugar do avanço direto ESTUDOS → AUTORIZAÇÃO.
    const direct = version.transitions.find(
      (t) =>
        t.fromStageId === stageIds.get('ESTUDOS_PRELIMINARES') &&
        t.toStageId === stageIds.get('AUTORIZACAO_LICITACAO'),
    );
    const removed = await remove(`/workflow-transitions/${direct?.id ?? ''}`, direct?.version ?? 1);
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(version.stages.every((stage) => stage.branchKey === null)).toBe(true);
  });

  it('[Validação] Split ou join com prazo, aprovador ou documentos → 422 VALIDATION_ERROR NOT_ALLOWED', async () => {
    const created = await post(`/workflow-versions/${v2}/stages`, {
      key: 'RAMIFICACAO_ANALISES',
      name: 'Ramificação — Análises',
      type: 'PARALLEL_SPLIT',
      slaDays: 3,
      documentTypeCodes: ['ETP'],
    });
    const body = expectProblem(created, 422, 'VALIDATION_ERROR');
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'slaDays',
          code: 'NOT_ALLOWED',
          message:
            'Ramificação e junção não têm responsável, prazo nem aprovador. Configure esses dados nas etapas dos ramos.',
        }),
        expect.objectContaining({ field: 'documentTypeCodes', code: 'NOT_ALLOWED' }),
      ]),
    );

    const split = await addStage(v2, {
      key: 'RAMIFICACAO_ANALISES',
      name: 'Ramificação — Análises',
      type: 'PARALLEL_SPLIT',
    });
    stageIds.set(split.key, split.id);
    expect(split).toMatchObject({ type: 'PARALLEL_SPLIT', slaDays: null, branchKey: null });
    expect(auditOf('workflow.update').at(-1)).toMatchObject({
      entityId: split.id,
      metadata: expect.objectContaining({ stageType: 'PARALLEL_SPLIT' }) as unknown,
    });

    const updated = await patch(`/workflow-stages/${split.id}`, { slaDays: 3 }, split.version ?? 1);
    expect(expectProblem(updated, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'slaDays', code: 'NOT_ALLOWED' }),
    ]);
    const approver = await patch(
      `/workflow-stages/${split.id}`,
      { approverType: 'USER', assignmentPolicy: 'CREATOR' },
      split.version ?? 1,
    );
    expect(
      expectProblem(approver, 422, 'VALIDATION_ERROR').errors.map((error) => error.field),
    ).toEqual(expect.arrayContaining(['approverType', 'assignmentPolicy']));
  });

  it('[Permissão] Bruno (só WORKFLOW_VIEW) não cria etapa (403 + access.denied), mas consulta a estrutura', async () => {
    const response = await post(
      `/workflow-versions/${v2}/stages`,
      { key: 'JURIDICO', name: 'Jurídico', type: 'PARALLEL_SPLIT' },
      'sub-fabio',
    );
    expectProblem(response, 403, 'PERMISSION_DENIED');
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_MANAGE' });
    const { branches } = await branchesOf(v2, 'sub-fabio');
    expect(branches.blocks).toHaveLength(1);
  });

  it('[Validação] Publicação recusada por split sem junção e sem segundo ramo → 422 WORKFLOW_INVALID', async () => {
    const juridico = await addStage(v2, {
      key: 'JURIDICO',
      name: 'Jurídico',
      type: 'TASK',
      slaDays: 5,
      instructions: 'Emita o parecer.',
    });
    stageIds.set(juridico.key, juridico.id);
    await addTransition(v2, 'ESTUDOS_PRELIMINARES', 'RAMIFICACAO_ANALISES', 'FORWARD');
    await addTransition(v2, 'RAMIFICACAO_ANALISES', 'JURIDICO', 'FORWARD');
    await addTransition(v2, 'JURIDICO', 'AUTORIZACAO_LICITACAO', 'FORWARD');

    const events = eventsOf('WorkflowVersionPublished').length;
    const response = await publish(
      v2,
      { changeNotes: 'Jurídico e Controle Interno em paralelo' },
      (await versionOf(v2)).etag,
    );
    const problem = expectProblem(response, 422, 'WORKFLOW_INVALID') as unknown as {
      validation: WorkflowValidationResult;
    };
    expect(problem.validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'WF_PARALLEL_INVALID',
          reason: 'SPLIT_BRANCHES_MIN',
          stageKey: 'RAMIFICACAO_ANALISES',
        }),
        expect.objectContaining({
          code: 'WF_PARALLEL_INVALID',
          reason: 'SPLIT_JOIN_MISSING',
          stageKey: 'RAMIFICACAO_ANALISES',
        }),
      ]),
    );
    expect((await versionOf(v2)).version.status).toBe('DRAFT');
    expect(eventsOf('WorkflowVersionPublished')).toHaveLength(events);
    expect(logged('workflow.parallel_validation_failed').at(-1)).toMatchObject({
      versionId: v2,
      reasons: expect.arrayContaining(['SPLIT_BRANCHES_MIN', 'SPLIT_JOIN_MISSING']) as unknown,
    });

    // FA-06: o painel "Ramificações" mostra o que falta.
    const { branches } = await branchesOf(v2);
    expect(branches.blocks[0]).toMatchObject({
      splitStageKey: 'RAMIFICACAO_ANALISES',
      joinStageKey: null,
      branches: [{ branchKey: 'JURIDICO', entryStageKey: 'JURIDICO' }],
    });
    expect(branches.blocks[0]?.issues.map((issue) => issue.reason)).toEqual(
      expect.arrayContaining(['SPLIT_BRANCHES_MIN', 'SPLIT_JOIN_MISSING']),
    );
  });

  it('[V-11] ação incompatível com ramificação/junção na escrita → 422 VALIDATION_ERROR', async () => {
    const complete = await post(`/workflow-versions/${v2}/transitions`, {
      key: 'RAMIFICAR_CONCLUIR',
      name: 'Concluir da ramificação',
      fromStageId: stageIds.get('RAMIFICACAO_ANALISES'),
      toStageId: stageIds.get('FIM'),
      action: 'COMPLETE',
    });
    expect(expectProblem(complete, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'action', code: 'NOT_ALLOWED' }),
    ]);
    const toEnd = await post(`/workflow-versions/${v2}/transitions`, {
      key: 'RAMIFICAR_ESTUDOS',
      name: 'Ramificação de volta',
      fromStageId: stageIds.get('RAMIFICACAO_ANALISES'),
      toStageId: stageIds.get('ABERTURA'),
      action: 'FORWARD',
    });
    expectProblem(toEnd, 422, 'VALIDATION_ERROR');
  });

  it('[Duplicidade] Chave de etapa repetida na versão → 409 CONFLICT', async () => {
    const response = await post(`/workflow-versions/${v2}/stages`, {
      key: 'JURIDICO',
      name: 'Outro jurídico',
      type: 'TASK',
    });
    expectProblem(response, 409, 'CONFLICT');
  });

  it('[Sucesso] Completar o bloco: validação sem erros e estrutura de ramos sem problemas (sem auditoria)', async () => {
    const { version } = await versionOf(v2);
    const wrong = version.transitions.find(
      (t) =>
        t.fromStageId === stageIds.get('JURIDICO') &&
        t.toStageId === stageIds.get('AUTORIZACAO_LICITACAO'),
    );
    expect((await remove(`/workflow-transitions/${wrong?.id ?? ''}`, 1)).status).toBe(204);
    for (const body of [
      { key: 'JUNCAO_ANALISES', name: 'Junção — Análises', type: 'PARALLEL_JOIN' },
      {
        key: 'CONTROLE_INTERNO',
        name: 'Controle interno',
        type: 'TASK',
        slaDays: 4,
        instructions: 'Manifeste-se.',
      },
    ]) {
      stageIds.set(body.key, (await addStage(v2, body)).id);
    }
    await addTransition(v2, 'RAMIFICACAO_ANALISES', 'CONTROLE_INTERNO', 'FORWARD');
    await addTransition(v2, 'JURIDICO', 'JUNCAO_ANALISES', 'FORWARD');
    await addTransition(v2, 'CONTROLE_INTERNO', 'JUNCAO_ANALISES', 'FORWARD');
    await addTransition(v2, 'JUNCAO_ANALISES', 'AUTORIZACAO_LICITACAO', 'FORWARD');

    const result = await validate(v2);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);

    const audits = api.auditRecords().length;
    const events = api.outboxRows().length;
    const { branches, etag } = await branchesOf(v2);
    expect(etag).toBe((await versionOf(v2)).etag);
    expect(branches).toEqual({
      blocks: [
        {
          splitStageKey: 'RAMIFICACAO_ANALISES',
          joinStageKey: 'JUNCAO_ANALISES',
          branches: [
            {
              branchKey: 'CONTROLE_INTERNO',
              entryStageKey: 'CONTROLE_INTERNO',
              stageKeys: ['CONTROLE_INTERNO'],
              exitTransitionKey: 'CONTROLE_INTERNO_JUNCAO_ANALISES',
            },
            {
              branchKey: 'JURIDICO',
              entryStageKey: 'JURIDICO',
              stageKeys: ['JURIDICO'],
              exitTransitionKey: 'JURIDICO_JUNCAO_ANALISES',
            },
          ],
          issues: [],
        },
      ],
      issues: [],
      stageBranch: { CONTROLE_INTERNO: 'CONTROLE_INTERNO', JURIDICO: 'JURIDICO' },
    });
    expect(api.auditRecords()).toHaveLength(audits);
    expect(api.outboxRows()).toHaveLength(events);
    expect(logged('workflow.parallel_graph_validated').at(-1)).toMatchObject({
      versionId: v2,
      blocks: 1,
      branches: 2,
      errorsCount: 0,
    });
  });

  it('[Validação] Todos os erros de paralelismo de uma vez: split aninhado e transição entre ramos', async () => {
    const inner = await addStage(v2, {
      key: 'RAMIFICACAO_INTERNA',
      name: 'Ramificação interna',
      type: 'PARALLEL_SPLIT',
    });
    stageIds.set(inner.key, inner.id);
    const nested = await addTransition(v2, 'JURIDICO', 'RAMIFICACAO_INTERNA', 'FORWARD');
    const cross = await addTransition(v2, 'CONTROLE_INTERNO', 'JURIDICO', 'FORWARD');

    const result = await validate(v2);
    expect(result.valid).toBe(false);
    expect(
      result.errors.filter((e) => e.code === 'WF_PARALLEL_INVALID').map((e) => e.reason),
    ).toEqual(expect.arrayContaining(['NESTED_SPLIT', 'CROSS_BRANCH_TRANSITION']));

    for (const transition of [nested, cross]) {
      expect((await remove(`/workflow-transitions/${transition.id}`, 1)).status).toBe(204);
    }
    expect((await remove(`/workflow-stages/${inner.id}`, 1)).status).toBe(204);
    expect((await validate(v2)).valid).toBe(true);
  });

  it('[Concorrência] Duas edições com o mesmo ETag: a segunda → 412; publicação com If-Match antigo → 412', async () => {
    const { version, etag } = await versionOf(v2);
    const juridico = stageNamed(version, 'JURIDICO');
    const marina = await patch(
      `/workflow-stages/${juridico.id}`,
      { name: 'Jurídico — parecer' },
      juridico.version ?? 1,
    );
    expect(marina.status, JSON.stringify(marina.body)).toBe(200);
    const paulo = await patch(
      `/workflow-stages/${juridico.id}`,
      { slaDays: 7 },
      juridico.version ?? 1,
      'sub-otavio',
    );
    expectProblem(paulo, 412, 'VERSION_CONFLICT');
    expectProblem(await publish(v2, { changeNotes: 'Corrida' }, etag), 412, 'VERSION_CONFLICT');
    expect(stageNamed((await versionOf(v2)).version, 'JURIDICO').slaDays).toBe(5);
  });

  it('[Permissão] Publicar sem MFA na sessão → 403 MFA_REQUIRED', async () => {
    const { etag } = await versionOf(v2);
    const response = await request(api.server)
      .post(`/api/v1/workflow-versions/${v2}/publish`)
      .set('Authorization', api.bearer('sub-marta', { amr: ['pwd'] }))
      .set('X-Tenant-Id', A)
      .set('If-Match', `"${String(etag)}"`)
      .send({ changeNotes: 'Sem MFA' });
    expectProblem(response, 403, 'MFA_REQUIRED');
  });

  it('[Falha de banco] Banco indisponível na publicação → 503; versão segue DRAFT sem branchKey', async () => {
    const { etag } = await versionOf(v2);
    transactions.down = true;
    const response = await publish(
      v2,
      { changeNotes: 'Jurídico e Controle Interno em paralelo' },
      etag,
    );
    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    transactions.down = false;
    const { version } = await versionOf(v2);
    expect(version.status).toBe('DRAFT');
    expect(version.stages.every((stage) => stage.branchKey === null)).toBe(true);
  });

  let publishedHash: string;

  it('[Sucesso] Publicar: 200 PUBLISHED, branchKey gravado nos ramos, auditoria com parallelBlocks e evento', async () => {
    const { etag } = await versionOf(v2);
    const events = eventsOf('WorkflowVersionPublished').length;
    const response = await publish(
      v2,
      { changeNotes: 'Jurídico e Controle Interno em paralelo' },
      etag,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const published = data<WorkflowVersionSummaryDto>(response);
    expect(published.status).toBe('PUBLISHED');
    publishedHash = published.definitionHash ?? '';

    const { version } = await versionOf(v2);
    const branchOf = (key: string) => stageNamed(version, key).branchKey;
    expect(branchOf('JURIDICO')).toBe('JURIDICO');
    expect(branchOf('CONTROLE_INTERNO')).toBe('CONTROLE_INTERNO');
    for (const key of ['RAMIFICACAO_ANALISES', 'JUNCAO_ANALISES', 'ESTUDOS_PRELIMINARES']) {
      expect(branchOf(key)).toBeNull();
    }
    // Gravado nas linhas e no snapshot (que cobre o hash).
    expect(repository.stages.get(stageIds.get('JURIDICO') ?? '')?.branchKey).toBe('JURIDICO');
    const snapshot = repository.versions.get(v2)?.definitionSnapshot;
    expect(snapshot?.stages.find((stage) => stage.key === 'CONTROLE_INTERNO')?.branchKey).toBe(
      'CONTROLE_INTERNO',
    );

    expect(auditOf('workflow.version_publish').at(-1)).toMatchObject({
      entityId: v2,
      metadata: expect.objectContaining({
        definitionHash: publishedHash,
        parallelBlocks: 1,
      }) as unknown,
    });
    expect(eventsOf('WorkflowVersionPublished')).toHaveLength(events + 1);
    expect(eventsOf('WorkflowVersionPublished').at(-1)).toMatchObject({
      payload: { workflowVersionId: v2, definitionHash: publishedHash },
    });
    expect(logged('workflow.version_published').at(-1)).toMatchObject({
      workflowVersionId: v2,
      parallelBlocks: 1,
      definitionHash: publishedHash,
    });

    // FA-07: a estrutura da publicada vem do snapshot.
    const { branches } = await branchesOf(v2);
    expect(branches.stageBranch).toEqual({
      CONTROLE_INTERNO: 'CONTROLE_INTERNO',
      JURIDICO: 'JURIDICO',
    });
    expect(branches.blocks[0]?.joinStageKey).toBe('JUNCAO_ANALISES');
  });

  it('[Duplicidade] Reenviar a publicação com o mesmo If-Match → 412/409 sem segundo evento', async () => {
    const events = eventsOf('WorkflowVersionPublished').length;
    const { etag } = await versionOf(v2);
    const stale = await publish(v2, { changeNotes: 'De novo' }, etag - 1);
    expectProblem(stale, 412, 'VERSION_CONFLICT');
    const again = await publish(v2, { changeNotes: 'De novo' }, etag);
    expectProblem(again, 409, 'INVALID_STATE');
    expect(eventsOf('WorkflowVersionPublished')).toHaveLength(events);
  });

  it('[FA-05] Nova versão copiada de uma versão com ramos: branchKey zerado no rascunho e recalculado no WF-24', async () => {
    const draft = await post(`/workflows/${workflow.id}/versions`, {});
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const v3 = data<WorkflowVersionDetailDto>(draft).id;
    const { version } = await versionOf(v3);
    expect(version.stages.every((stage) => stage.branchKey === null)).toBe(true);
    const { branches } = await branchesOf(v3);
    expect(branches.stageBranch).toEqual({
      CONTROLE_INTERNO: 'CONTROLE_INTERNO',
      JURIDICO: 'JURIDICO',
    });
  });

  it('[Tenant incorreto] Estrutura de ramos e escrita em versão de outro tenant → 404 sem revelar nada', async () => {
    const created = await post(
      '/workflows',
      { key: 'FLUXO_B_RAMOS', name: 'Fluxo LEAK-B' },
      'sub-heitor',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const otherDraft = data<WorkflowDto>(created).draftVersion?.id ?? '';
    await post(
      `/workflow-versions/${otherDraft}/stages`,
      { key: 'RAMIFICACAO_B', name: 'Ramificação LEAK-B', type: 'PARALLEL_SPLIT' },
      'sub-heitor',
    );
    for (const response of [
      await get(`/workflow-versions/${otherDraft}/branches`),
      await post(`/workflow-versions/${otherDraft}/stages`, {
        key: 'JUNCAO_INVASORA',
        name: 'Junção invasora',
        type: 'PARALLEL_JOIN',
      }),
    ]) {
      expectProblem(response, 404, 'NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    const { version } = await versionOf(otherDraft, 'sub-heitor');
    expect(version.stages.map((stage) => stage.key)).toEqual(['RAMIFICACAO_B']);
  });
});

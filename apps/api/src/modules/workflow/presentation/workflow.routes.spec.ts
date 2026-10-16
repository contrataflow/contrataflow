import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowRuleDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import { DocumentTypeUsageRegistry } from '#shared/document/document-type-usage.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { WORKFLOW_TRANSACTIONS } from '../application/ports.js';
import type { WorkflowTransactions } from '../application/ports.js';
import { WorkflowFacade } from '../application/workflow.facade.js';
import {
  InMemoryWorkflowRepository,
  InMemoryWorkflowTransactions,
} from '../infrastructure/in-memory-workflow.repository.js';

/*
 * US-040 — WF-02..04 e WF-07..18 pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * If-Match, idempotência, Zod, filtro RFC 9457) com a identidade fake, a auditoria real do
 * `AuditService`, o outbox e o cache em memória. Os mesmos casos contra o PostgreSQL (gatilhos,
 * FKs compostas, RLS, concorrência real) estão em `test/tenant-leak/workflows.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MFA = ['pwd', 'otp'];

type User = 'sub-marta' | 'sub-otavio' | 'sub-lucia' | 'sub-fabio' | 'sub-heitor' | 'sub-ana';

/** Transações em memória que podem simular o banco fora do ar (Falha de banco). */
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

describe('Feature: Modelo de definição de workflow versionado (US-040)', () => {
  let api: TestApi;
  let repository: InMemoryWorkflowRepository;
  let facade: WorkflowFacade;
  const transactions = new FlakyTransactions();

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [{ token: WORKFLOW_TRANSACTIONS, value: transactions }],
    });
    repository = api.app.get(InMemoryWorkflowRepository, { strict: false });
    facade = api.app.get(WorkflowFacade, { strict: false });
    // Background: DFD, ETP e TR ativos (e um tipo desativado) — pela porta do shared kernel, sem
    // depender de `document` (mesmo nível). A implementação real tem teste no PostgreSQL.
    api.app.get(DocumentTypeCatalog).register({
      codesOf: () =>
        Promise.resolve({
          active: new Set(['DFD', 'ETP', 'TR', 'DESPACHO']),
          inactive: new Set(['OFICIO']),
        }),
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

  const as = (
    test: request.Test,
    user: User,
    options: { amr?: readonly string[]; tenant?: string } = {},
  ) =>
    test
      .set('Authorization', api.bearer(user, { amr: options.amr ?? MFA }))
      .set('X-Tenant-Id', options.tenant ?? (user === 'sub-heitor' ? B : A));

  const get = (path: string, user: User = 'sub-marta', amr?: readonly string[]) =>
    as(request(api.server).get(`/api/v1${path}`), user, amr ? { amr } : {});
  const post = (
    path: string,
    body: object | undefined,
    user: User = 'sub-marta',
    options: { amr?: readonly string[]; key?: string } = {},
  ) => {
    const test = as(request(api.server).post(`/api/v1${path}`), user, options);
    const keyed = options.key ? test.set('Idempotency-Key', options.key) : test;
    return body === undefined ? keyed : keyed.send(body);
  };
  const patch = (
    path: string,
    body: object,
    ifMatch: number | null,
    user: User = 'sub-marta',
    amr?: readonly string[],
  ) => {
    const test = as(request(api.server).patch(`/api/v1${path}`), user, amr ? { amr } : {});
    return (ifMatch === null ? test : test.set('If-Match', `"${ifMatch}"`)).send(body);
  };
  const del = (path: string, ifMatch: number, user: User = 'sub-marta') =>
    as(request(api.server).delete(`/api/v1${path}`), user).set('If-Match', `"${ifMatch}"`);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (type: string) => api.outboxRows().filter((row) => row.eventType === type);

  const createWorkflow = async (key: string, user: User = 'sub-marta', extra: object = {}) => {
    const response = await post('/workflows', { key, name: `Workflow ${key}`, ...extra }, user, {
      key: randomUUID(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowDto>(response);
  };
  const versionOf = async (versionId: string, user: User = 'sub-marta') => {
    const response = await get(`/workflow-versions/${versionId}`, user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<WorkflowVersionDetailDto>(response);
  };
  const addStage = async (versionId: string, body: object, user: User = 'sub-marta') => {
    const response = await post(`/workflow-versions/${versionId}/stages`, body, user);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };
  const addTransition = async (versionId: string, body: object) => {
    const response = await post(`/workflow-versions/${versionId}/transitions`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowTransitionDto>(response);
  };
  const addRule = async (versionId: string, body: object) => {
    const response = await post(`/workflow-versions/${versionId}/rules`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowRuleDto>(response);
  };

  /** O fluxo válido do Gherkin: 4 etapas, 6 transições e 3 regras. */
  const buildValidDraft = async (versionId: string) => {
    const instructions = 'Siga o roteiro.';
    const abertura = await addStage(versionId, {
      key: 'ABERTURA',
      name: 'Abertura',
      type: 'START',
      instructions,
      documentTypeCodes: ['DFD'],
    });
    const analise = await addStage(versionId, {
      key: 'ANALISE',
      name: 'Análise',
      type: 'TASK',
      instructions,
      slaDays: 5,
    });
    const aprovacao = await addStage(versionId, {
      key: 'APROVACAO',
      name: 'Aprovação',
      type: 'APPROVAL',
      instructions,
      slaDays: 3,
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      approvalDocumentTypeCodes: ['DFD'],
    });
    const fim = await addStage(versionId, { key: 'FIM', name: 'Fim', type: 'END' });
    const edge = (key: string, from: string, to: string, action: string, extra: object = {}) =>
      addTransition(versionId, {
        key,
        name: `Transição ${key}`,
        fromStageId: from,
        toStageId: to,
        action,
        ...extra,
      });
    await edge('ENVIAR_ANALISE', abertura.id, analise.id, 'FORWARD', { isPrimary: true });
    const toApproval = await edge('ENVIAR_APROVACAO', analise.id, aprovacao.id, 'FORWARD');
    await edge('DEVOLVER_ABERTURA', analise.id, abertura.id, 'RETURN');
    await edge('APROVAR', aprovacao.id, fim.id, 'APPROVE');
    await edge('DEVOLVER_ANALISE', aprovacao.id, analise.id, 'RETURN');
    await edge('INDEFERIR', aprovacao.id, abertura.id, 'REJECT');
    const ruleBase = { name: 'Regra do fluxo', message: 'Atenda à regra para seguir.' };
    await addRule(versionId, {
      ...ruleBase,
      scope: 'STAGE_EXIT',
      stageId: abertura.id,
      type: 'REQUIRED_DOCUMENT',
      config: { documentTypeCode: 'DFD', minStatus: 'COMPLETE' },
    });
    await addRule(versionId, {
      ...ruleBase,
      scope: 'TRANSITION',
      transitionId: toApproval.id,
      type: 'REQUIRED_APPROVAL',
      config: { stageKey: 'APROVACAO' },
    });
    await addRule(versionId, {
      ...ruleBase,
      scope: 'STAGE_EXIT',
      stageId: analise.id,
      type: 'CONDITION',
      config: { expression: { '>': [{ var: 'process.estimatedValue' }, 0] } },
    });
    return { abertura, analise, aprovacao, fim };
  };

  const publish = (versionId: string, tenantId = A) =>
    runAsSystem({ name: 'test.publisher', tenantId }, () => facade.publish({ versionId }));
  const validate = (versionId: string, tenantId = A) =>
    runAsSystem({ name: 'test.validator', tenantId }, () => facade.validate(versionId));

  // Estado compartilhado pelos cenários em sequência (OBRAS_ENGENHARIA).
  let obras: WorkflowDto;
  let v1: string;
  let v2: string;

  it('[Sucesso] Criar workflow com a versão 1 em rascunho', async () => {
    const events = eventsOf('WorkflowCreated').length;
    const key = randomUUID();
    const response = await post(
      '/workflows',
      { key: 'OBRAS_ENGENHARIA', name: 'Obras e serviços de engenharia' },
      'sub-marta',
      { key },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    obras = data<WorkflowDto>(response);
    expect(response.headers.location).toBe(`/api/v1/workflows/${obras.id}`);
    expect(obras).toMatchObject({
      key: 'OBRAS_ENGENHARIA',
      isActive: true,
      isDefault: false,
      applicabilityPriority: 100,
      currentPublishedVersion: null,
      draftVersion: { versionNumber: 1 },
    });
    v1 = obras.draftVersion?.id ?? '';
    const version = await versionOf(v1);
    expect(version).toMatchObject({
      status: 'DRAFT',
      versionNumber: 1,
      stages: [],
      initialStageId: null,
    });
    expect(auditOf('workflow.create').at(-1)).toMatchObject({
      entityId: obras.id,
      changes: [
        { path: 'key', old: null, new: 'OBRAS_ENGENHARIA' },
        { path: 'name', old: null, new: 'Obras e serviços de engenharia' },
      ],
      metadata: expect.objectContaining({ draftVersionId: v1, copyFromVersionId: null }) as unknown,
    });
    expect(eventsOf('WorkflowCreated')).toHaveLength(events + 1);
    expect(eventsOf('WorkflowCreated').at(-1)).toMatchObject({
      routingKey: 'workflow.created',
      payload: { workflowId: obras.id, key: 'OBRAS_ENGENHARIA' },
    });

    // Idempotência: a mesma chave repete a resposta sem criar outro workflow.
    const replay = await post(
      '/workflows',
      { key: 'OBRAS_ENGENHARIA', name: 'Obras e serviços de engenharia' },
      'sub-marta',
      { key },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(data<WorkflowDto>(replay).id).toBe(obras.id);
    expect(eventsOf('WorkflowCreated')).toHaveLength(events + 1);
  });

  it('[Sucesso] Etapa inicial define a etapa de entrada da versão (e incrementa a versão)', async () => {
    const before = await get(`/workflow-versions/${v1}`);
    const etagBefore = Number(String(before.headers.etag).replaceAll('"', ''));

    const response = await post(`/workflow-versions/${v1}/stages`, {
      key: 'ABERTURA',
      name: 'Abertura',
      type: 'START',
      departmentResolution: 'REQUESTING_DEPARTMENT',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stage = data<WorkflowStageDto>(response);
    expect(response.headers.location).toBe(`/api/v1/workflow-stages/${stage.id}`);
    expect(response.headers.etag).toBe('"1"');

    const after = await get(`/workflow-versions/${v1}`);
    expect(data<WorkflowVersionDetailDto>(after).initialStageId).toBe(stage.id);
    expect(after.headers.etag).toBe(`"${etagBefore + 1}"`);
    expect(auditOf('workflow.update').at(-1)).toMatchObject({
      entityType: 'WorkflowStage',
      entityId: stage.id,
      metadata: expect.objectContaining({ workflowVersionId: v1, operation: 'CREATE' }) as unknown,
    });

    // FA-03: trocar o tipo da START limpa a etapa inicial; voltar a START restaura.
    const toTask = await patch(`/workflow-stages/${stage.id}`, { type: 'TASK' }, 1);
    expect(toTask.status, JSON.stringify(toTask.body)).toBe(200);
    expect((await versionOf(v1)).initialStageId).toBeNull();
    expect((await patch(`/workflow-stages/${stage.id}`, { type: 'START' }, 2)).status).toBe(200);
    expect((await versionOf(v1)).initialStageId).toBe(stage.id);

    // Sem mudança: 200 sem nova versão nem auditoria.
    const audits = auditOf('workflow.update').length;
    const same = await patch(`/workflow-stages/${stage.id}`, { name: 'Abertura' }, 3);
    expect(same.headers.etag).toBe('"3"');
    expect(auditOf('workflow.update')).toHaveLength(audits);

    // Exclusão da START limpa a etapa inicial (reconstruída a seguir com o fluxo completo).
    expect((await del(`/workflow-stages/${stage.id}`, 3)).status).toBe(204);
    expect((await versionOf(v1)).initialStageId).toBeNull();
  });

  it('[Validação] Segunda etapa inicial → 422 NOT_ALLOWED em type', async () => {
    const parked = (await createWorkflow('INICIAL_DUPLA')).draftVersion?.id ?? '';
    await addStage(parked, { key: 'ABERTURA', name: 'Abertura', type: 'START' });
    const response = await post(`/workflow-versions/${parked}/stages`, {
      key: 'NOVA_ABERTURA',
      name: 'Nova abertura',
      type: 'START',
    });
    const body = expectProblem(response, 422, 'VALIDATION_ERROR');
    expect(body.errors).toEqual([expect.objectContaining({ field: 'type', code: 'NOT_ALLOWED' })]);
    expect((await versionOf(parked)).stages).toHaveLength(1);

    // Mesma chave → 409 CONFLICT; aprovação sem aprovador → CONDITIONAL_REQUIRED.
    expectProblem(
      await post(`/workflow-versions/${parked}/stages`, {
        key: 'ABERTURA',
        name: 'Outra',
        type: 'TASK',
      }),
      409,
      'CONFLICT',
    );
    const noApprover = await post(`/workflow-versions/${parked}/stages`, {
      key: 'APROVA',
      name: 'Aprovar',
      type: 'APPROVAL',
    });
    expect(expectProblem(noApprover, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'approverType', code: 'CONDITIONAL_REQUIRED' }),
    ]);
    // V-05: tipo de documento inexistente; usuário aprovador sem vínculo no tenant.
    const unknownCode = await post(`/workflow-versions/${parked}/stages`, {
      key: 'TAREFA',
      name: 'Tarefa',
      type: 'TASK',
      documentTypeCodes: ['INEXISTENTE'],
    });
    expect(expectProblem(unknownCode, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'documentTypeCodes', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const inactiveCode = await post(`/workflow-versions/${parked}/stages`, {
      key: 'TAREFA',
      name: 'Tarefa',
      type: 'TASK',
      documentTypeCodes: ['OFICIO'],
    });
    expect(expectProblem(inactiveCode, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'documentTypeCodes', code: 'REFERENCE_INACTIVE' }),
    ]);
    const stranger = await post(`/workflow-versions/${parked}/stages`, {
      key: 'APROVA',
      name: 'Aprovar',
      type: 'APPROVAL',
      approverType: 'USER',
      approverUserId: newId(),
    });
    expect(expectProblem(stranger, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'approverUserId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
  });

  it('[Validação] Condição com operação proibida; campo fora do contexto só na publicação (RN-WF-56)', async () => {
    const stage = (
      await versionOf((await createWorkflow('REGRAS_INVALIDAS')).draftVersion?.id ?? '')
    ).id;
    const parked = stage;
    const target = await addStage(parked, { key: 'ANALISE', name: 'Análise', type: 'TASK' });
    const base = {
      scope: 'STAGE_EXIT',
      stageId: target.id,
      name: 'Regra',
      message: 'Mensagem válida',
    };

    const method = await post(`/workflow-versions/${parked}/rules`, {
      ...base,
      type: 'CONDITION',
      config: { expression: { method: [{ var: 'process.title' }, 'toUpperCase'] } },
    });
    expect(expectProblem(method, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'config' }),
    ]);
    const field = await post(`/workflow-versions/${parked}/rules`, {
      ...base,
      type: 'REQUIRED_FIELD',
      config: { field: 'process.internalCode' },
    });
    // US-044 · RN-WF-56: o rascunho aceita; a validação da versão aponta WF_RULE_PATH_UNKNOWN.
    expect(field.status, JSON.stringify(field.body)).toBe(201);
    expect((await validate(parked)).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'WF_RULE_PATH_UNKNOWN' })]),
    );
    expect((await versionOf(parked)).rules).toHaveLength(1);
  });

  it('[Sucesso] Publicação interna gera snapshot canônico e hash reprodutível', async () => {
    await buildValidDraft(v1);
    expect(await validate(v1)).toEqual({ valid: true, errors: [], warnings: [] });

    const result = await publish(v1);

    const version = await versionOf(v1);
    expect(version.status).toBe('PUBLISHED');
    expect(version.publishedAt).not.toBeNull();
    expect(version.definitionHash).toBe(result.definitionHash);
    const stored = repository.versions.get(v1)?.definitionSnapshot;
    expect(stored).toBeTruthy();
    expect(sha256Hex(canonicalJson(stored))).toBe(version.definitionHash);
    expect(version.stages.map((stage) => stage.key)).toEqual([
      'ABERTURA',
      'ANALISE',
      'APROVACAO',
      'FIM',
    ]);
    expect(version.transitions).toHaveLength(6);
    expect(version.rules).toHaveLength(3);

    const workflow = data<WorkflowDto>(await get(`/workflows/${obras.id}`));
    expect(workflow.currentPublishedVersion).toMatchObject({ id: v1, versionNumber: 1 });
    expect(workflow.draftVersion).toBeNull();
    expect(eventsOf('WorkflowVersionPublished').at(-1)).toMatchObject({
      routingKey: 'workflow.version_published',
      payload: {
        workflowId: obras.id,
        workflowVersionId: v1,
        versionNumber: 1,
        definitionHash: version.definitionHash,
      },
    });
    expect(auditOf('workflow.version_publish').at(-1)).toMatchObject({
      entityId: v1,
      metadata: expect.objectContaining({
        definitionHash: version.definitionHash,
        versionNumber: 1,
      }) as unknown,
    });

    // RN-DOC-09 (US-061): o tipo DFD agora é exigido por regra BLOCKING publicada.
    const usage = await runAsSystem({ name: 'test', tenantId: A }, () =>
      api.app.get(DocumentTypeUsageRegistry).usageOf({} as never, 'DFD'),
    );
    expect(usage).toEqual({
      blockingRules: [{ workflowName: 'Obras e serviços de engenharia', stageName: 'Abertura' }],
      referencingWorkflows: 1,
    });
  });

  it('[FA-06] Escrita em versão publicada → 409 WORKFLOW_VERSION_NOT_DRAFT', async () => {
    const version = await versionOf(v1);
    const stage = version.stages[0] as WorkflowStageDto;
    expectProblem(
      await patch(`/workflow-stages/${stage.id}`, { name: 'Outra abertura' }, 1),
      409,
      'WORKFLOW_VERSION_NOT_DRAFT',
    );
    expectProblem(
      await post(`/workflow-versions/${v1}/stages`, { key: 'NOVA', name: 'Nova', type: 'TASK' }),
      409,
      'WORKFLOW_VERSION_NOT_DRAFT',
    );
    expectProblem(
      await del(`/workflow-transitions/${version.transitions[0]?.id ?? ''}`, 1),
      409,
      'WORKFLOW_VERSION_NOT_DRAFT',
    );
    await expect(publish(v1)).rejects.toMatchObject({ code: 'WORKFLOW_VERSION_NOT_DRAFT' });
  });

  it('[Sucesso] Nova versão clona a publicada com novos identificadores', async () => {
    const response = await post(`/workflows/${obras.id}/versions`, undefined);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const clone = data<WorkflowVersionDetailDto>(response);
    v2 = clone.id;
    expect(response.headers.location).toBe(`/api/v1/workflow-versions/${v2}`);
    expect(clone).toMatchObject({ versionNumber: 2, status: 'DRAFT' });
    expect(clone.stages).toHaveLength(4);
    expect(clone.transitions).toHaveLength(6);
    expect(clone.rules).toHaveLength(3);

    const original = await versionOf(v1);
    const idsOf = (version: WorkflowVersionDetailDto) => [
      ...version.stages.map((s) => s.id),
      ...version.transitions.map((t) => t.id),
      ...version.rules.map((r) => r.id),
    ];
    const originalIds = new Set(idsOf(original));
    expect(idsOf(clone).some((id) => originalIds.has(id))).toBe(false);
    const stageIds = new Set(clone.stages.map((s) => s.id));
    const transitionIds = new Set(clone.transitions.map((t) => t.id));
    expect(stageIds.has(clone.initialStageId ?? '')).toBe(true);
    for (const transition of clone.transitions) {
      expect(stageIds.has(transition.fromStageId) && stageIds.has(transition.toStageId)).toBe(true);
    }
    for (const rule of clone.rules) {
      expect(rule.stageId === null || stageIds.has(rule.stageId)).toBe(true);
      expect(rule.transitionId === null || transitionIds.has(rule.transitionId)).toBe(true);
    }
    expect(auditOf('workflow.version_create').at(-1)).toMatchObject({
      entityId: v2,
      metadata: expect.objectContaining({ versionNumber: 2, sourceVersionId: v1 }) as unknown,
    });

    const versions = await get(`/workflows/${obras.id}/versions`);
    expect(
      data<WorkflowVersionSummaryDto[]>(versions).map((v) => [v.versionNumber, v.status]),
    ).toEqual([
      [2, 'DRAFT'],
      [1, 'PUBLISHED'],
    ]);
  });

  it('[Duplicidade] Segunda versão em rascunho e chave repetida', async () => {
    const response = await post(`/workflows/${obras.id}/versions`, {});
    const body = expectProblem(response, 409, 'WORKFLOW_DRAFT_EXISTS');
    expect(body).toMatchObject({ meta: { draftVersionId: v2 } });

    expectProblem(
      await post('/workflows', { key: 'OBRAS_ENGENHARIA', name: 'Outro nome' }, 'sub-marta', {
        key: randomUUID(),
      }),
      409,
      'CONFLICT',
    );
  });

  it('[Validação] Grafo com etapa inalcançável e aprovação incompleta: todos os erros numa execução', async () => {
    const draft = await versionOf(v2);
    await addStage(v2, {
      key: 'PARECER',
      name: 'Parecer',
      type: 'TASK',
      slaDays: 2,
      instructions: 'x',
    });
    const reject = draft.transitions.find((t) => t.action === 'REJECT') as WorkflowTransitionDto;
    expect((await del(`/workflow-transitions/${reject.id}`, 1)).status).toBe(204);

    const result = await validate(v2);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'WF_STAGE_UNREACHABLE', stageKey: 'PARECER' }),
        expect.objectContaining({ code: 'WF_APPROVAL_TRANSITIONS', stageKey: 'APROVACAO' }),
      ]),
    );
    await expect(publish(v2)).rejects.toMatchObject({
      code: 'WORKFLOW_INVALID',
      extensions: {
        validation: { errors: expect.arrayContaining([expect.anything()]) as unknown },
      },
    });
    expect((await versionOf(v2)).status).toBe('DRAFT');
  });

  it('[Permissão] Usuário sem WORKFLOW_MANAGE lê, mas não escreve (access.denied)', async () => {
    // Fábio tem COMPRAS (com WORKFLOW_VIEW) — o equivalente ao PLANEJAMENTO do Gherkin.
    expect((await get(`/workflow-versions/${v2}`, 'sub-fabio')).status).toBe(200);
    expect((await get(`/workflows/${obras.id}`, 'sub-fabio')).status).toBe(200);
    const denied = await post(
      `/workflow-versions/${v2}/stages`,
      { key: 'NEGADA', name: 'Negada', type: 'TASK' },
      'sub-fabio',
    );
    expectProblem(denied, 403, 'PERMISSION_DENIED');
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_MANAGE' });
    // O gestor de contratações escreve.
    expect(
      (
        await post(
          `/workflow-versions/${v2}/stages`,
          { key: 'GESTOR', name: 'Gestor', type: 'TASK' },
          'sub-lucia',
        )
      ).status,
    ).toBe(201);
    // Sem vínculo de leitura (REQUISITANTE tem WORKFLOW_VIEW; quem não tem perfil, não).
    expectProblem(
      await post('/workflows', { key: 'NEGADO', name: 'Negado' }, 'sub-ana'),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('[Permissão] Escrita sem MFA quando a política exige → 403 MFA_REQUIRED', async () => {
    const stage = (await versionOf(v2)).stages[0] as WorkflowStageDto;
    const response = await patch(
      `/workflow-stages/${stage.id}`,
      { name: 'Sem MFA' },
      stage.version ?? 1,
      'sub-marta',
      ['pwd'],
    );
    expectProblem(response, 403, 'MFA_REQUIRED');
    expect((await versionOf(v2)).stages[0]?.name).toBe(stage.name);
  });

  it('[Tenant incorreto] Versão e etapa de outro tenant', async () => {
    const other = await createWorkflow('FLUXO_B', 'sub-heitor');
    const otherVersion = other.draftVersion?.id ?? '';
    const otherStage = await addStage(
      otherVersion,
      { key: 'ETAPA_B', name: 'Etapa de B', type: 'TASK' },
      'sub-heitor',
    );

    for (const response of [
      await get(`/workflow-versions/${otherVersion}`),
      await get(`/workflows/${other.id}`),
      await get(`/workflows/${other.id}/versions`),
      await patch(`/workflow-stages/${otherStage.id}`, { name: 'Invasão' }, 1),
      await del(`/workflow-stages/${otherStage.id}`, 1),
      await post(`/workflow-versions/${otherVersion}/stages`, {
        key: 'XX',
        name: 'Invasão',
        type: 'TASK',
      }),
    ]) {
      expectProblem(response, 404, 'NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('FLUXO_B');
    }

    const mine = await versionOf(v2);
    const transition = await post(`/workflow-versions/${v2}/transitions`, {
      key: 'PARA_B',
      name: 'Para B',
      fromStageId: mine.stages[0]?.id,
      toStageId: otherStage.id,
      action: 'FORWARD',
    });
    expect(expectProblem(transition, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'toStageId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    // copyFromVersionId de outro tenant (ou rascunho) → REFERENCE_NOT_FOUND (FA-01).
    const copy = await post(
      '/workflows',
      { key: 'COPIA_B', name: 'Cópia de B', copyFromVersionId: otherVersion },
      'sub-marta',
      {
        key: randomUUID(),
      },
    );
    expect(expectProblem(copy, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'copyFromVersionId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
  });

  it('[FA-01] Cópia de outro workflow publicado do tenant: v1 nasce com a definição copiada', async () => {
    const copy = await createWorkflow('OBRAS_COPIA', 'sub-marta', { copyFromVersionId: v1 });
    const version = await versionOf(copy.draftVersion?.id ?? '');
    expect(version.stages.map((s) => s.key)).toEqual(['ABERTURA', 'ANALISE', 'APROVACAO', 'FIM']);
    expect(version.transitions).toHaveLength(6);
    expect(auditOf('workflow.create').at(-1)?.metadata).toMatchObject({ copyFromVersionId: v1 });
  });

  it('[Concorrência] Duas pessoas alteram a mesma etapa com o mesmo If-Match', async () => {
    const analise = (await versionOf(v2)).stages.find(
      (s) => s.key === 'ANALISE',
    ) as WorkflowStageDto;
    const etag = analise.version ?? 1;
    const rafael = await patch(
      `/workflow-stages/${analise.id}`,
      { slaDays: 10 },
      etag,
      'sub-marta',
    );
    const patricia = await patch(
      `/workflow-stages/${analise.id}`,
      { name: 'Análise técnica' },
      etag,
      'sub-otavio',
    );
    expect(rafael.status, JSON.stringify(rafael.body)).toBe(200);
    expect(rafael.headers.etag).toBe(`"${etag + 1}"`);
    expect(expectProblem(patricia, 412, 'VERSION_CONFLICT')).toMatchObject({
      currentVersion: etag + 1,
    });
    expectProblem(
      await patch(`/workflow-stages/${analise.id}`, { slaDays: 9 }, null),
      428,
      'PRECONDITION_REQUIRED',
    );
  });

  it('WF-04/11/14/17: atualizações e exclusões com auditoria de expressão por hash', async () => {
    const renamed = await patch(
      `/workflows/${obras.id}`,
      { name: 'Obras e engenharia' },
      obras.version + 1,
    );
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(auditOf('workflow.update').at(-1)).toMatchObject({
      entityType: 'Workflow',
      changes: [{ path: 'name', old: 'Obras e serviços de engenharia', new: 'Obras e engenharia' }],
    });
    expectProblem(
      await patch(`/workflows/${obras.id}`, { key: 'OUTRA' }, 1),
      422,
      'VALIDATION_ERROR',
    );

    const draft = await versionOf(v2);
    const condition = draft.rules.find((rule) => rule.type === 'CONDITION') as WorkflowRuleDto;
    const updated = await patch(
      `/workflow-rules/${condition.id}`,
      { config: { expression: { '>=': [{ var: 'process.itemsCount' }, 1] } } },
      condition.version ?? 1,
    );
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const changes = auditOf('workflow.update').at(-1)?.changes as
      readonly { path: string }[] | null | undefined;
    const change = changes?.find((c) => c.path === 'config');
    expect(change).toMatchObject({
      old: {
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        size: expect.any(Number) as unknown,
      },
      new: {
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        size: expect.any(Number) as unknown,
      },
    });
    expect(JSON.stringify(auditOf('workflow.update').at(-1))).not.toContain('itemsCount');

    // Escopo de transição só em FORWARD/COMPLETE/APPROVE; regra numa devolução → NOT_ALLOWED.
    const back = draft.transitions.find((t) => t.action === 'RETURN') as WorkflowTransitionDto;
    const onReturn = await post(`/workflow-versions/${v2}/rules`, {
      scope: 'TRANSITION',
      transitionId: back.id,
      type: 'REQUIRED_FIELD',
      name: 'Regra na devolução',
      message: 'Mensagem válida',
      config: { field: 'process.year' },
    });
    expect(expectProblem(onReturn, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'transitionId', code: 'NOT_ALLOWED' }),
    ]);

    // Transição: RETURN força comentário; ação incompatível com a origem → NOT_ALLOWED em action.
    const updatedBack = await patch(
      `/workflow-transitions/${back.id}`,
      { requiresComment: false, name: 'Devolver' },
      back.version ?? 1,
    );
    expect(data<WorkflowTransitionDto>(updatedBack).requiresComment).toBe(true);
    const fim = draft.stages.find((s) => s.key === 'FIM') as WorkflowStageDto;
    const fromEnd = await post(`/workflow-versions/${v2}/transitions`, {
      key: 'DO_FIM',
      name: 'Do fim',
      fromStageId: fim.id,
      toStageId: draft.stages[0]?.id,
      action: 'FORWARD',
    });
    expect(expectProblem(fromEnd, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'action', code: 'NOT_ALLOWED' }),
    ]);

    // Excluir a etapa é restritivo (US-043 · RN-WF-50): bloqueado enquanto houver transições e
    // regras apontando para ela — uma violação por item; removidas, a exclusão passa.
    const before = await versionOf(v2);
    const analise = before.stages.find((s) => s.key === 'ANALISE') as WorkflowStageDto;
    const linked = before.transitions.filter(
      (t) => t.fromStageId === analise.id || t.toStageId === analise.id,
    );
    const linkedRules = before.rules.filter((r) => r.stageId === analise.id);
    const blocked = expectProblem(
      await del(`/workflow-stages/${analise.id}`, analise.version ?? 1),
      422,
      'BUSINESS_RULE_VIOLATION',
    );
    expect(blocked.violations.map((v) => v.itemId).sort()).toEqual(
      [...linked.map((t) => t.id), ...linkedRules.map((r) => r.id)].sort(),
    );
    for (const rule of before.rules.filter(
      (r) => linkedRules.includes(r) || linked.some((t) => t.id === r.transitionId),
    )) {
      expect((await del(`/workflow-rules/${rule.id}`, rule.version ?? 1)).status).toBe(204);
    }
    for (const transition of linked) {
      expect(
        (await del(`/workflow-transitions/${transition.id}`, transition.version ?? 1)).status,
      ).toBe(204);
    }
    expect((await del(`/workflow-stages/${analise.id}`, analise.version ?? 1)).status).toBe(204);
    const after = await versionOf(v2);
    expect(after.stages.some((s) => s.id === analise.id)).toBe(false);
  });

  it('[Falha de integração] Redis indisponível: definição publicada lida do banco com warn', async () => {
    const cache = api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failing = vi.spyOn(cache, 'get').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const snapshot = await runAsSystem({ name: 'motor', tenantId: A }, () =>
        facade.publishedDefinition(v1),
      );
      expect(snapshot?.stages).toHaveLength(4);
      expect((await get(`/workflow-versions/${v1}`)).status).toBe(200);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'workflow.definition_cache_unavailable' }),
        'workflow.definition_cache_unavailable',
      );
    } finally {
      failing.mockRestore();
      warn.mockRestore();
    }
    // Com o Redis de volta: a definição fica em cache e é servida de lá; rascunho não tem snapshot.
    await runAsSystem({ name: 'motor', tenantId: A }, () => facade.publishedDefinition(v1));
    const cached = await runAsSystem({ name: 'motor', tenantId: A }, () =>
      facade.publishedDefinition(v1),
    );
    expect(cached?.initialStageKey).toBe('ABERTURA');
    expect(
      await runAsSystem({ name: 'motor', tenantId: A }, () => facade.publishedDefinition(v2)),
    ).toBeNull();
  });

  it('[Falha de banco] Banco indisponível ao criar workflow → 503 com Retry-After, nada persistido', async () => {
    const audits = api.auditRecords().length;
    const events = api.outboxRows().length;
    const workflows = repository.workflows.size;
    transactions.down = true;

    const response = await post(
      '/workflows',
      { key: 'SEM_BANCO', name: 'Sem banco' },
      'sub-marta',
      {
        key: randomUUID(),
      },
    );

    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
    expect(repository.workflows.size).toBe(workflows);
    expect(api.auditRecords()).toHaveLength(audits);
    expect(api.outboxRows()).toHaveLength(events);
  });

  it('[Sucesso] Publicar a v2 aposenta a v1 (supersedida)', async () => {
    const parked = await createWorkflow('SUCESSAO');
    const first = parked.draftVersion?.id ?? '';
    await buildValidDraft(first);
    await publish(first);
    const second = data<WorkflowVersionDetailDto>(
      await post(`/workflows/${parked.id}/versions`, {}),
    );

    const result = await publish(second.id);

    expect(result.retiredVersionId).toBe(first);
    expect((await versionOf(first)).status).toBe('RETIRED');
    expect((await versionOf(second.id)).status).toBe('PUBLISHED');
    expect(eventsOf('WorkflowVersionRetired').at(-1)?.payload).toEqual({
      workflowId: parked.id,
      workflowVersionId: first,
    });
    expect(auditOf('workflow.version_retire').at(-1)?.metadata).toMatchObject({
      reason: 'SUPERSEDED',
    });
    // Clonar a partir de uma versão aposentada é permitido (sourceVersionId).
    const third = await post(`/workflows/${parked.id}/versions`, { sourceVersionId: first });
    expect(data<WorkflowVersionDetailDto>(third)).toMatchObject({
      versionNumber: 3,
      status: 'DRAFT',
    });
  });
});

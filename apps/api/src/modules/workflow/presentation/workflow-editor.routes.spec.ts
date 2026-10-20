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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAsSystem } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
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
 * US-043 — Editor de workflow (etapas e transições) pelo pipeline HTTP completo: os 9 cenários
 * Gherkin da story, a exclusão restritiva (RN-WF-50 · FA-01), "Criar rascunho" sem publicada
 * (RN-WF-47), o filtro `status` do WF-01 e os logs de salvamento. "Carla" = `sub-marta`
 * (ADMIN_ORGAO, `WORKFLOW_MANAGE`); "Daniel" = `sub-fabio` (COMPRAS, só `WORKFLOW_VIEW`); a
 * "Prefeitura B" = `sub-heitor`. O outbox `PENDING` real, a concorrência e o isolamento no
 * PostgreSQL estão em `test/tenant-leak/workflow-editor.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MFA = ['pwd', 'otp'];

type User = 'sub-marta' | 'sub-fabio' | 'sub-heitor';

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

describe('Feature: Editor de workflow (etapas e transições) (US-043)', () => {
  let api: TestApi;
  let repository: InMemoryWorkflowRepository;
  let facade: WorkflowFacade;
  const transactions = new FlakyTransactions();
  const logs: unknown[] = [];

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(message);
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(message);
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logs.push(message);
    });
    api = await createTestApi({
      providers: [{ token: WORKFLOW_TRANSACTIONS, value: transactions }],
    });
    repository = api.app.get(InMemoryWorkflowRepository, { strict: false });
    facade = api.app.get(WorkflowFacade, { strict: false });
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
      .set('If-Match', `"${ifMatch}"`)
      .send(body);
  const del = (path: string, ifMatch: number, user: User = 'sub-marta') =>
    as(request(api.server).delete(`/api/v1${path}`), user).set('If-Match', `"${ifMatch}"`);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (type: string) => api.outboxRows().filter((row) => row.eventType === type);
  const logged = (event: string) =>
    logs.filter(
      (entry) =>
        typeof entry === 'object' && entry !== null && 'event' in entry && entry.event === event,
    );

  const createWorkflow = async (key: string, name: string, user: User = 'sub-marta') => {
    const response = await post('/workflows', { key, name }, user);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowDto>(response);
  };
  const versionOf = async (versionId: string) => {
    const response = await get(`/workflow-versions/${versionId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<WorkflowVersionDetailDto>(response);
  };
  const addStage = async (versionId: string, body: object) => {
    const response = await post(`/workflow-versions/${versionId}/stages`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };
  const addTransition = async (versionId: string, body: object) => {
    const response = await post(`/workflow-versions/${versionId}/transitions`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowTransitionDto>(response);
  };

  // Estado compartilhado pelos cenários em sequência ("Obras — rito simplificado").
  let obras: WorkflowDto;
  let draftId: string;
  let abertura: WorkflowStageDto;
  let parecer: WorkflowStageDto;
  let encaminhar: WorkflowTransitionDto;

  it('[Sucesso] Criar workflow com rascunho inicial (v1 em DRAFT, WorkflowCreated)', async () => {
    const events = eventsOf('WorkflowCreated').length;
    obras = await createWorkflow('OBRAS_RITO_SIMPLIFICADO', 'Obras — rito simplificado');

    expect(obras.draftVersion).toMatchObject({ versionNumber: 1 });
    expect(obras.currentPublishedVersion).toBeNull();
    draftId = obras.draftVersion?.id ?? '';
    expect(await versionOf(draftId)).toMatchObject({
      status: 'DRAFT',
      versionNumber: 1,
      stages: [],
      transitions: [],
    });
    expect(eventsOf('WorkflowCreated')).toHaveLength(events + 1);
    expect(eventsOf('WorkflowCreated').at(-1)?.payload).toEqual({
      workflowId: obras.id,
      key: 'OBRAS_RITO_SIMPLIFICADO',
    });
    expect(auditOf('workflow.create').at(-1)).toMatchObject({
      entityId: obras.id,
      category: 'CONFIGURATION',
    });
    expect(logged('workflow.created').at(-1)).toMatchObject({ workflowId: obras.id });
  });

  it('[Sucesso] Adicionar etapa e transição ao rascunho, com auditoria por operação', async () => {
    const audits = auditOf('workflow.update').length;
    abertura = await addStage(draftId, { key: 'ABERTURA', name: 'Abertura', type: 'START' });
    parecer = await addStage(draftId, {
      key: 'PARECER_JURIDICO',
      name: 'Parecer jurídico',
      type: 'TASK',
    });
    encaminhar = await addTransition(draftId, {
      key: 'ENCAMINHAR_JURIDICO',
      name: 'Encaminhar para o jurídico',
      fromStageId: abertura.id,
      toStageId: parecer.id,
      action: 'FORWARD',
      isPrimary: true,
    });

    const version = await versionOf(draftId);
    expect(version.stages.map((stage) => [stage.key, stage.displayOrder])).toEqual([
      ['ABERTURA', 0],
      ['PARECER_JURIDICO', 1],
    ]);
    expect(version.transitions).toEqual([
      expect.objectContaining({ id: encaminhar.id, action: 'FORWARD', isPrimary: true }),
    ]);
    const updates = auditOf('workflow.update').slice(audits);
    expect(updates.map((record) => [record.entityType, record.category])).toEqual([
      ['WorkflowStage', 'CONFIGURATION'],
      ['WorkflowStage', 'CONFIGURATION'],
      ['WorkflowTransition', 'CONFIGURATION'],
    ]);
    expect(logged('workflow.stage_saved').at(-1)).toMatchObject({
      workflowVersionId: draftId,
      entityId: parecer.id,
      operation: 'CREATE',
    });
    expect(logged('workflow.transition_saved').at(-1)).toMatchObject({
      entityId: encaminhar.id,
      operation: 'CREATE',
    });
    // Edição de rascunho não gera evento de domínio.
    expect(eventsOf('WorkflowVersionPublished')).toHaveLength(0);
  });

  it('[Validação] Etapa de aprovação sem aprovador → 422 em approverType', async () => {
    const response = await post(`/workflow-versions/${draftId}/stages`, {
      key: 'APROVACAO',
      name: 'Aprovação',
      type: 'APPROVAL',
    });
    expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({
        field: 'approverType',
        code: 'CONDITIONAL_REQUIRED',
        message: 'Selecione quem aprova esta etapa.',
      }),
    ]);
    // V-04: unidade fixa sem unidade; V-05: origem igual ao destino.
    const fixed = await post(`/workflow-versions/${draftId}/stages`, {
      key: 'FIXA',
      name: 'Etapa fixa',
      type: 'TASK',
      departmentResolution: 'FIXED',
    });
    expect(expectProblem(fixed, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({
        field: 'fixedDepartmentId',
        message: 'Selecione a unidade responsável.',
      }),
    ]);
    const loop = await post(`/workflow-versions/${draftId}/transitions`, {
      key: 'LACO',
      name: 'Laço',
      fromStageId: parecer.id,
      toStageId: parecer.id,
      action: 'FORWARD',
    });
    expectProblem(loop, 422, 'VALIDATION_ERROR');
    expect((await versionOf(draftId)).stages).toHaveLength(2);
  });

  it('[Permissão] Usuário com apenas WORKFLOW_VIEW lê o editor, mas não escreve', async () => {
    expect((await get(`/workflows/${obras.id}`, 'sub-fabio')).status).toBe(200);
    expect((await get(`/workflow-versions/${draftId}`, 'sub-fabio')).status).toBe(200);
    const denied = await post(
      `/workflow-versions/${draftId}/stages`,
      { key: 'NEGADA', name: 'Negada', type: 'TASK' },
      'sub-fabio',
    );
    expectProblem(denied, 403, 'PERMISSION_DENIED');
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_MANAGE' });
    expectProblem(
      await post('/workflows', { key: 'NEGADO', name: 'Negado' }, 'sub-fabio'),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('[Tenant incorreto] Workflow de outro tenant → 404 sem revelar a existência', async () => {
    const other = await createWorkflow('FLUXO_INTERNO', 'Fluxo interno LEAK-B', 'sub-heitor');
    for (const response of [
      await get(`/workflows/${other.id}`),
      await get(`/workflow-versions/${other.draftVersion?.id ?? ''}`),
      await post(`/workflows/${other.id}/versions`, {}),
    ]) {
      expectProblem(response, 404, 'NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    const list = data<WorkflowDto[]>(await get('/workflows'));
    expect(list.some((workflow) => workflow.id === other.id)).toBe(false);
  });

  it('[Duplicidade] Criar rascunho quando já existe um → 409 com o rascunho existente', async () => {
    // Publica a v1 (rotina interna — WF-21 chega com a US-045) e abre o rascunho v2.
    await addStage(draftId, { key: 'FIM', name: 'Fim', type: 'END' });
    const fim = (await versionOf(draftId)).stages.find((s) => s.key === 'FIM') as WorkflowStageDto;
    await addTransition(draftId, {
      key: 'CONCLUIR',
      name: 'Concluir',
      fromStageId: parecer.id,
      toStageId: fim.id,
      action: 'COMPLETE',
    });
    await patch(
      `/workflow-stages/${abertura.id}`,
      { instructions: 'Abra o processo.', documentTypeCodes: ['DFD'] },
      abertura.version ?? 1,
    );
    await patch(
      `/workflow-stages/${parecer.id}`,
      { instructions: 'Emita o parecer.' },
      parecer.version ?? 1,
    );
    await runAsSystem({ name: 'test.publisher', tenantId: A }, () =>
      facade.publish({ versionId: draftId }),
    );
    const created = await post(`/workflows/${obras.id}/versions`, undefined);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const v2 = data<WorkflowVersionDetailDto>(created);
    expect(v2).toMatchObject({ versionNumber: 2, status: 'DRAFT' });
    expect(v2.stages.map((stage) => stage.key)).toEqual(['ABERTURA', 'PARECER_JURIDICO', 'FIM']);
    expect(auditOf('workflow.version_create').at(-1)?.metadata).toMatchObject({
      sourceVersionId: draftId,
      newVersionId: v2.id,
    });

    const again = await post(`/workflows/${obras.id}/versions`, {});
    expect(expectProblem(again, 409, 'WORKFLOW_DRAFT_EXISTS')).toMatchObject({
      meta: { draftVersionId: v2.id },
    });
    expect(logged('workflow.draft_conflict').at(-1)).toMatchObject({
      workflowId: obras.id,
      draftVersionId: v2.id,
    });
    // FA-02: a v1 publicada não aceita mais escrita.
    expectProblem(
      await patch(`/workflow-stages/${parecer.id}`, { name: 'Outro nome' }, parecer.version ?? 1),
      409,
      'WORKFLOW_VERSION_NOT_DRAFT',
    );
    draftId = v2.id;
    abertura = v2.stages[0] as WorkflowStageDto;
    parecer = v2.stages[1] as WorkflowStageDto;
    encaminhar = v2.transitions.find(
      (t) => t.key === 'ENCAMINHAR_JURIDICO',
    ) as WorkflowTransitionDto;
  });

  it('[Validação] RN-WF-47: "Criar rascunho" sem versão publicada → 422 BUSINESS_RULE_VIOLATION', async () => {
    const piloto = await createWorkflow('PILOTO_SEM_PUBLICADA', 'Piloto sem publicada');
    // Descarta o rascunho v1 (só o repositório em memória permite) para restar nada publicado.
    repository.versions.delete(piloto.draftVersion?.id ?? '');
    const response = await post(`/workflows/${piloto.id}/versions`, {});
    expect(expectProblem(response, 422, 'BUSINESS_RULE_VIOLATION').violations).toEqual([
      expect.objectContaining({ code: 'WORKFLOW_NOT_PUBLISHED', ruleId: 'RN-WF-47' }),
    ]);
  });

  it('[Concorrência] Duas edições simultâneas da mesma etapa: uma 200, outra 412', async () => {
    const etag = parecer.version ?? 1;
    const [carla, daniel] = await Promise.all([
      patch(`/workflow-stages/${parecer.id}`, { slaDays: 10 }, etag),
      patch(`/workflow-stages/${parecer.id}`, { name: 'Parecer da procuradoria' }, etag),
    ]);
    const statuses = [carla.status, daniel.status].sort();
    expect(statuses).toEqual([200, 412]);
    const winner = carla.status === 200 ? carla : daniel;
    const loser = carla.status === 200 ? daniel : carla;
    expect(winner.headers.etag).toBe(`"${etag + 1}"`);
    expectProblem(loser, 412, 'VERSION_CONFLICT');
    parecer = data<WorkflowStageDto>(winner);
  });

  it('[Validação] RN-WF-50: excluir etapa referenciada é bloqueado e lista as transições', async () => {
    const blocked = expectProblem(
      await del(`/workflow-stages/${parecer.id}`, parecer.version ?? 1),
      422,
      'BUSINESS_RULE_VIOLATION',
    );
    const linked = (await versionOf(draftId)).transitions.filter(
      (t) => t.fromStageId === parecer.id || t.toStageId === parecer.id,
    );
    expect(blocked.violations.map((violation) => violation.itemId).sort()).toEqual(
      linked.map((t) => t.id).sort(),
    );
    expect(blocked.violations[0]).toMatchObject({
      code: 'REFERENCED_BY_TRANSITION',
      message: 'Remova primeiro as transições que usam esta etapa.',
      ruleId: 'RN-WF-50',
      params: expect.objectContaining({ kind: 'TRANSITION' }) as unknown,
    });
    expect((await versionOf(draftId)).stages.some((s) => s.id === parecer.id)).toBe(true);

    // Transição com regra apontando para ela também é bloqueada; sem a regra, sai.
    const rule = await post(`/workflow-versions/${draftId}/rules`, {
      scope: 'TRANSITION',
      transitionId: encaminhar.id,
      type: 'REQUIRED_FIELD',
      name: 'Objeto informado',
      message: 'Informe o objeto antes de encaminhar.',
      config: { field: 'process.year' },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const ruleId = data<{ id: string; version: number }>(rule).id;
    const transitionBlocked = expectProblem(
      await del(`/workflow-transitions/${encaminhar.id}`, encaminhar.version ?? 1),
      422,
      'BUSINESS_RULE_VIOLATION',
    );
    expect(transitionBlocked.violations).toEqual([
      expect.objectContaining({ code: 'REFERENCED_BY_RULE', itemId: ruleId }),
    ]);
    expect((await del(`/workflow-rules/${ruleId}`, 1)).status).toBe(204);
    expect(
      (await del(`/workflow-transitions/${encaminhar.id}`, encaminhar.version ?? 1)).status,
    ).toBe(204);
    expect(logged('workflow.transition_saved').at(-1)).toMatchObject({
      entityId: encaminhar.id,
      operation: 'DELETE',
    });
  });

  it('[Falha de banco] Banco indisponível ao adicionar etapa → 503, nada parcial', async () => {
    const audits = api.auditRecords().length;
    const stages = repository.stages.size;
    transactions.down = true;

    const response = await post(`/workflow-versions/${draftId}/stages`, {
      key: 'SEM_BANCO',
      name: 'Sem banco',
      type: 'TASK',
    });

    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(repository.stages.size).toBe(stages);
    expect(api.auditRecords()).toHaveLength(audits);
    expect(logged('workflow.write_failed').at(-1)).toMatchObject({
      cause: 'DEPENDENCY_UNAVAILABLE',
    });
  });

  it('[Falha de integração] Sem relay do outbox, criar workflow responde 201 e o evento fica gravado', async () => {
    const events = eventsOf('WorkflowCreated').length;
    const created = await post('/workflows', { key: 'SEM_RELAY', name: 'Sem relay' });
    expect(created.status).toBe(201);
    // O outbox em memória não tem relay: o evento fica registrado à espera da publicação (o
    // status `PENDING` no banco é conferido na suíte tenant leak).
    expect(eventsOf('WorkflowCreated')).toHaveLength(events + 1);
  });

  it('WF-01: filtro status=ACTIVE|INACTIVE e busca q', async () => {
    const parked = await createWorkflow('INATIVO_TESTE', 'Inativo de teste');
    const stored = repository.workflows.get(parked.id);
    if (stored) repository.workflows.set(parked.id, { ...stored, isActive: false });

    const inactive = data<WorkflowDto[]>(await get('/workflows?status=INACTIVE'));
    expect(inactive.map((workflow) => workflow.id)).toEqual([parked.id]);
    const active = data<WorkflowDto[]>(await get('/workflows?status=ACTIVE'));
    expect(active.some((workflow) => workflow.id === parked.id)).toBe(false);
    expect(active.some((workflow) => workflow.id === obras.id)).toBe(true);
    const searched = data<WorkflowDto[]>(await get('/workflows?q=rito'));
    expect(searched.map((workflow) => workflow.id)).toEqual([obras.id]);
    expectProblem(await get('/workflows?status=OUTRO'), 422, 'VALIDATION_ERROR');
  });
});

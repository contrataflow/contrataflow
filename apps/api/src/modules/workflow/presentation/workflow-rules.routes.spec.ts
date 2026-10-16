import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  ruleContextSchemaDtoSchema,
  workflowRuleTestResultSchema,
} from '@contrataflow/validation';
import type {
  RuleContextSchemaDto,
  WorkflowDto,
  WorkflowRuleDto,
  WorkflowRuleTestResult,
  WorkflowStageDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { processRuntimeStore } from '../../../../test/support/structure-fixtures.js';
import {
  dec015Workflow,
  etp,
  passesUntilStudies,
  processRuntime,
  seedPublishedInMemory,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import { WORKFLOW_TRANSACTIONS } from '../application/ports.js';
import type { WorkflowTransactions } from '../application/ports.js';
import { InMemoryWorkflowTransactions } from '../infrastructure/in-memory-workflow.repository.js';

/*
 * US-044 — Regras de etapa e de transição pelo pipeline HTTP completo: os 7 cenários Gherkin de API
 * (o de "Falha de integração" é do front — `workflow-rules.test.tsx`), RN-WF-56 (caminho fora do
 * schema aceito no rascunho), FA-04 ("Campo não reconhecido" no teste), V-09, o schema do
 * RuleContext (WF-19) e os logs. "Carla" = `sub-marta` (ADMIN_ORGAO, `WORKFLOW_MANAGE` e
 * `PROCESS_VIEW` no tenant); "Bruno" = `sub-fabio` (só `WORKFLOW_VIEW`); a "Prefeitura B" =
 * `sub-heitor`. O isolamento no PostgreSQL está em `test/tenant-leak/workflow-rules.spec.ts`.
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

describe('Feature: Regras de etapa e de transição (US-044)', () => {
  let api: TestApi;
  let store: ReturnType<typeof processRuntimeStore>;
  const transactions = new FlakyTransactions();
  const logs: unknown[] = [];

  // Processos de referência: 0012/2026 (tenant A, ETP em rascunho) e um da Prefeitura B.
  const P0012 = newId();
  const P_B = newId();
  const pinnedA = dec015Workflow(new DefinitionBuilder(newId()));
  const pinnedB = dec015Workflow(new DefinitionBuilder(newId()));

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logs.push(message);
      });
    }
    api = await createTestApi({
      providers: [{ token: WORKFLOW_TRANSACTIONS, value: transactions }],
    });
    store = processRuntimeStore(api);
    api.app.get(DocumentTypeCatalog).register({
      codesOf: () =>
        Promise.resolve({ active: new Set(['DFD', 'ETP', 'TR']), inactive: new Set(['ANTIGO']) }),
    });
    await seedPublishedInMemory(api, A, pinnedA, 'FASE_PREPARATORIA_FIXADA');
    await seedPublishedInMemory(api, B, pinnedB, 'FASE_PREPARATORIA_FIXADA');
    store.save(
      processRuntime({
        id: P0012,
        tenantId: A,
        workflowVersionId: pinnedA.versionId,
        passes: passesUntilStudies(pinnedA),
        documents: [etp('DRAFT', false)],
      }),
    );
    store.save(
      processRuntime({
        id: P_B,
        tenantId: B,
        workflowVersionId: pinnedB.versionId,
        passes: passesUntilStudies(pinnedB),
      }),
    );
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
  const post = (path: string, body: object, user: User = 'sub-marta') =>
    as(request(api.server).post(`/api/v1${path}`), user)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const patch = (path: string, body: object, ifMatch: number, user: User = 'sub-marta') =>
    as(request(api.server).patch(`/api/v1${path}`), user)
      .set('If-Match', `"${ifMatch}"`)
      .send(body);
  const del = (path: string, ifMatch: number, user: User = 'sub-marta') =>
    as(request(api.server).delete(`/api/v1${path}`), user).set('If-Match', `"${ifMatch}"`);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const logged = (event: string) =>
    logs.filter(
      (entry) =>
        typeof entry === 'object' && entry !== null && 'event' in entry && entry.event === event,
    );
  const versionOf = async (versionId: string) => {
    const response = await get(`/workflow-versions/${versionId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<WorkflowVersionDetailDto>(response);
  };

  // Background: "Fase preparatória — Lei 14.133/2021" com rascunho e as duas etapas.
  let draftId: string;
  let estudos: WorkflowStageDto;
  let autoridade: WorkflowStageDto;
  let etpRule: WorkflowRuleDto;

  const testBody = (overrides: object = {}) => ({
    type: 'REQUIRED_DOCUMENT',
    config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
    message: 'O ETP deve estar completo.',
    processId: P0012,
    ...overrides,
  });

  it('Background: workflow em rascunho com ESTUDOS_PRELIMINARES e APROVACAO_AUTORIDADE', async () => {
    const created = await post('/workflows', {
      key: 'FASE_PREPARATORIA',
      name: 'Fase preparatória — Lei 14.133/2021',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    draftId = data<WorkflowDto>(created).draftVersion?.id ?? '';
    const stage = async (body: object) => {
      const response = await post(`/workflow-versions/${draftId}/stages`, body);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return data<WorkflowStageDto>(response);
    };
    estudos = await stage({
      key: 'ESTUDOS_PRELIMINARES',
      name: 'Estudos preliminares',
      type: 'TASK',
    });
    autoridade = await stage({
      key: 'APROVACAO_AUTORIDADE',
      name: 'Aprovação da autoridade',
      type: 'APPROVAL',
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    });
    expect(autoridade.type).toBe('APPROVAL');
  });

  it('[Sucesso] Criar regra de documento obrigatório na saída de uma etapa', async () => {
    const audits = auditOf('workflow.update').length;
    const response = await post(`/workflow-versions/${draftId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: estudos.id,
      type: 'REQUIRED_DOCUMENT',
      name: 'ETP completo',
      severity: 'BLOCKING',
      config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
      message: 'O ETP deve estar completo.',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    etpRule = data<WorkflowRuleDto>(response);
    expect(etpRule).toMatchObject({
      scope: 'STAGE_EXIT',
      stageId: estudos.id,
      transitionId: null,
      isActive: true,
    });
    expect((await versionOf(draftId)).rules).toEqual([
      expect.objectContaining({ id: etpRule.id, stageId: estudos.id }),
    ]);
    const [audit] = auditOf('workflow.update').slice(audits);
    expect(audit).toMatchObject({
      entityType: 'WorkflowRule',
      entityId: etpRule.id,
      category: 'CONFIGURATION',
      metadata: expect.objectContaining({
        ruleId: etpRule.id,
        type: 'REQUIRED_DOCUMENT',
        scope: 'STAGE_EXIT',
        stageId: estudos.id,
      }) as unknown,
    });
    expect(logged('workflow.rule_saved').at(-1)).toMatchObject({
      workflowVersionId: draftId,
      entityId: etpRule.id,
      operation: 'CREATE',
    });
  });

  it('[Validação] Tipo de documento inativo → 422 REFERENCE_INACTIVE em config.documentTypeCode', async () => {
    const response = await post(`/workflow-versions/${draftId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: estudos.id,
      type: 'REQUIRED_DOCUMENT',
      name: 'Documento antigo',
      config: { documentTypeCode: 'ANTIGO', minStatus: 'EXISTS' },
      message: 'Anexe o documento antigo.',
    });
    expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'config.documentTypeCode', code: 'REFERENCE_INACTIVE' }),
    ]);
  });

  it('V-02/V-04/V-05: âmbito incompatível, aprovação que não é APPROVAL e mensagem longa', async () => {
    const base = { name: 'Regra', message: 'Mensagem ao usuário.' };
    const scope = await post(`/workflow-versions/${draftId}/rules`, {
      ...base,
      scope: 'TRANSITION',
      stageId: estudos.id,
      type: 'REQUIRED_FIELD',
      config: { field: 'process.year' },
    });
    expect(
      expectProblem(scope, 422, 'VALIDATION_ERROR').errors.map((error) => error.field),
    ).toEqual(expect.arrayContaining(['transitionId', 'stageId']));
    const approval = await post(`/workflow-versions/${draftId}/rules`, {
      ...base,
      scope: 'STAGE_EXIT',
      stageId: autoridade.id,
      type: 'REQUIRED_APPROVAL',
      config: { stageKey: 'ESTUDOS_PRELIMINARES' },
    });
    expect(expectProblem(approval, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'config.stageKey', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const tooLong = await post(`/workflow-versions/${draftId}/rules`, {
      ...base,
      message: 'x'.repeat(501),
      scope: 'STAGE_EXIT',
      stageId: estudos.id,
      type: 'REQUIRED_FIELD',
      config: { field: 'process.year' },
    });
    expect(expectProblem(tooLong, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'message', code: 'TOO_LONG' }),
    ]);
  });

  it('RN-WF-56 · FA-04: REQUIRED_FIELD com caminho fora do schema é aceito no rascunho', async () => {
    const response = await post(`/workflow-versions/${draftId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: estudos.id,
      type: 'REQUIRED_FIELD',
      name: 'Campo colado',
      severity: 'WARNING',
      config: { field: 'process.codigoInterno' },
      message: 'Preencha o código interno.',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const rule = data<WorkflowRuleDto>(response);
    // A publicação (US-045) é que barra: WF_RULE_PATH_UNKNOWN na validação da versão.
    const removed = await del(`/workflow-rules/${rule.id}`, 1);
    expect(removed.status).toBe(204);
  });

  it('[Permissão] Usuário somente leitura tenta criar regra → 403 e access.denied', async () => {
    const response = await post(
      `/workflow-versions/${draftId}/rules`,
      {
        scope: 'STAGE_EXIT',
        stageId: estudos.id,
        type: 'REQUIRED_FIELD',
        name: 'Ano',
        config: { field: 'process.year' },
        message: 'Informe o ano.',
      },
      'sub-fabio',
    );
    expectProblem(response, 403, 'PERMISSION_DENIED');
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_MANAGE' });
    // O teste de regra também exige WORKFLOW_MANAGE (WF-23).
    expectProblem(
      await post(`/workflow-versions/${draftId}/rules/test`, testBody(), 'sub-fabio'),
      403,
      'PERMISSION_DENIED',
    );
    // WORKFLOW_VIEW basta para ler o schema do contexto (WF-19).
    expect((await get('/rule-context/schema', 'sub-fabio')).status).toBe(200);
  });

  it('WF-19: schema do RuleContext v1 com os documentos ATIVOS do tenant', async () => {
    const response = await get('/rule-context/schema');
    expect(response.status).toBe(200);
    const schema: RuleContextSchemaDto = ruleContextSchemaDtoSchema.parse(data(response));
    const paths = schema.fields.map((field) => field.path);
    expect(schema.version).toBe(1);
    expect(paths).toEqual(
      expect.arrayContaining(['process.estimatedValue', 'documents.ETP.isComplete', 'now']),
    );
    expect(paths.some((path) => path.startsWith('documents.ANTIGO.'))).toBe(false);
  });

  it('[Sucesso] Testar regra contra um processo real (não satisfeita → mensagem do formulário)', async () => {
    const response = await post(`/workflow-versions/${draftId}/rules/test`, testBody());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result: WorkflowRuleTestResult = workflowRuleTestResultSchema.parse(data(response));
    expect(result).toEqual({
      satisfied: false,
      severity: 'BLOCKING',
      message: 'O ETP deve estar completo.',
      contextUsed: {
        'documents.ETP': expect.objectContaining({ exists: true, status: 'DRAFT' }) as unknown,
        matchingCount: 0,
        requiredCount: 1,
      },
      warnings: [],
    });
    expect(logged('workflow.rule_tested').at(-1)).toEqual(
      expect.objectContaining({
        workflowVersionId: draftId,
        ruleType: 'REQUIRED_DOCUMENT',
        processId: P0012,
        satisfied: false,
      }),
    );
    // Satisfeita: o ETP existe (EXISTS).
    const exists = await post(
      `/workflow-versions/${draftId}/rules/test`,
      testBody({ config: { documentTypeCode: 'ETP', minStatus: 'EXISTS' }, severity: 'WARNING' }),
    );
    expect(data<WorkflowRuleTestResult>(exists)).toMatchObject({
      satisfied: true,
      severity: 'WARNING',
      message: 'Regra satisfeita.',
    });
  });

  it('[Duplicidade] Testar a mesma regra repetidamente não produz efeitos colaterais', async () => {
    const before = {
      rules: (await versionOf(draftId)).rules.length,
      audits: api.auditRecords().length,
      outbox: api.outboxRows().length,
    };
    const results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(`/workflow-versions/${draftId}/rules/test`, testBody());
      expect(response.status).toBe(200);
      results.push(data<WorkflowRuleTestResult>(response));
    }
    expect(results[2]).toEqual(results[0]);
    expect(results[2]).toEqual(results[1]);
    expect((await versionOf(draftId)).rules).toHaveLength(before.rules);
    expect(api.auditRecords()).toHaveLength(before.audits);
    expect(api.outboxRows()).toHaveLength(before.outbox);
  });

  it('[Tenant incorreto] Testar regra com processo de outro tenant → 404 igual ao inexistente', async () => {
    const other = expectProblem(
      await post(`/workflow-versions/${draftId}/rules/test`, testBody({ processId: P_B })),
      404,
      'NOT_FOUND',
    );
    const missing = expectProblem(
      await post(`/workflow-versions/${draftId}/rules/test`, testBody({ processId: newId() })),
      404,
      'NOT_FOUND',
    );
    expect(other.detail).toBe(missing.detail);
    expect(JSON.stringify(other)).not.toContain(P_B);
    // A versão de outro tenant também não existe para quem testa.
    expectProblem(
      await post(`/workflow-versions/${pinnedB.versionId}/rules/test`, testBody()),
      404,
      'NOT_FOUND',
    );
  });

  it('FA-04: teste com caminho desconhecido → não satisfeita com "Campo não reconhecido"', async () => {
    const response = await post(
      `/workflow-versions/${draftId}/rules/test`,
      testBody({ type: 'REQUIRED_FIELD', config: { field: 'process.codigoInterno' } }),
    );
    expect(data<WorkflowRuleTestResult>(response)).toMatchObject({
      satisfied: false,
      contextUsed: {},
      warnings: [{ code: 'PATH_UNKNOWN', message: 'Campo não reconhecido.' }],
    });
    expect(logged('workflow.rule_path_unknown').at(-1)).toMatchObject({
      workflowVersionId: draftId,
      ruleType: 'REQUIRED_FIELD',
    });
  });

  it('V-09: CONDITION com operador fora da allowlist → 422 WORKFLOW_INVALID; config inválida → 422', async () => {
    const forbidden = expectProblem(
      await post(
        `/workflow-versions/${draftId}/rules/test`,
        testBody({
          type: 'CONDITION',
          config: { expression: { method: [{ var: 'process.year' }, 'toString'] } },
        }),
      ),
      422,
      'WORKFLOW_INVALID',
    );
    expect(forbidden).toMatchObject({
      validation: { errors: [expect.objectContaining({ code: 'WF_RULE_OPERATOR_FORBIDDEN' })] },
    });
    const invalid = expectProblem(
      await post(
        `/workflow-versions/${draftId}/rules/test`,
        testBody({ config: { documentTypeCode: 'ETP' } }),
      ),
      422,
      'VALIDATION_ERROR',
    );
    expect(invalid.errors.map((error) => error.field)).toEqual(['config.minStatus']);
    // CONDITION válida avalia com os valores do contexto.
    const condition = await post(
      `/workflow-versions/${draftId}/rules/test`,
      testBody({
        type: 'CONDITION',
        config: { expression: { '>': [{ var: 'process.estimatedValue' }, 100000] } },
      }),
    );
    expect(data<WorkflowRuleTestResult>(condition)).toMatchObject({
      satisfied: true,
      contextUsed: { 'process.estimatedValue': 150000 },
    });
  });

  it('[Concorrência] Edição simultânea da mesma regra → uma 200 e a outra 412 VERSION_CONFLICT', async () => {
    const [diego, carla] = await Promise.all([
      patch(`/workflow-rules/${etpRule.id}`, { name: 'ETP completo (Diego)' }, 1),
      patch(`/workflow-rules/${etpRule.id}`, { name: 'ETP completo (Carla)' }, 1),
    ]);
    const statuses = [diego.status, carla.status].sort();
    expect(statuses).toEqual([200, 412]);
    const loser = diego.status === 412 ? diego : carla;
    expect(expectProblem(loser, 412, 'VERSION_CONFLICT')).toMatchObject({ currentVersion: 2 });
    // Sem If-Match → 428; recarregar e reenviar com a versão nova → 200.
    const noIfMatch = await as(
      request(api.server).patch(`/api/v1/workflow-rules/${etpRule.id}`),
      'sub-marta',
    ).send({ name: 'Sem If-Match' });
    expectProblem(noIfMatch, 428, 'PRECONDITION_REQUIRED');
    const retried = await patch(`/workflow-rules/${etpRule.id}`, { isActive: false }, 2);
    expect(retried.status).toBe(200);
    expect(retried.headers.etag).toBe('"3"');
    expect(data<WorkflowRuleDto>(retried).isActive).toBe(false);
  });

  it('FA-01: reordenar = um PATCH de displayOrder por regra alterada', async () => {
    const second = await post(`/workflow-versions/${draftId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: estudos.id,
      type: 'REQUIRED_FIELD',
      name: 'Ano informado',
      config: { field: 'process.year' },
      message: 'Informe o ano do processo.',
      displayOrder: 1,
    });
    const created = data<WorkflowRuleDto>(second);
    expect((await patch(`/workflow-rules/${created.id}`, { displayOrder: 0 }, 1)).status).toBe(200);
    expect((await patch(`/workflow-rules/${etpRule.id}`, { displayOrder: 1 }, 3)).status).toBe(200);
    const rules = (await versionOf(draftId)).rules;
    expect(
      [...rules].sort((a, b) => a.displayOrder - b.displayOrder).map((rule) => rule.id),
    ).toEqual([created.id, etpRule.id]);
  });

  it('[Falha de banco] Banco indisponível ao salvar regra → 503 e nada persistido', async () => {
    const before = (await versionOf(draftId)).rules.length;
    transactions.down = true;
    const response = await post(`/workflow-versions/${draftId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: estudos.id,
      type: 'REQUIRED_FIELD',
      name: 'Ano',
      config: { field: 'process.year' },
      message: 'Informe o ano.',
    });
    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    transactions.down = false;
    expect((await versionOf(draftId)).rules).toHaveLength(before);
  });

  it('FA-05 · RN-WF-54: versão publicada não aceita regra nova (409) — o teste continua valendo', async () => {
    const published = await post(`/workflow-versions/${pinnedA.versionId}/rules`, {
      scope: 'STAGE_EXIT',
      stageId: pinnedA.stageId('ESTUDOS_PRELIMINARES'),
      type: 'REQUIRED_FIELD',
      name: 'Ano',
      config: { field: 'process.year' },
      message: 'Informe o ano.',
    });
    expectProblem(published, 409, 'WORKFLOW_VERSION_NOT_DRAFT');
    const tested = await post(`/workflow-versions/${pinnedA.versionId}/rules/test`, testBody());
    expect(tested.status).toBe(200);
  });
});

import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  workflowStageApproversDtoSchema,
  workflowValidationResultSchema,
  workflowVersionDetailSchema,
} from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageApproversDto,
  WorkflowStageDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import type { RoleForApproval } from '../../access/application/access.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type { DepartmentForApproval } from '../../organization/application/organization.facade.js';
import { WORKFLOW_TRANSACTIONS } from '../application/ports.js';
import type { WorkflowTransactions } from '../application/ports.js';
import { InMemoryWorkflowTransactions } from '../infrastructure/in-memory-workflow.repository.js';

/*
 * US-132 — Política de decisão e aprovadores ordenados na etapa (WF-65 e as ampliações de WF-08,
 * WF-09, WF-11, WF-20 e WF-21) pelo pipeline HTTP completo: os 10 cenários Gherkin, FA-01 (voltar
 * a `ANY`), FA-03 (rascunho incompleto), FA-04 (não resolvível e sem titular), FA-05 (cópia),
 * V-08/V-09, o espelho da linha 1 e os logs. "Carla" = `sub-marta` (ADMIN_ORGAO, com MFA);
 * "Diego" = `sub-otavio` (ADMIN_ORGAO); "Bruno" = `sub-fabio` (COMPRAS, só `WORKFLOW_VIEW`);
 * "Marcos" = Lúcia e "Roberto" = Ana (vínculos ativos na Prefeitura A); Heitor só existe na
 * Prefeitura B. O mesmo contra o PostgreSQL (RLS, FK composta, gatilho de imutabilidade e a
 * corrida real) está em `test/tenant-leak/workflow-stage-approvers.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MFA = ['pwd', 'otp'];
const MARCOS = FAKE_USERS.lucia.id;
const ROBERTO = FAKE_USERS.ana.id;
const DE_OUTRO_TENANT = FAKE_USERS.heitor.id;

const SECRETARIA_ADMINISTRACAO = newId();
const UNIDADE_SEM_TITULAR = newId();
const AUTORIDADE_COMPETENTE = newId();

const departments = new Map<string, DepartmentForApproval & { readonly name: string }>([
  [
    SECRETARIA_ADMINISTRACAO,
    {
      id: SECRETARIA_ADMINISTRACAO,
      isActive: true,
      headUserId: ROBERTO,
      deputyUserId: null,
      name: 'Secretaria de Administração',
    },
  ],
  [
    UNIDADE_SEM_TITULAR,
    {
      id: UNIDADE_SEM_TITULAR,
      isActive: true,
      headUserId: null,
      deputyUserId: null,
      name: 'Almoxarifado',
    },
  ],
]);
const AUTORIDADE = {
  id: AUTORIDADE_COMPETENTE,
  isActive: true,
  canDecideApprovals: true,
  key: 'AUTORIDADE_COMPETENTE',
  name: 'Autoridade competente',
};
const roles = new Map<string, RoleForApproval & { readonly key: string; readonly name: string }>([
  [AUTORIDADE_COMPETENTE, AUTORIDADE],
]);

type User = 'sub-marta' | 'sub-otavio' | 'sub-fabio' | 'sub-heitor';

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

const headOf = (departmentId: string, label?: string) => ({
  approverType: 'DEPARTMENT_HEAD',
  approverDepartmentResolution: 'FIXED',
  approverFixedDepartmentId: departmentId,
  ...(label ? { label } : {}),
});
const userLine = (userId: string, label?: string) => ({
  approverType: 'USER',
  approverUserId: userId,
  ...(label ? { label } : {}),
});

describe('Feature: Configurar política de decisão e aprovadores ordenados na etapa (US-132)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const logs: unknown[] = [];

  const stubReferences = () => {
    // Unidades e perfis deste cenário (o restante do tenant não tem unidade nem perfil aprovador).
    vi.spyOn(OrganizationFacade.prototype, 'findDepartmentForApproval').mockImplementation(
      (_tx, id) => Promise.resolve(departments.get(id) ?? null),
    );
    vi.spyOn(OrganizationFacade.prototype, 'departmentNames').mockImplementation((_tx, ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => (departments.has(id) ? [[id, departments.get(id)?.name ?? '']] : [])),
        ),
      ),
    );
    vi.spyOn(AccessFacade.prototype, 'findRoleForApproval').mockImplementation((_tx, id) =>
      Promise.resolve(roles.get(id) ?? null),
    );
    vi.spyOn(AccessFacade.prototype, 'roleSummaries').mockImplementation((_tx, ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => {
            const role = roles.get(id);
            return role ? [[id, { key: role.key, name: role.name }] as const] : [];
          }),
        ),
      ),
    );
  };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logs.push(message);
      });
    }
    stubReferences();
    api = await createTestApi({
      providers: [{ token: WORKFLOW_TRANSACTIONS, value: transactions }],
    });
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

  const as = (test: request.Test, user: User, server: TestApi = api) =>
    test
      .set('Authorization', server.bearer(user, { amr: MFA }))
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
  const putApprovers = (
    stageId: string,
    body: object,
    ifMatch: number | null,
    user: User = 'sub-marta',
    server: TestApi = api,
  ) => {
    const test = as(
      request(server.server).put(`/api/v1/workflow-stages/${stageId}/approvers`),
      user,
      server,
    );
    return (ifMatch === null ? test : test.set('If-Match', `"${ifMatch}"`)).send(body);
  };
  const patchStage = (stageId: string, body: object, ifMatch: number) =>
    as(request(api.server).patch(`/api/v1/workflow-stages/${stageId}`), 'sub-marta')
      .set('If-Match', `"${ifMatch}"`)
      .send(body);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const logged = (event: string) =>
    logs.filter(
      (entry) =>
        typeof entry === 'object' && entry !== null && 'event' in entry && entry.event === event,
    );

  const versionOf = async (versionId: string, user: User = 'sub-marta') => {
    const response = await get(`/workflow-versions/${versionId}`, user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { version: workflowVersionDetailSchema.parse(data(response)), etag: etagOf(response) };
  };
  const stageOf = async (versionId: string, key: string): Promise<WorkflowStageDto> => {
    const { version } = await versionOf(versionId);
    const stage = version.stages.find((item) => item.key === key);
    if (!stage) throw new Error(`etapa ${key} ausente`);
    return stage;
  };
  const addStage = async (versionId: string, body: object, user: User = 'sub-marta') => {
    const response = await post(`/workflow-versions/${versionId}/stages`, body, user);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };
  const addTransition = async (versionId: string, body: object, user: User = 'sub-marta') => {
    const response = await post(`/workflow-versions/${versionId}/transitions`, body, user);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  };
  const validate = async (versionId: string) => {
    const response = await post(`/workflow-versions/${versionId}/validate`, undefined);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return workflowValidationResultSchema.parse(data(response));
  };

  /**
   * Fluxo da fase preparatória: ABERTURA (START) → ESTUDOS_PRELIMINARES (TASK) →
   * AUTORIZACAO_LICITACAO (APPROVAL, titular da secretaria solicitante — MVP 1) → FIM (END).
   */
  const buildDraft = async (versionId: string, user: User = 'sub-marta') => {
    const abertura = await addStage(
      versionId,
      { key: 'ABERTURA', name: 'Abertura', type: 'START', instructions: 'Abra o processo.' },
      user,
    );
    const estudos = await addStage(
      versionId,
      {
        key: 'ESTUDOS_PRELIMINARES',
        name: 'Estudos preliminares',
        type: 'TASK',
        slaDays: 10,
        instructions: 'Elabore o ETP.',
      },
      user,
    );
    const autorizacao = await addStage(
      versionId,
      {
        key: 'AUTORIZACAO_LICITACAO',
        name: 'Autorização da licitação',
        type: 'APPROVAL',
        slaDays: 5,
        instructions: 'Autorize a licitação.',
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      },
      user,
    );
    const fim = await addStage(versionId, { key: 'FIM', name: 'Fim', type: 'END' }, user);
    for (const [key, from, to, action] of [
      ['ENVIAR_ESTUDOS', abertura.id, estudos.id, 'FORWARD'],
      ['ENVIAR_AUTORIZACAO', estudos.id, autorizacao.id, 'FORWARD'],
      ['AUTORIZAR', autorizacao.id, fim.id, 'APPROVE'],
      ['DEVOLVER', autorizacao.id, estudos.id, 'RETURN'],
      ['INDEFERIR', autorizacao.id, abertura.id, 'REJECT'],
    ] as const) {
      await addTransition(
        versionId,
        { key, name: `Transição ${key}`, fromStageId: from, toStageId: to, action },
        user,
      );
    }
    return { estudos, autorizacao };
  };

  // Background: "Fase preparatória — Lei 14.133/2021" em rascunho na Prefeitura A.
  let fase: WorkflowDto;
  let draftId: string;
  let autorizacao: WorkflowStageDto;

  it('Background: rascunho com a etapa APPROVAL e a etapa TASK', async () => {
    const response = await post('/workflows', {
      key: 'FASE_PREPARATORIA_14133',
      name: 'Fase preparatória — Lei 14.133/2021',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    fase = data<WorkflowDto>(response);
    draftId = fase.draftVersion?.id ?? '';
    ({ autorizacao } = await buildDraft(draftId));
  });

  it('[Sucesso] Etapa sem configuração continua como no MVP 1: ANY, approvers vazio e aprovador único', async () => {
    const stage = await stageOf(draftId, 'AUTORIZACAO_LICITACAO');
    expect(stage).toMatchObject({
      decisionPolicy: 'ANY',
      approvers: [],
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
    });
    expect((await stageOf(draftId, 'ESTUDOS_PRELIMINARES')).decisionPolicy).toBe('ANY');
    expect((await validate(draftId)).errors).toEqual([]);
  });

  it('[Sucesso] Configurar SEQUENTIAL com dois aprovadores: 200, sequence 1 e 2, espelho da linha 1 e auditoria', async () => {
    const audits = auditOf('workflow.update').length;
    const { etag: versionBefore } = await versionOf(draftId);
    const response = await putApprovers(
      autorizacao.id,
      {
        decisionPolicy: 'SEQUENTIAL',
        approvers: [
          headOf(SECRETARIA_ADMINISTRACAO, 'Secretário de Administração'),
          userLine(MARCOS, 'Procurador-Geral'),
        ],
      },
      autorizacao.version ?? 1,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = workflowStageApproversDtoSchema.parse(data(response));
    expect(etagOf(response)).toBe((autorizacao.version ?? 1) + 1);
    expect(body).toMatchObject({
      stageId: autorizacao.id,
      decisionPolicy: 'SEQUENTIAL',
      version: (autorizacao.version ?? 1) + 1,
    });
    expect(body.approvers).toEqual([
      expect.objectContaining({
        sequence: 1,
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'FIXED',
        approverFixedDepartmentId: SECRETARIA_ADMINISTRACAO,
        approverUserId: null,
        allowDeputy: true,
        label: 'Secretário de Administração',
        resolved: { label: 'Secretário de Administração', status: 'OK' },
      }),
      expect.objectContaining({
        sequence: 2,
        approverType: 'USER',
        approverUserId: MARCOS,
        approverDepartmentResolution: null,
        label: 'Procurador-Geral',
        resolved: { label: 'Procurador-Geral', status: 'OK' },
      }),
    ]);

    // RN-APV-08: as colunas do aprovador único espelham a linha 1; a versão incrementa (RN-WF-06).
    const { version, etag: versionAfter } = await versionOf(draftId);
    const stage = version.stages.find((item) => item.id === autorizacao.id);
    expect(stage).toMatchObject({
      decisionPolicy: 'SEQUENTIAL',
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentResolution: 'FIXED',
      approverFixedDepartmentId: SECRETARIA_ADMINISTRACAO,
    });
    expect(stage?.approvers.map((line) => line.sequence)).toEqual([1, 2]);
    expect(versionAfter).toBe(versionBefore + 1);

    expect(auditOf('workflow.update')).toHaveLength(audits + 1);
    const audit = auditOf('workflow.update').at(-1);
    expect(audit).toMatchObject({
      entityType: 'WorkflowStage',
      entityId: autorizacao.id,
      category: 'CONFIGURATION',
      metadata: expect.objectContaining({
        workflowVersionId: draftId,
        stageId: autorizacao.id,
        stageKey: 'AUTORIZACAO_LICITACAO',
        decisionPolicy: 'SEQUENTIAL',
        approversCount: 2,
      }) as unknown,
    });
    expect(audit?.changes).toEqual(
      expect.arrayContaining([
        { path: 'decisionPolicy', old: 'ANY', new: 'SEQUENTIAL' },
        {
          path: 'approvers',
          old: [],
          new: [
            {
              sequence: 1,
              approverType: 'DEPARTMENT_HEAD',
              reference: `FIXED:${SECRETARIA_ADMINISTRACAO}`,
            },
            { sequence: 2, approverType: 'USER', reference: MARCOS },
          ],
        },
      ]),
    );
    // Logs só com ids e contagens (nunca nomes).
    const log = logged('workflow.stage_approvers_set').at(-1);
    expect(log).toMatchObject({
      workflowVersionId: draftId,
      stageId: autorizacao.id,
      decisionPolicy: 'SEQUENTIAL',
      approversCount: 2,
    });
    expect(log).toHaveProperty('durationMs');
    expect(JSON.stringify(log)).not.toContain('Procurador');
    autorizacao = stage ?? autorizacao;
  });

  it('[Sucesso] Validar (valid) e publicar: snapshot com a política e as duas linhas na ordem', async () => {
    const result = await validate(draftId);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    const { etag } = await versionOf(draftId);
    const published = await post(`/workflow-versions/${draftId}/publish`, undefined).set(
      'If-Match',
      `"${etag}"`,
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    // WF-09 da publicada (servida do snapshot): política e linhas por `sequence`, sem ids.
    const { version } = await versionOf(draftId);
    expect(version.status).toBe('PUBLISHED');
    const stage = version.stages.find((item) => item.key === 'AUTORIZACAO_LICITACAO');
    expect(stage?.decisionPolicy).toBe('SEQUENTIAL');
    expect(stage?.approvers).toEqual([
      expect.objectContaining({
        sequence: 1,
        approverFixedDepartmentId: SECRETARIA_ADMINISTRACAO,
        label: 'Secretário de Administração',
      }),
      expect.objectContaining({ sequence: 2, approverUserId: MARCOS, label: 'Procurador-Geral' }),
    ]);
    expect(stage?.approvers[0]).not.toHaveProperty('id');
    // Etapa sem política continua sem as chaves novas no snapshot (hash do MVP 1 preservado).
    expect(version.stages.find((item) => item.key === 'ESTUDOS_PRELIMINARES')).toMatchObject({
      decisionPolicy: 'ANY',
      approvers: [],
    });
  });

  it('[Validação] V-10: escrita em versão publicada → 409 WORKFLOW_VERSION_NOT_DRAFT', async () => {
    const response = await putApprovers(
      autorizacao.id,
      { decisionPolicy: 'ANY', approvers: [] },
      autorizacao.version ?? 1,
    );
    expectProblem(response, 409, 'WORKFLOW_VERSION_NOT_DRAFT');
    expect(logged('workflow.stage_approvers_rejected').at(-1)).toMatchObject({
      reason: 'NOT_DRAFT',
      stageId: autorizacao.id,
    });
  });

  // v2: rascunho criado a partir da publicada (FA-05).
  let v2: string;
  let v2Autorizacao: WorkflowStageDto;
  let v2Estudos: WorkflowStageDto;

  it('[Sucesso] FA-05: nova versão copia a política e as linhas com ids novos', async () => {
    const response = await post(`/workflows/${fase.id}/versions`, {});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    v2 = (data<WorkflowVersionDetailDto>(response) as { id: string }).id;
    v2Autorizacao = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
    v2Estudos = await stageOf(v2, 'ESTUDOS_PRELIMINARES');
    expect(v2Autorizacao.id).not.toBe(autorizacao.id);
    expect(v2Autorizacao.decisionPolicy).toBe('SEQUENTIAL');
    expect(v2Autorizacao.approvers.map((line) => [line.sequence, line.label])).toEqual([
      [1, 'Secretário de Administração'],
      [2, 'Procurador-Geral'],
    ]);
    const sourceIds = new Set(autorizacao.approvers.map((line) => line.id));
    expect(v2Autorizacao.approvers.every((line) => line.id && !sourceIds.has(line.id))).toBe(true);
  });

  it('[Validação] ALL com um aprovador é aceito no rascunho (FA-03) e barrado na validação e na publicação', async () => {
    const saved = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ALL', approvers: [userLine(MARCOS)] },
      v2Autorizacao.version ?? 1,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    v2Autorizacao = await stageOf(v2, 'AUTORIZACAO_LICITACAO');

    const result = await validate(v2);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'WF_APPROVERS_INVALID',
        stageKey: 'AUTORIZACAO_LICITACAO',
        params: { reason: 'MIN_LINES' },
        message: 'A etapa Autorização da licitação precisa de ao menos dois aprovadores distintos.',
      }),
    );
    const { etag } = await versionOf(v2);
    const publish = await post(`/workflow-versions/${v2}/publish`, {
      changeNotes: 'Aprovação do edital por Secretário e Procurador',
    }).set('If-Match', `"${etag}"`);
    const problem = expectProblem(publish, 422, 'WORKFLOW_INVALID') as { validation?: unknown };
    expect(JSON.stringify(problem.validation)).toContain('MIN_LINES');
  });

  it('[Validação] Política fora de etapa de aprovação (NOT_ALLOWED) e 21 aprovadores (TOO_LONG)', async () => {
    const notApproval = await putApprovers(
      v2Estudos.id,
      { decisionPolicy: 'ALL', approvers: [] },
      v2Estudos.version ?? 1,
    );
    expect(expectProblem(notApproval, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({ field: 'decisionPolicy', code: 'NOT_ALLOWED' }),
    );
    const linesInTask = await putApprovers(
      v2Estudos.id,
      { decisionPolicy: 'ANY', approvers: [userLine(MARCOS)] },
      v2Estudos.version ?? 1,
    );
    expect(expectProblem(linesInTask, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({ field: 'approvers', code: 'NOT_ALLOWED' }),
    );
    const many = Array.from({ length: 21 }, () => userLine(newId()));
    const tooMany = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ALL', approvers: many },
      v2Autorizacao.version ?? 1,
    );
    expect(expectProblem(tooMany, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({ field: 'approvers', code: 'TOO_LONG' }),
    );
  });

  it('[Validação] V-01, V-04, V-07 e V-08: enum, referência da linha, rótulo e campos não editáveis', async () => {
    const version = v2Autorizacao.version ?? 1;
    const invalidEnum = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'MAIORIA', approvers: [] },
      version,
    );
    expect(expectProblem(invalidEnum, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({ field: 'decisionPolicy', code: 'INVALID_ENUM' }),
    );
    const missingRef = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ALL', approvers: [userLine(MARCOS), { approverType: 'ROLE' }] },
      version,
    );
    expect(expectProblem(missingRef, 422, 'VALIDATION_ERROR').errors).toContainEqual({
      field: 'approvers[1].approverRoleId',
      code: 'CONDITIONAL_REQUIRED',
      message: 'Informe o aprovador da linha 2.',
    });
    const longLabel = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ALL', approvers: [userLine(MARCOS, 'x'.repeat(121))] },
      version,
    );
    expect(expectProblem(longLabel, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({ field: 'approvers[0].label', code: 'TOO_LONG' }),
    );
    for (const extra of [
      { approvers: [{ ...userLine(MARCOS), sequence: 1 }] },
      { approvers: [{ ...userLine(MARCOS), applicabilityRule: { kind: 'LIBRARY' } }] },
      { decisionPolicyRules: [] },
    ]) {
      const response = await putApprovers(
        v2Autorizacao.id,
        { decisionPolicy: 'ALL', approvers: [userLine(MARCOS)], ...extra },
        version,
      );
      expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors).toContainEqual(
        expect.objectContaining({ code: 'NOT_ALLOWED' }),
      );
    }
  });

  it('[Validação] V-09: WF-11 recusa decisionPolicy e o aprovador único enquanto a lista existir', async () => {
    const version = v2Autorizacao.version ?? 1;
    const policy = await patchStage(v2Autorizacao.id, { decisionPolicy: 'ANY' }, version);
    expect(expectProblem(policy, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({ field: 'decisionPolicy', code: 'NOT_ALLOWED' }),
    );
    const single = await patchStage(
      v2Autorizacao.id,
      { approverType: 'USER', approverUserId: ROBERTO },
      version,
    );
    expect(expectProblem(single, 422, 'VALIDATION_ERROR').errors).toContainEqual({
      field: 'approverUserId',
      code: 'NOT_ALLOWED',
      message: 'O aprovador desta etapa é definido pela lista de aprovadores.',
    });
    // Outros campos continuam editáveis.
    const renamed = await patchStage(v2Autorizacao.id, { slaDays: 7 }, version);
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    v2Autorizacao = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
  });

  it('[Validação] FA-04: aprovador não resolvível na validação e unidade sem titular só como aviso', async () => {
    const saved = await putApprovers(
      v2Autorizacao.id,
      {
        decisionPolicy: 'ALL',
        approvers: [userLine(MARCOS), headOf(UNIDADE_SEM_TITULAR)],
      },
      v2Autorizacao.version ?? 1,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(workflowStageApproversDtoSchema.parse(data(saved)).approvers[1]?.resolved).toEqual({
      label: 'Titular de Almoxarifado',
      status: 'NO_HEAD',
    });
    v2Autorizacao = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
    const warnings = (await validate(v2)).warnings;
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'WF_APPROVER_HEAD_MISSING', params: { sequence: 2 } }),
    );
    // O perfil perde o APPROVAL_DECIDE depois de configurado → erro na linha (params.sequence).
    roles.set(AUTORIDADE_COMPETENTE, { ...AUTORIDADE, canDecideApprovals: true });
    const withRole = await putApprovers(
      v2Autorizacao.id,
      {
        decisionPolicy: 'ALL',
        approvers: [
          userLine(MARCOS),
          { approverType: 'ROLE', approverRoleId: AUTORIDADE_COMPETENTE },
        ],
      },
      v2Autorizacao.version ?? 1,
    );
    expect(withRole.status, JSON.stringify(withRole.body)).toBe(200);
    v2Autorizacao = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
    roles.set(AUTORIDADE_COMPETENTE, { ...AUTORIDADE, canDecideApprovals: false });
    try {
      expect((await validate(v2)).errors).toContainEqual(
        expect.objectContaining({
          code: 'WF_APPROVER_UNRESOLVABLE',
          stageKey: 'AUTORIZACAO_LICITACAO',
          params: { sequence: 2 },
        }),
      );
    } finally {
      roles.set(AUTORIDADE_COMPETENTE, { ...AUTORIDADE, canDecideApprovals: true });
    }
  });

  it('[Permissão] Bruno (só WORKFLOW_VIEW) → 403 PERMISSION_DENIED com access.denied; sem MFA → 403 MFA_REQUIRED', async () => {
    const response = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ALL', approvers: [userLine(MARCOS), userLine(ROBERTO)] },
      v2Autorizacao.version ?? 1,
      'sub-fabio',
    );
    expectProblem(response, 403, 'PERMISSION_DENIED');
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_MANAGE' });
    // Bruno lê a política e a ordem (WORKFLOW_VIEW).
    const { version } = await versionOf(v2, 'sub-fabio');
    expect(version.stages.find((item) => item.id === v2Autorizacao.id)?.decisionPolicy).toBe('ALL');

    const noMfa = await request(api.server)
      .put(`/api/v1/workflow-stages/${v2Autorizacao.id}/approvers`)
      .set('Authorization', api.bearer('sub-marta', { amr: ['pwd'] }))
      .set('X-Tenant-Id', A)
      .set('If-Match', `"${String(v2Autorizacao.version ?? 1)}"`)
      .send({ decisionPolicy: 'ANY', approvers: [] });
    expectProblem(noMfa, 403, 'MFA_REQUIRED');
    expect((await stageOf(v2, 'AUTORIZACAO_LICITACAO')).decisionPolicy).toBe('ALL');
  });

  it('[Tenant incorreto] Etapa de outro tenant → 404 NOT_FOUND; aprovador de outro tenant → 422 REFERENCE_NOT_FOUND', async () => {
    const other = await post(
      '/workflows',
      { key: 'FASE_PREPARATORIA_B', name: 'Fase preparatória B' },
      'sub-heitor',
    );
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const otherDraft = data<WorkflowDto>(other).draftVersion?.id ?? '';
    const otherStage = await addStage(
      otherDraft,
      {
        key: 'AUTORIZACAO_LICITACAO',
        name: 'Autorização',
        type: 'APPROVAL',
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      },
      'sub-heitor',
    );
    const crossTenant = await putApprovers(
      otherStage.id,
      { decisionPolicy: 'ALL', approvers: [userLine(MARCOS), userLine(ROBERTO)] },
      otherStage.version ?? 1,
    );
    expectProblem(crossTenant, 404, 'NOT_FOUND');
    const { version } = await versionOf(otherDraft, 'sub-heitor');
    expect(version.stages[0]).toMatchObject({ decisionPolicy: 'ANY', approvers: [] });

    const foreignUser = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ALL', approvers: [userLine(DE_OUTRO_TENANT), userLine(MARCOS)] },
      v2Autorizacao.version ?? 1,
    );
    expect(expectProblem(foreignUser, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({
        field: 'approvers[0].approverUserId',
        code: 'REFERENCE_NOT_FOUND',
      }),
    );
    expect(logged('workflow.stage_approvers_rejected').at(-1)).toMatchObject({
      reason: 'REFERENCE',
    });
  });

  it('[Duplicidade] Mesmo aprovador duas vezes → DUPLICATE_IN_LIST; reenvio da mesma lista é no-op', async () => {
    const duplicated = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'SEQUENTIAL', approvers: [userLine(MARCOS), userLine(MARCOS)] },
      v2Autorizacao.version ?? 1,
    );
    expect(expectProblem(duplicated, 422, 'VALIDATION_ERROR').errors).toContainEqual({
      field: 'approvers[1]',
      code: 'DUPLICATE_IN_LIST',
      message: 'O mesmo aprovador não pode aparecer duas vezes.',
    });

    const list = { decisionPolicy: 'SEQUENTIAL', approvers: [userLine(ROBERTO), userLine(MARCOS)] };
    const first = await putApprovers(v2Autorizacao.id, list, v2Autorizacao.version ?? 1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const etag = etagOf(first);
    const { etag: versionEtag } = await versionOf(v2);
    const audits = auditOf('workflow.update').length;
    const again = await putApprovers(v2Autorizacao.id, list, etag);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(etagOf(again)).toBe(etag);
    expect(data<WorkflowStageApproversDto>(again).approvers.map((line) => line.id)).toEqual(
      data<WorkflowStageApproversDto>(first).approvers.map((line) => line.id),
    );
    expect(auditOf('workflow.update')).toHaveLength(audits);
    expect((await versionOf(v2)).etag).toBe(versionEtag);
    v2Autorizacao = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
  });

  it('[Concorrência] Diego salva primeiro; Carla com a ETag antiga → 412 VERSION_CONFLICT e a lista de Diego permanece', async () => {
    const etag = v2Autorizacao.version ?? 1;
    const diego = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ALL', approvers: [userLine(MARCOS), headOf(SECRETARIA_ADMINISTRACAO)] },
      etag,
      'sub-otavio',
    );
    expect(diego.status, JSON.stringify(diego.body)).toBe(200);
    const carla = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'SEQUENTIAL', approvers: [userLine(ROBERTO), userLine(MARCOS)] },
      etag,
    );
    expectProblem(carla, 412, 'VERSION_CONFLICT');
    expect(logged('workflow.stage_approvers_conflict').at(-1)).toMatchObject({
      stageId: v2Autorizacao.id,
    });
    const stage = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
    expect(stage.decisionPolicy).toBe('ALL');
    expect(stage.approvers.map((line) => line.approverType)).toEqual(['USER', 'DEPARTMENT_HEAD']);
    // V-11: sem If-Match → 428.
    expectProblem(
      await putApprovers(v2Autorizacao.id, { decisionPolicy: 'ANY', approvers: [] }, null),
      428,
      'PRECONDITION_REQUIRED',
    );
    v2Autorizacao = stage;
  });

  it('[Falha de banco] Banco indisponível → 503 DEPENDENCY_UNAVAILABLE e a configuração anterior permanece', async () => {
    transactions.down = true;
    const response = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'SEQUENTIAL', approvers: [userLine(ROBERTO), userLine(MARCOS)] },
      v2Autorizacao.version ?? 1,
    );
    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    transactions.down = false;
    const stage = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
    expect(stage.decisionPolicy).toBe('ALL');
    expect(stage.version).toBe(v2Autorizacao.version);
    expect(logged('workflow.stage_approvers_write_failed').at(-1)).toMatchObject({
      stageId: v2Autorizacao.id,
      cause: 'DEPENDENCY_UNAVAILABLE',
    });
  });

  it('[Sucesso] FA-01: voltar a ANY com lista vazia restaura o aprovador único editável', async () => {
    const response = await putApprovers(
      v2Autorizacao.id,
      { decisionPolicy: 'ANY', approvers: [] },
      v2Autorizacao.version ?? 1,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(data<WorkflowStageApproversDto>(response)).toMatchObject({
      decisionPolicy: 'ANY',
      approvers: [],
    });
    const stage = await stageOf(v2, 'AUTORIZACAO_LICITACAO');
    const edited = await patchStage(
      stage.id,
      {
        approverType: 'USER',
        approverUserId: MARCOS,
        approverDepartmentResolution: null,
        approverFixedDepartmentId: null,
      },
      stage.version ?? 1,
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  });

  it('[Falha de integração] Cache de permissões (Redis) fora: 200 com as permissões do banco e aviso de degradação', async () => {
    const unavailable = (): Promise<never> => Promise.reject(new Error('ECONNREFUSED'));
    const downStore: CacheStore = {
      get: unavailable,
      set: unavailable,
      delete: unavailable,
      getMany: unavailable,
    };
    const noRedis = await createTestApi({
      providers: [
        { token: CACHE_STORE, value: downStore },
        { token: WORKFLOW_TRANSACTIONS, value: new InMemoryWorkflowTransactions() },
      ],
    });
    try {
      noRedis.app.get(DocumentTypeCatalog).register({
        codesOf: () => Promise.resolve({ active: new Set<string>(), inactive: new Set<string>() }),
      });
      const created = await as(
        request(noRedis.server).post('/api/v1/workflows'),
        'sub-marta',
        noRedis,
      )
        .set('Idempotency-Key', randomUUID())
        .send({ key: 'FLUXO_SEM_CACHE', name: 'Fluxo sem cache' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const versionId = data<WorkflowDto>(created).draftVersion?.id ?? '';
      const stageResponse = await as(
        request(noRedis.server).post(`/api/v1/workflow-versions/${versionId}/stages`),
        'sub-marta',
        noRedis,
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          key: 'AUTORIZACAO',
          name: 'Autorização',
          type: 'APPROVAL',
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        });
      expect(stageResponse.status, JSON.stringify(stageResponse.body)).toBe(201);
      const stage = data<WorkflowStageDto>(stageResponse);
      const saved = await putApprovers(
        stage.id,
        { decisionPolicy: 'ALL', approvers: [userLine(MARCOS), userLine(ROBERTO)] },
        stage.version ?? 1,
        'sub-marta',
        noRedis,
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(logged('authorization.cache_unavailable').length).toBeGreaterThan(0);
    } finally {
      await noRedis.close();
    }
  });
});

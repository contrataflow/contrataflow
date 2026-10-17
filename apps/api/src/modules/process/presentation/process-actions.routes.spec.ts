import {
  actionEntrySchema,
  problemDetailsSchema,
  processChecklistSchema,
} from '@contrataflow/validation';
import type { ActionEntry, ProcessChecklist } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import {
  DEPARTMENTS,
  ETP_MESSAGE,
  RISK_MAP_MESSAGE,
  dec015Workflow,
  etp,
  pass,
  passesUntilStudies,
  processRuntime,
  seedPublishedInMemory,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import { InMemoryProcessRuntimeStore } from '../infrastructure/process-runtime.readers.js';

/*
 * US-041 — PRC-08/PRC-09 pelo pipeline HTTP completo (autenticação, tenant, vínculo, rate limit,
 * filtro RFC 9457) com a identidade fake, o motor real sobre o snapshot publicado e o runtime do
 * processo em memória (o agregado nasce na US-001). Os 8 cenários do Gherkin + FA-05 e a matriz de
 * visibilidade (DEC-024). O isolamento sobre o PostgreSQL está em
 * `test/tenant-leak/process-actions.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;

type User = 'sub-lucia' | 'sub-fabio' | 'sub-ana' | 'sub-marta' | 'sub-heitor';

/** Leitura que pode simular o banco fora do ar. */
class FlakyProcessTransactions implements ProcessTransactions {
  down = false;

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
  }

  longRead<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
  }
}

const actionsSchema = z.array(actionEntrySchema);

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

describe('Feature: Motor de execução — ações disponíveis e avaliação de regras (US-041)', () => {
  let api: TestApi;
  let store: InMemoryProcessRuntimeStore;
  const transactions = new FlakyProcessTransactions();

  // Processos do cenário.
  const P0012 = newId();
  const P_SECRETARIA = newId();
  const P_QUEBRADO = newId();
  const P0007_B = newId();
  const P_CONSULTOR_B = newId();
  const builderA = dec015Workflow(new DefinitionBuilder(newId()));
  const brokenA = dec015Workflow(new DefinitionBuilder(newId())).rule(
    'CONDITION',
    { expression: { '*': [] } },
    { stage: 'ESTUDOS_PRELIMINARES' },
    { name: 'Valor conferido', message: 'Confira o valor estimado.' },
  );
  const builderB = dec015Workflow(new DefinitionBuilder(newId()));

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [{ token: PROCESS_TRANSACTIONS, value: transactions }],
    });
    store = api.app.get(InMemoryProcessRuntimeStore, { strict: false });
    await seedPublishedInMemory(api, A, builderA, 'FASE_PREPARATORIA');
    await seedPublishedInMemory(api, A, brokenA, 'FASE_PREPARATORIA_QUEBRADA');
    await seedPublishedInMemory(api, B, builderB, 'FASE_PREPARATORIA');

    // Background: 0012/2026 em ESTUDOS_PRELIMINARES, ETP completo, Lúcia responsável.
    store.save(
      processRuntime({
        id: P0012,
        tenantId: A,
        workflowVersionId: builderA.versionId,
        passes: passesUntilStudies(builderA, { assigneeId: FAKE_USERS.lucia.id }),
        currentResponsibleId: FAKE_USERS.lucia.id,
        documents: [etp('DRAFT', true)],
      }),
    );
    // Visível só para a secretaria (e quem tem PROCESS_VIEW em todo o tenant).
    store.save(
      processRuntime({
        id: P_SECRETARIA,
        tenantId: A,
        workflowVersionId: builderA.versionId,
        passes: passesUntilStudies(builderA),
        accessDepartmentIds: [DEPARTMENTS.secretaria],
      }),
    );
    store.save(
      processRuntime({
        id: P_QUEBRADO,
        tenantId: A,
        workflowVersionId: brokenA.versionId,
        passes: passesUntilStudies(brokenA, { assigneeId: FAKE_USERS.lucia.id }),
        currentResponsibleId: FAKE_USERS.lucia.id,
        documents: [etp('DRAFT', true)],
      }),
    );
    store.save(
      processRuntime({
        id: P0007_B,
        tenantId: B,
        workflowVersionId: builderB.versionId,
        passes: passesUntilStudies(builderB),
      }),
    );
    store.save(
      processRuntime({
        id: P_CONSULTOR_B,
        tenantId: B,
        workflowVersionId: builderB.versionId,
        passes: passesUntilStudies(builderB),
        accessDepartmentIds: [],
        accessUserIds: [FAKE_USERS.fabio.id],
      }),
    );
    // Ana (REQUISITANTE, escopo OWN_DEPARTMENTS) é lotada na unidade com a custódia de 0012/2026.
    const ana = FAKE_MEMBERSHIPS.find((m) => m.userId === FAKE_USERS.ana.id && m.tenantId === A);
    assignDepartment(api, ana?.id ?? '', DEPARTMENTS.planejamento);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  const get = (path: string, user: User = 'sub-lucia', tenant?: string) =>
    request(api.server)
      .get(`/api/v1${path}`)
      .set('Authorization', api.bearer(user, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant ?? (user === 'sub-heitor' ? B : A));
  const actions = (id: string, user?: User, tenant?: string) =>
    get(`/processes/${id}/available-actions`, user, tenant);
  const checklist = (id: string, user?: User, tenant?: string) =>
    get(`/processes/${id}/checklist`, user, tenant);

  it('[Sucesso] FORWARD para "Pesquisa de preços" habilitado e o aviso "Mapa de riscos" no checklist', async () => {
    const [actionsResponse, checklistResponse] = await Promise.all([
      actions(P0012),
      checklist(P0012),
    ]);
    expect(actionsResponse.status).toBe(200);
    expect(checklistResponse.status).toBe(200);

    const entries = actionsSchema.parse(data<ActionEntry[]>(actionsResponse));
    expect(entries[0]).toMatchObject({
      action: 'FORWARD',
      toStageKey: 'PESQUISA_PRECOS',
      label: 'Encaminhar para pesquisa de preços',
      enabled: true,
      primary: true,
      reasons: [],
      departmentResolution: { mode: 'FIXED', departmentId: DEPARTMENTS.compras },
    });
    expect(entries.map((entry) => entry.action)).toEqual([
      'FORWARD',
      'RETURN',
      'CLAIM',
      'ASSIGN',
      'SUSPEND',
      'CANCEL',
      // US-005: "Editar dados" (PROCESS_UPDATE + POL-01).
      'EDIT',
      // US-006: "Gerenciar itens" (PROCESS_UPDATE + POL-01).
      'MANAGE_ITEMS',
      // US-011: "Duplicar processo" (PROCESS_DUPLICATE + PROCESS_CREATE).
      'DUPLICATE',
    ]);

    const { violations } = processChecklistSchema.parse(data<ProcessChecklist>(checklistResponse));
    expect(violations).toEqual([
      expect.objectContaining({
        code: 'WORKFLOW_RULE',
        name: 'Mapa de riscos',
        severity: 'WARNING',
        message: RISK_MAP_MESSAGE,
        satisfied: false,
      }),
    ]);
  });

  it('RN-WF-24: com o ETP incompleto o FORWARD vem desabilitado com o motivo da regra', async () => {
    const id = newId();
    store.save(
      processRuntime({
        id,
        tenantId: A,
        workflowVersionId: builderA.versionId,
        passes: passesUntilStudies(builderA),
        currentResponsibleId: FAKE_USERS.lucia.id,
        documents: [etp('DRAFT', false)],
      }),
    );
    const [forward] = data<ActionEntry[]>(await actions(id));
    expect(forward).toMatchObject({
      action: 'FORWARD',
      enabled: false,
      reasons: [{ code: 'TRANSITION_BLOCKED', message: ETP_MESSAGE }],
    });
    const { violations } = data<ProcessChecklist>(await checklist(id));
    expect(violations.map((item) => item.severity)).toEqual(['BLOCKING', 'WARNING']);
  });

  it('[Validação] identificador mal formatado → 400 MALFORMED_REQUEST', async () => {
    const body = expectProblem(
      await get('/processes/abc-invalido/available-actions'),
      400,
      'MALFORMED_REQUEST',
    );
    expect(body.detail).toBe('Requisição inválida.');
    expectProblem(await get('/processes/abc-invalido/checklist'), 400, 'MALFORMED_REQUEST');
  });

  it('[Permissão] sem PROCESS_VIEW em escopo que cubra o processo → 404 igual ao inexistente', async () => {
    const hidden = expectProblem(await actions(P_SECRETARIA, 'sub-ana'), 404, 'NOT_FOUND');
    const missing = expectProblem(await actions(newId(), 'sub-ana'), 404, 'NOT_FOUND');
    const strip = ({ instance: _i, correlationId: _c, ...rest }: Record<string, unknown>) => rest;
    expect(strip(hidden)).toEqual(strip(missing));
    // Só `instance` (o caminho pedido) e `correlationId` diferem: nada indica que o processo existe.
    expect(JSON.stringify(strip(hidden))).not.toContain(P_SECRETARIA);
    expectProblem(await checklist(P_SECRETARIA, 'sub-ana'), 404, 'NOT_FOUND');
  });

  it('RBAC (DEC-024): escopo de unidade lotada, todo o tenant e concessão própria sem PROCESS_VIEW', async () => {
    // Ana: lotada na unidade com acesso ao 0012/2026 (OWN_DEPARTMENTS).
    expect((await actions(P0012, 'sub-ana')).status).toBe(200);
    // Marta (ADMIN_ORGAO): só PROCESS_VIEW em todo o tenant → vê o processo, nenhuma ação.
    expect(data<ActionEntry[]>(await actions(P_SECRETARIA, 'sub-marta'))).toEqual([]);
    expect((await checklist(P_SECRETARIA, 'sub-marta')).status).toBe(200);
    // Fábio no tenant B: CONSULTOR_EXTERNO sem PROCESS_VIEW, mas com concessão USER no processo.
    expect((await actions(P_CONSULTOR_B, 'sub-fabio', B)).status).toBe(200);
    expectProblem(await actions(P0007_B, 'sub-fabio', B), 404, 'NOT_FOUND');
  });

  it('[Tenant incorreto] processo de outro tenant → 404 sem revelar dados de B', async () => {
    const response = await actions(P0007_B, 'sub-lucia');
    const body = expectProblem(response, 404, 'NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/PESQUISA|ESTUDOS|FORWARD/);
    expectProblem(await checklist(P0007_B, 'sub-lucia'), 404, 'NOT_FOUND');
    // No próprio tenant, o mesmo processo responde normalmente.
    expect((await actions(P0007_B, 'sub-heitor')).status).toBe(200);
  });

  it('[Duplicidade] consultas repetidas são idênticas e sem efeito colateral', async () => {
    const audits = api.auditRecords().length;
    const events = api.outboxRows().length;
    const first = await actions(P0012);
    const second = await actions(P0012);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const checks = [await checklist(P0012), await checklist(P0012)];
    expect(checks[1]?.body).toEqual(checks[0]?.body);
    expect(api.auditRecords()).toHaveLength(audits);
    expect(api.outboxRows()).toHaveLength(events);
  });

  it('[Concorrência] tramitação no meio da consulta → resposta inteira de uma etapa, nunca mista', async () => {
    const id = newId();
    const before = processRuntime({
      id,
      tenantId: A,
      workflowVersionId: builderA.versionId,
      passes: passesUntilStudies(builderA, { assigneeId: FAKE_USERS.lucia.id }),
      currentResponsibleId: FAKE_USERS.lucia.id,
      documents: [etp('DRAFT', true)],
    });
    store.save(before);
    // O "segundo usuário" encaminha para PESQUISA_PRECOS depois da leitura do runtime e antes da
    // avaliação (um contribuidor do RuleContext roda exatamente nesse ponto).
    let armed = true;
    api.app.get(WorkflowFacade, { strict: false }).registerRuleContextContributor({
      name: 'tramitacao-concorrente',
      contribute: (_tx, contextRequest) => {
        if (armed && contextRequest.processId === id) {
          armed = false;
          store.save({
            ...before,
            passes: [
              ...before.passes.map((item) =>
                item.status === 'ACTIVE' ? { ...item, status: 'COMPLETED' as const } : item,
              ),
              pass(builderA, 'PESQUISA_PRECOS', 4, { status: 'ACTIVE', exitedAt: null }),
            ],
            currentDepartmentId: DEPARTMENTS.compras,
          });
        }
        return Promise.resolve({});
      },
    });
    const loads = store.loadCount();
    const during = data<ActionEntry[]>(await actions(id));
    expect(store.loadCount()).toBe(loads + 1);
    const keysDuring = during.flatMap((entry) =>
      entry.transitionKey ? [entry.transitionKey] : [],
    );
    expect(keysDuring.length).toBeGreaterThan(0);
    expect(keysDuring.every((key) => key.startsWith('ESTUDOS_PRELIMINARES_'))).toBe(true);
    expect(during[0]?.toStageKey).toBe('PESQUISA_PRECOS');

    const after = data<ActionEntry[]>(await actions(id));
    const keysAfter = after.flatMap((entry) => (entry.transitionKey ? [entry.transitionKey] : []));
    expect(keysAfter.every((key) => key.startsWith('PESQUISA_PRECOS_'))).toBe(true);
    expect(after[0]?.toStageKey).toBe('TERMO_REFERENCIA');
  });

  it('[Falha de banco] banco indisponível → 503 DEPENDENCY_UNAVAILABLE com Retry-After', async () => {
    transactions.down = true;
    const response = await actions(P0012);
    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
    expectProblem(await checklist(P0012), 503, 'DEPENDENCY_UNAVAILABLE');
  });

  it('[Falha de integração] expressão que falha no JSON Logic: regra não satisfeita, log error com ruleId e 200', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = await checklist(P_QUEBRADO);
    expect(response.status).toBe(200);
    const { violations } = data<ProcessChecklist>(response);
    const broken = violations.find((item) => item.name === 'Valor conferido');
    expect(broken).toMatchObject({ severity: 'BLOCKING', satisfied: false });
    expect(violations.map((item) => item.name)).toContain('Mapa de riscos');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workflow.rule_evaluation_failed',
        ruleId: broken?.ruleId,
        ruleType: 'CONDITION',
      }),
      'workflow.rule_evaluation_failed',
    );
    // As demais regras seguem avaliadas; o avanço fica bloqueado só pela regra quebrada.
    const [forward] = data<ActionEntry[]>(await actions(P_QUEBRADO));
    expect(forward?.reasons).toEqual([
      { code: 'TRANSITION_BLOCKED', message: 'Confira o valor estimado.', ruleId: broken?.ruleId },
    ]);
  });

  it('FA-05: quem não é o responsável atual consulta normalmente, com ações desabilitadas e o motivo', async () => {
    const response = await actions(P0012, 'sub-fabio');
    expect(response.status).toBe(200);
    const entries = data<ActionEntry[]>(response);
    expect(entries.find((entry) => entry.action === 'FORWARD')).toMatchObject({
      enabled: false,
      reasons: [
        {
          code: 'NOT_PROCESS_CUSTODIAN',
          message: 'Somente quem está com o processo pode encaminhá-lo.',
        },
      ],
    });
    expect(entries.find((entry) => entry.action === 'CLAIM')?.enabled).toBe(false);
  });
});

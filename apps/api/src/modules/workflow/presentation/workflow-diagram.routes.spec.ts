import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
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
 * US-046 — Visualizar diagrama do workflow: o diagrama não tem endpoint próprio (RN-WF-71); ele lê
 * WF-09 (etapas e transições da versão) e WF-07 (seletor de versões). Aqui, pelo pipeline HTTP, os
 * cenários de API da story: leitura com `WORKFLOW_VIEW` sem auditoria nem evento, rascunho vazio,
 * 403 sem a permissão (com `access.denied`), 404 para outro tenant, leituras repetidas idênticas,
 * snapshot consistente com escrita concorrente entre os SELECTs e 503 com o banco fora. "Carla" =
 * `sub-marta` (ADMIN_ORGAO); "Elisa" = `sub-fabio` (COMPRAS, só `WORKFLOW_VIEW`); "Fábio sem
 * permissão" = `sub-ana` (REQUISITANTE); a "Prefeitura B" = `sub-heitor`. Isolamento sobre o
 * PostgreSQL: `test/tenant-leak/workflow-diagram.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MFA = ['pwd', 'otp'];

type User = 'sub-marta' | 'sub-fabio' | 'sub-ana' | 'sub-heitor';

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

describe('Feature: Visualizar diagrama do workflow — leituras WF-09/WF-07 (US-046)', () => {
  let api: TestApi;
  let repository: InMemoryWorkflowRepository;
  const transactions = new FlakyTransactions();

  beforeAll(async () => {
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
    await api.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  const as = (test: request.Test, user: User) =>
    test
      .set('Authorization', api.bearer(user, { amr: MFA }))
      .set('X-Tenant-Id', user === 'sub-heitor' ? B : A);
  const get = (path: string, user: User = 'sub-fabio') =>
    as(request(api.server).get(`/api/v1${path}`), user);
  const post = (path: string, body: object, user: User = 'sub-marta') =>
    as(request(api.server).post(`/api/v1${path}`), user)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);

  let workflow: WorkflowDto;
  let draftId: string;

  const addStage = async (body: object) => {
    const response = await post(`/workflow-versions/${draftId}/stages`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };

  it('[Validação] rascunho novo sem etapas: WF-09 devolve listas vazias (estado vazio no front)', async () => {
    const created = await post('/workflows', { key: 'DIAGRAMA_US046', name: 'Diagrama US-046' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    workflow = data<WorkflowDto>(created);
    draftId = workflow.draftVersion?.id ?? '';

    const response = await get(`/workflow-versions/${draftId}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(data<WorkflowVersionDetailDto>(response)).toMatchObject({
      status: 'DRAFT',
      stages: [],
      transitions: [],
    });
  });

  it('[Sucesso] quem só tem WORKFLOW_VIEW lê etapas e transições; leitura sem auditoria nem evento', async () => {
    const abertura = await addStage({ key: 'ABERTURA', name: 'Abertura', type: 'START' });
    const dfd = await addStage({ key: 'DFD', name: 'Formalização da demanda', type: 'TASK' });
    const conclusao = await addStage({ key: 'CONCLUSAO', name: 'Conclusão', type: 'END' });
    for (const [key, from, to, action] of [
      ['INICIAR', abertura.id, dfd.id, 'FORWARD'],
      ['CONCLUIR', dfd.id, conclusao.id, 'COMPLETE'],
    ] as const) {
      const response = await post(`/workflow-versions/${draftId}/transitions`, {
        key,
        name: key,
        fromStageId: from,
        toStageId: to,
        action,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    const audits = api.auditRecords().length;
    const events = api.outboxRows().length;

    const response = await get(`/workflow-versions/${draftId}`);
    const history = await get(`/workflows/${workflow.id}/versions`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const version = data<WorkflowVersionDetailDto>(response);
    expect(response.headers.etag).toBe(`"${String(version.version)}"`);
    expect(version.stages.map((stage) => [stage.key, stage.type])).toEqual([
      ['ABERTURA', 'START'],
      ['DFD', 'TASK'],
      ['CONCLUSAO', 'END'],
    ]);
    expect(version.transitions.map((transition) => transition.key).sort()).toEqual([
      'CONCLUIR',
      'INICIAR',
    ]);
    expect(history.status).toBe(200);
    expect(data<WorkflowVersionSummaryDto[]>(history).map((item) => item.id)).toEqual([draftId]);
    // Visualização não gera auditoria nem evento (story: Auditoria e Eventos — nenhum).
    expect(api.auditRecords()).toHaveLength(audits);
    expect(api.outboxRows()).toHaveLength(events);
  });

  it('[Permissão] sem WORKFLOW_VIEW: WF-09 e WF-07 → 403 PERMISSION_DENIED com access.denied', async () => {
    const version = await get(`/workflow-versions/${draftId}`, 'sub-ana');
    expectProblem(version, 403, 'PERMISSION_DENIED');
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_VIEW' });

    const history = await get(`/workflows/${workflow.id}/versions`, 'sub-ana');
    expectProblem(history, 403, 'PERMISSION_DENIED');
  });

  it('[Tenant incorreto] versão da Prefeitura A pedida pela Prefeitura B → 404 sem revelar', async () => {
    const response = await get(`/workflow-versions/${draftId}`, 'sub-heitor');
    const body = expectProblem(response, 404, 'NOT_FOUND');
    expect(JSON.stringify(body)).not.toContain('ABERTURA');

    const unknown = await get(
      '/workflow-versions/0192c046-0000-7000-8000-000000000999',
      'sub-heitor',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND', detail: body.detail });

    const history = await get(`/workflows/${workflow.id}/versions`, 'sub-heitor');
    expectProblem(history, 404, 'NOT_FOUND');
  });

  it('[Duplicidade] ler a mesma versão de novo devolve o mesmo grafo, sem etapas duplicadas', async () => {
    const first = data<WorkflowVersionDetailDto>(await get(`/workflow-versions/${draftId}`));
    const second = data<WorkflowVersionDetailDto>(await get(`/workflow-versions/${draftId}`));

    expect(second).toEqual(first);
    expect(new Set(second.stages.map((stage) => stage.id)).size).toBe(second.stages.length);
  });

  it('[Concorrência] etapa salva entre as leituras: WF-09 refaz e devolve o snapshot inteiro', async () => {
    const before = data<WorkflowVersionDetailDto>(await get(`/workflow-versions/${draftId}`));
    const load = repository.loadDefinition.bind(repository);
    let injected = false;
    const spy = vi.spyOn(repository, 'loadDefinition').mockImplementation(async (tx, id) => {
      const definition = await load(tx, id);
      if (!injected && id === draftId) {
        // "Carla" confirma uma etapa depois que a leitura de "Elisa" já viu as etapas.
        injected = true;
        await addStage({ key: 'TR', name: 'Termo de referência', type: 'TASK' });
      }
      return definition;
    });

    const response = await get(`/workflow-versions/${draftId}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const version = data<WorkflowVersionDetailDto>(response);
    expect(spy.mock.calls.filter(([, id]) => id === draftId).length).toBeGreaterThanOrEqual(2);
    // Nunca parcial: as etapas e o ETag são do mesmo instante (depois da etapa de "Carla").
    expect(version.version).toBe(before.version + 1);
    expect(response.headers.etag).toBe(`"${String(version.version)}"`);
    expect(version.stages.map((stage) => stage.key)).toEqual([
      ...before.stages.map((stage) => stage.key),
      'TR',
    ]);
  });

  it('[Concorrência] versão que muda a cada leitura: depois de 3 tentativas → 503 DEPENDENCY_UNAVAILABLE', async () => {
    const load = repository.loadDefinition.bind(repository);
    let counter = 0;
    // A própria escrita injetada também lê a definição: sem reentrar.
    let writing = false;
    vi.spyOn(repository, 'loadDefinition').mockImplementation(async (tx, id) => {
      const definition = await load(tx, id);
      if (id === draftId && !writing) {
        writing = true;
        counter += 1;
        await addStage({
          key: `EXTRA_${String(counter)}`,
          name: `Extra ${String(counter)}`,
          type: 'TASK',
        });
        writing = false;
      }
      return definition;
    });

    const response = await get(`/workflow-versions/${draftId}`);

    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(counter).toBe(3);
  });

  it('[Falha de banco] banco indisponível ao carregar o diagrama → 503 DEPENDENCY_UNAVAILABLE', async () => {
    transactions.down = true;

    const response = await get(`/workflow-versions/${draftId}`);

    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBe('5');
  });
});

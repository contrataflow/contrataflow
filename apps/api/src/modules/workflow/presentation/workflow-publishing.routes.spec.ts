import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowValidationResult,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';
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
 * US-045 — Publicar, versionar e aposentar workflow (WF-07/08/20/21/22) pelo pipeline HTTP
 * completo: os 8 cenários Gherkin da story, as regras RN-WF-61..69 e os logs. "Carla" =
 * `sub-marta` (ADMIN_ORGAO, `WORKFLOW_PUBLISH`); "Diego" = `sub-lucia` (GESTOR_CONTRATACOES, só
 * `WORKFLOW_MANAGE`); o segundo administrador da corrida = `sub-otavio`; a "Prefeitura B" =
 * `sub-heitor`. O outbox `PENDING` real, a corrida concorrente e o isolamento no PostgreSQL estão
 * em `test/tenant-leak/workflow-publishing.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MFA = ['pwd', 'otp'];

type User = 'sub-marta' | 'sub-otavio' | 'sub-lucia' | 'sub-heitor';

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

const etagOf = (response: request.Response) =>
  Number(String(response.headers.etag).replaceAll('"', ''));

describe('Feature: Publicar, versionar e aposentar workflow (US-045)', () => {
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
  const postIfMatch = (
    path: string,
    body: object | undefined,
    ifMatch: number | null,
    user: User = 'sub-marta',
  ) => {
    const test = as(request(api.server).post(`/api/v1${path}`), user);
    const matched = ifMatch === null ? test : test.set('If-Match', `"${ifMatch}"`);
    return body === undefined ? matched : matched.send(body);
  };
  const publish = (versionId: string, body: object, ifMatch: number | null, user?: User) =>
    postIfMatch(`/workflow-versions/${versionId}/publish`, body, ifMatch, user);
  const retire = (versionId: string, ifMatch: number | null, user?: User) =>
    postIfMatch(`/workflow-versions/${versionId}/retire`, undefined, ifMatch, user);

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
  const workflowOf = async (id: string) => data<WorkflowDto>(await get(`/workflows/${id}`));
  const versionOf = async (versionId: string, user: User = 'sub-marta') => {
    const response = await get(`/workflow-versions/${versionId}`, user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { version: data<WorkflowVersionDetailDto>(response), etag: etagOf(response) };
  };
  const addStage = async (versionId: string, body: object, user: User = 'sub-marta') => {
    const response = await post(`/workflow-versions/${versionId}/stages`, body, user);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<WorkflowStageDto>(response);
  };
  /** Fluxo mínimo válido: ABERTURA (START) → ANALISE (TASK) → FIM (END). */
  const buildValidDraft = async (versionId: string, user: User = 'sub-marta') => {
    const abertura = await addStage(
      versionId,
      { key: 'ABERTURA', name: 'Abertura', type: 'START' },
      user,
    );
    const analise = await addStage(
      versionId,
      { key: 'ANALISE', name: 'Análise', type: 'TASK', slaDays: 5 },
      user,
    );
    const fim = await addStage(versionId, { key: 'FIM', name: 'Fim', type: 'END' }, user);
    for (const [key, from, to, action] of [
      ['ENVIAR_ANALISE', abertura.id, analise.id, 'FORWARD'],
      ['CONCLUIR', analise.id, fim.id, 'COMPLETE'],
    ] as const) {
      const response = await post(
        `/workflow-versions/${versionId}/transitions`,
        { key, name: `Transição ${key}`, fromStageId: from, toStageId: to, action },
        user,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
  };

  // Background: "Fase preparatória — Lei 14.133/2021" com a v1 PUBLISHED e a v2 em DRAFT.
  let fase: WorkflowDto;
  let v1: string;
  let v2: string;
  let v1Hash: string;
  let v2Etag: number;

  it('Background: v1 publicada sem notas (FA-02) e v2 em rascunho criada a partir dela (WF-08)', async () => {
    fase = await createWorkflow('FASE_PREPARATORIA_14133', 'Fase preparatória — Lei 14.133/2021');
    v1 = fase.draftVersion?.id ?? '';
    await buildValidDraft(v1);
    const { etag } = await versionOf(v1);

    const response = await publish(v1, {}, etag);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const published = data<WorkflowVersionSummaryDto>(response);
    expect(published).toMatchObject({ status: 'PUBLISHED', versionNumber: 1, changeNotes: null });
    expect(response.headers.etag).toBe(`"${published.version}"`);
    v1Hash = published.definitionHash ?? '';

    const draft = await post(`/workflows/${fase.id}/versions`, {});
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    v2 = data<WorkflowVersionDetailDto>(draft).id;
    v2Etag = etagOf(draft);
    expect(data<WorkflowVersionDetailDto>(draft)).toMatchObject({
      versionNumber: 2,
      status: 'DRAFT',
    });
  });

  it('WF-20: validação sem erros devolve só avisos (FA-01) e não grava nada', async () => {
    const audits = api.auditRecords().length;
    const response = await post(`/workflow-versions/${v2}/validate`, undefined);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = data<WorkflowValidationResult>(response);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('WF_STAGE_NO_INSTRUCTIONS');
    expect(result.warnings[0]).toMatchObject({ stageKey: expect.any(String) as unknown });
    expect(api.auditRecords()).toHaveLength(audits);
    // `WORKFLOW_VIEW` basta para validar (Diego prepara, mas não publica).
    expect((await post(`/workflow-versions/${v2}/validate`, undefined, 'sub-lucia')).status).toBe(
      200,
    );
  });

  it('[Validação] Publicar sem notas da versão → 422 VALIDATION_ERROR em changeNotes; v2 segue DRAFT', async () => {
    for (const body of [{}, { changeNotes: '   ' }, { changeNotes: null }]) {
      const response = await publish(v2, body, v2Etag);
      expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({
          field: 'changeNotes',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Descreva o que mudou nesta versão.',
        }),
      ]);
    }
    expect((await versionOf(v2)).version.status).toBe('DRAFT');
  });

  it('[Permissão] Gestor sem WORKFLOW_PUBLISH tenta publicar → 403 PERMISSION_DENIED + access.denied', async () => {
    const response = await publish(v2, { changeNotes: 'Nova etapa.' }, v2Etag, 'sub-lucia');
    expectProblem(response, 403, 'PERMISSION_DENIED');
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_PUBLISH' });
    expectProblem(await retire(v1, 1, 'sub-lucia'), 403, 'PERMISSION_DENIED');
    expect((await versionOf(v2)).version.status).toBe('DRAFT');
  });

  it('[Tenant incorreto] Publicar versão de outro tenant → 404 NOT_FOUND sem alterar nada', async () => {
    const other = await createWorkflow('FLUXO_B', 'Fluxo LEAK-B', 'sub-heitor');
    const otherDraft = other.draftVersion?.id ?? '';
    for (const response of [
      await publish(otherDraft, { changeNotes: 'Invasão' }, 1),
      await retire(otherDraft, 1),
      await post(`/workflow-versions/${otherDraft}/validate`, undefined),
      await get(`/workflows/${other.id}/versions`),
    ]) {
      expectProblem(response, 404, 'NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }
    expect((await versionOf(otherDraft, 'sub-heitor')).version.status).toBe('DRAFT');
  });

  it('[Falha de banco] Banco indisponível ao publicar → 503 DEPENDENCY_UNAVAILABLE; v2 sem snapshot', async () => {
    transactions.down = true;
    const response = await publish(v2, { changeNotes: 'Nova etapa.' }, v2Etag);
    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(logged('workflow.publish_failed').at(-1)).toMatchObject({
      workflowVersionId: v2,
      errorCode: 'DEPENDENCY_UNAVAILABLE',
    });
    transactions.down = false;
    const { version } = await versionOf(v2);
    expect(version).toMatchObject({ status: 'DRAFT', definitionHash: null, publishedAt: null });
  });

  it('[Sucesso] Publicar a v2 validada: PUBLISHED, corrente, evento e auditoria; v1 supersedida', async () => {
    const before = await versionOf(v2);
    const changeNotes = 'Inclui a análise de riscos antes do TR.';
    const response = await publish(v2, { changeNotes: `  ${changeNotes}  ` }, before.etag);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const published = data<WorkflowVersionSummaryDto>(response);
    expect(published).toMatchObject({
      id: v2,
      status: 'PUBLISHED',
      versionNumber: 2,
      changeNotes,
      publishedById: expect.any(String) as unknown,
    });
    expect(published.publishedAt).not.toBeNull();
    expect(response.headers.etag).toBe(`"${before.etag + 1}"`);

    // RN-WF-64: snapshot canônico (JCS) e SHA-256 gravados.
    const stored = repository.versions.get(v2);
    expect(stored?.definitionSnapshot).not.toBeNull();
    expect(stored?.definitionHash).toBe(sha256Hex(canonicalJson(stored?.definitionSnapshot)));
    expect(published.definitionHash).toBe(stored?.definitionHash);

    const workflow = await workflowOf(fase.id);
    expect(workflow.currentPublishedVersion?.id).toBe(v2);
    expect(workflow.draftVersion).toBeNull();

    expect(eventsOf('WorkflowVersionPublished').at(-1)).toMatchObject({
      routingKey: 'workflow.version_published',
      payload: {
        workflowId: fase.id,
        workflowVersionId: v2,
        versionNumber: 2,
        definitionHash: published.definitionHash,
      },
    });
    expect(auditOf('workflow.version_publish').at(-1)).toMatchObject({
      entityId: v2,
      category: 'CONFIGURATION',
      metadata: expect.objectContaining({
        versionNumber: 2,
        definitionHash: published.definitionHash,
        changeNotes,
      }) as unknown,
    });
    const log = logged('workflow.version_published').at(-1);
    expect(log).toMatchObject({ workflowVersionId: v2, definitionHash: published.definitionHash });
    expect(JSON.stringify(log)).not.toContain('ANALISE');

    // RN-WF-67: a v1 supersedida segue servindo o mesmo snapshot a quem a fixou.
    const { version: old } = await versionOf(v1);
    expect(old).toMatchObject({ status: 'RETIRED', definitionHash: v1Hash });
    expect(old.stages.map((stage) => stage.key)).toEqual(['ABERTURA', 'ANALISE', 'FIM']);
    expect(eventsOf('WorkflowVersionRetired').at(-1)?.payload).toEqual({
      workflowId: fase.id,
      workflowVersionId: v1,
    });
  });

  it('[Concorrência] Segunda publicação com o If-Match antigo → 412 VERSION_CONFLICT; uma só publicação', async () => {
    const stale = await publish(v2, { changeNotes: 'De novo.' }, v2Etag, 'sub-otavio');
    expectProblem(stale, 412, 'VERSION_CONFLICT');
    expect(auditOf('workflow.version_publish').filter((r) => r.entityId === v2)).toHaveLength(1);
    expect(
      eventsOf('WorkflowVersionPublished').filter(
        (row) => (row.payload as { workflowVersionId: string }).workflowVersionId === v2,
      ),
    ).toHaveLength(1);
    // Com o ETag atual, a versão já publicada não é publicada de novo (V-03).
    const { etag } = await versionOf(v2);
    expectProblem(await publish(v2, { changeNotes: 'De novo.' }, etag), 409, 'INVALID_STATE');
    expectProblem(
      await publish(v2, { changeNotes: 'Sem If-Match.' }, null),
      428,
      'PRECONDITION_REQUIRED',
    );
  });

  it('[Falha de integração] Sem relay, o evento fica no outbox e a publicação responde 200', () => {
    // O outbox em memória não tem relay: a linha gravada na transação é o que o relay publicará
    // depois (o status `PENDING` no PostgreSQL é conferido na suíte tenant leak).
    expect(eventsOf('WorkflowVersionPublished').length).toBeGreaterThanOrEqual(2);
  });

  it('[Duplicidade] Criar novo rascunho quando já existe um → 409 WORKFLOW_DRAFT_EXISTS', async () => {
    const v3 = await post(`/workflows/${fase.id}/versions`, {});
    expect(v3.status, JSON.stringify(v3.body)).toBe(201);
    const draftId = data<WorkflowVersionDetailDto>(v3).id;
    const again = await post(`/workflows/${fase.id}/versions`, {});
    expect(expectProblem(again, 409, 'WORKFLOW_DRAFT_EXISTS')).toMatchObject({
      meta: { draftVersionId: draftId },
    });
  });

  it('WF-07 (RN-WF-69): histórico por número decrescente com status, datas, notas e autores', async () => {
    const response = await get(`/workflows/${fase.id}/versions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const versions = data<WorkflowVersionSummaryDto[]>(response);
    expect(versions.map((version) => [version.versionNumber, version.status])).toEqual([
      [3, 'DRAFT'],
      [2, 'PUBLISHED'],
      [1, 'RETIRED'],
    ]);
    expect(versions[1]).toMatchObject({
      changeNotes: 'Inclui a análise de riscos antes do TR.',
      publishedByName: expect.any(String) as unknown,
    });
    expect(versions[2]?.retiredAt).not.toBeNull();
  });

  it('[Validação] FA-05: sem etapa inicial → WF_START_STAGE_COUNT na validação e 422 WORKFLOW_INVALID ao publicar', async () => {
    const broken = await createWorkflow('SEM_INICIO', 'Fluxo sem início');
    const draftId = broken.draftVersion?.id ?? '';
    await addStage(draftId, { key: 'ANALISE', name: 'Análise', type: 'TASK' });

    const validation = data<WorkflowValidationResult>(
      await post(`/workflow-versions/${draftId}/validate`, undefined),
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain('WF_START_STAGE_COUNT');

    const { etag } = await versionOf(draftId);
    const response = await publish(draftId, {}, etag);
    const problem = expectProblem(response, 422, 'WORKFLOW_INVALID');
    expect((problem as { validation?: WorkflowValidationResult }).validation?.errors).toEqual(
      validation.errors,
    );
    expect(logged('workflow.publish_blocked').at(-1)).toMatchObject({
      workflowVersionId: draftId,
      errorsCount: validation.errors.length,
    });
    expect((await versionOf(draftId)).version).toMatchObject({
      status: 'DRAFT',
      definitionHash: null,
    });
  });

  it('[Aposentar] corrente sem substituta → 409 WORKFLOW_IN_USE (FA-03); aposentada ou rascunho → 409 INVALID_STATE', async () => {
    const { etag } = await versionOf(v2);
    expect(expectProblem(await retire(v2, etag), 409, 'WORKFLOW_IN_USE').detail).toBe(
      'Publique uma nova versão antes de aposentar esta.',
    );
    const old = await versionOf(v1);
    expectProblem(await retire(v1, old.etag), 409, 'INVALID_STATE');
    const draft = (await workflowOf(fase.id)).draftVersion?.id ?? '';
    expectProblem(await retire(draft, (await versionOf(draft)).etag), 409, 'INVALID_STATE');
    expectProblem(await retire(v2, etag + 5), 412, 'VERSION_CONFLICT');
    expectProblem(await retire(v2, null), 428, 'PRECONDITION_REQUIRED');
    expect((await versionOf(v2)).version.status).toBe('PUBLISHED');
  });

  it('[Aposentar] workflow fora de uso (FA-04): aposenta a última publicada, evento e auditoria', async () => {
    const { etag } = await versionOf(v2);
    // WF-04 ainda não desativa workflow (fora desta story): a linha em memória é ajustada.
    const row = repository.workflows.get(fase.id);
    if (row) repository.workflows.set(fase.id, { ...row, isActive: false });

    const response = await retire(v2, etag);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const retired = data<WorkflowVersionSummaryDto>(response);
    expect(retired).toMatchObject({ id: v2, status: 'RETIRED' });
    expect(retired.retiredAt).not.toBeNull();
    expect(response.headers.etag).toBe(`"${etag + 1}"`);
    expect((await workflowOf(fase.id)).currentPublishedVersion).toBeNull();
    expect(eventsOf('WorkflowVersionRetired').at(-1)).toMatchObject({
      routingKey: 'workflow.version_retired',
      payload: { workflowId: fase.id, workflowVersionId: v2 },
    });
    expect(auditOf('workflow.version_retire').at(-1)).toMatchObject({
      entityId: v2,
      category: 'CONFIGURATION',
      metadata: expect.objectContaining({ versionNumber: 2 }) as unknown,
    });
    expect(logged('workflow.version_retired').at(-1)).toMatchObject({ workflowVersionId: v2 });
    // RN-WF-67: a definição aposentada continua legível (processos que a fixaram).
    expect((await versionOf(v2)).version.stages).toHaveLength(3);
  });
});

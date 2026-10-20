import { randomUUID } from 'node:crypto';

import {
  aiGenerationListItemSchema,
  aiGenerationSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { AiGenerationDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import type { AiCircuitStorePort } from '#shared/ai/ai-circuit-store.js';
import { AiSuggestionSourceRegistry } from '#shared/ai/ai-suggestion-source.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import {
  TestValueGuard,
  aiRepositoryOf,
  installAiTestDoubles,
  jobQueueOf,
  runAiJob,
  runAiJobWithRetries,
  validOutput,
} from '../../../../test/support/ai-fixtures.js';
import type { TestAiGate, TestAiGenerator } from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  createDocumentAs,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  runAsUser,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
import {
  catalogItemId,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { AiPostProcessorRegistry } from '../application/ai-extension-points.js';
import { AiMaintenanceService } from '../application/ai-maintenance.service.js';
import { AI_PROVIDER } from '../application/ai-provider.port.js';
import { AI_SETTINGS, AI_TRANSACTIONS } from '../application/ports.js';
import type { AiSettings, AiTransactions } from '../application/ports.js';
import { requestGeneration } from '../domain/ai-generation.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import { GroundingGuard } from '../domain/grounding-guard.js';
import { FakeAiProvider } from '../infrastructure/fake-ai.provider.js';

/*
 * US-115 — AI-01..04 e o job `ai-generation` pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, idempotência, rate limit, filtro RFC 9457) com a identidade fake, os
 * seeders reais, o processo do PRC-02, o DFD da fábrica única e os adaptadores em memória
 * (gerações, fila, disjuntor, auditoria, outbox e timeline). O job roda como o worker o rodaria
 * (`AiGenerationJob.process` com o `JobData` enfileirado). O provedor é o `FakeAiProvider` —
 * nenhuma chamada real. PostgreSQL real (RLS, únicos parciais, atomicidade): suíte
 * `test/tenant-leak/ai-generations.spec.ts`.
 *
 * Personas: "Carla" do Gherkin (PLANEJAMENTO com AI_GENERATE, custodiante) = Lúcia
 * (GESTOR_CONTRATACOES, cria o processo e é a responsável); "Bruno" sem AI_GENERATE e com
 * PROCESS_VIEW = Otávio (ADMIN_ORGAO); quem tem AI_GENERATE mas não custodia = Ana (REQUISITANTE).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const SUMMARY = 'Aquisição de 30 computadores para os laboratórios das escolas municipais.';
const ORG_A = '0192d115-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d115-0000-7000-8000-0000000000a1',
  manutencao: '0192d115-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d115-0000-7000-8000-0000000000a3',
  saude: '0192d115-0000-7000-8000-0000000000a4',
  posto: '0192d115-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** Transações do módulo que simulam o banco fora do ar (Falha de banco). */
class FlakyTransactions implements AiTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('Feature: Camada de IA com registro e rastreabilidade das gerações (US-115)', () => {
  let api: TestApi;
  let generator: TestAiGenerator;
  let gate: TestAiGate;
  const provider = new FakeAiProvider();
  const transactions = new FlakyTransactions();
  const settings: { -readonly [K in keyof AiSettings]: AiSettings[K] } = {
    provider: 'fake',
    models: { draft: 'fake-draft-1', section: 'fake-section-1' },
    requestTimeoutMs: 200,
    maxAttempts: 3,
    backoffBaseMs: 10_000,
    maxContextChars: 240_000,
  };
  let dfdTypeId: string;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  /** Processo novo (PRC-02) criado por Lúcia, que fica responsável (custódia — POL-01). */
  async function newProcess(): Promise<string> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: { id: string } }).data.id;
  }

  /** Processo com um DFD em `DRAFT` sob custódia de Lúcia (Background). */
  async function newDfd(): Promise<{ processId: string; documentId: string }> {
    const processId = await newProcess();
    const document = await createDocumentAs(api, LUCIA, {
      processId,
      documentTypeId: dfdTypeId,
      title: 'DFD dos laboratórios',
      templateVersionId: null,
    });
    return { processId, documentId: document.id };
  }

  const call = (
    method: 'get' | 'post',
    path: string,
    options: { subject?: string; tenant?: string; key?: string | null; body?: object } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.key !== null) pending = pending.set('Idempotency-Key', options.key ?? randomUUID());
    return options.body === undefined ? pending : pending.send(options.body);
  };

  const requestDraft = (
    target: { processId: string; documentId: string },
    options: { subject?: string; key?: string; body?: object } = {},
  ) =>
    call('post', `/processes/${target.processId}/ai-generations`, {
      ...options,
      body: options.body ?? {
        targetModule: 'DFD',
        kind: 'DRAFT',
        documentId: target.documentId,
        needSummary: SUMMARY,
      },
    });

  async function requested(target: { processId: string; documentId: string }): Promise<string> {
    const response = await requestDraft(target);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { data: { id: string } }).data.id;
  }

  const stored = (id: string): AiGeneration | undefined =>
    aiRepositoryOf(api)
      .all()
      .find((row) => row.id === id);
  const auditOf = (action: string, entityId?: string) =>
    api
      .auditRecords()
      .filter(
        (row) => row.action === action && (entityId === undefined || row.entityId === entityId),
      );
  const eventsOf = (aggregateId: string, eventType?: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.aggregateId === aggregateId &&
          (eventType === undefined || row.eventType === eventType),
      );

  /** Contexto de tenant fora do pipeline HTTP (tarefa de manutenção, porta do shared kernel). */
  const inTenant = <T>(work: () => Promise<T>, actor = LUCIA) =>
    runWithRequestContext({ correlationId: newId(), ip: '', userAgent: 'vitest' }, () => {
      updateRequestContext({
        tenantId: actor.tenantId,
        actor: { type: 'USER', userId: actor.userId, membershipId: actor.membershipId },
      });
      return work();
    });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: AI_PROVIDER, value: provider },
        { token: AI_SETTINGS, value: settings },
        { token: AI_TRANSACTIONS, value: transactions },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedDefaultRolesOf(api, A);
    // Ana (REQUISITANTE) lotada no setor solicitante: vê o processo, tem AI_GENERATE, não custodia.
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    dfdTypeId =
      documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === 'DFD')?.id ?? '';
    expect(dfdTypeId).not.toBe('');
    ({ generator, gate } = installAiTestDoubles(api));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });

  beforeEach(() => {
    provider.reset();
  });

  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    jobQueueOf(api).down = false;
    gate.decision = { allowed: true };
    generator.revoked = false;
    generator.confidential = false;
    generator.extraParts = [];
    settings.provider = 'fake';
    aiRepositoryOf(api).failWrite = null;
    api.app.get(AiPostProcessorRegistry).clear();
  });

  describe('[Sucesso]', () => {
    it('Solicitar e concluir uma geração: 202, QUEUED antes do provedor, job, SUCCEEDED, auditoria, timeline e o DFD intacto', async () => {
      const target = await newDfd();
      const before = documentRepositoryOf(api)
        .allDocuments()
        .find((row) => row.id === target.documentId);

      const response = await requestDraft(target);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const body = response.body as { data: AiGenerationDto; meta: { pollAfterMs: number } };
      const data = aiGenerationSchema.parse(body.data);
      expect(body.meta.pollAfterMs).toBe(2000);
      expect(response.headers.location).toBe(`/api/v1/ai-generations/${data.id}`);
      expect(data).toMatchObject({
        status: 'QUEUED',
        targetModule: 'DFD',
        kind: 'DRAFT',
        documentId: target.documentId,
        promptKey: 'test.draft',
        promptVersion: '1.0.0',
        provider: 'fake',
        requestedBy: { id: FAKE_USERS.lucia.id, name: 'Lúcia Matos' },
        output: null,
      });
      expect(JSON.stringify(body)).not.toContain(SUMMARY);
      expect(JSON.stringify(body)).not.toContain('costUsd');
      // RN-AI-01/02: registro e evento antes de qualquer chamada; nenhuma chamada na requisição.
      expect(provider.calls).toHaveLength(0);
      expect(stored(data.id)).toMatchObject({ status: 'QUEUED', reservedTokens: 15_000 });
      expect(eventsOf(data.id, 'AiGenerationRequested')).toHaveLength(1);
      const [requestAudit] = auditOf('ai.generation_request', data.id);
      expect(requestAudit?.metadata).toMatchObject({
        generationId: data.id,
        promptKey: 'test.draft',
        promptVersion: '1.0.0',
      });
      expect(JSON.stringify(requestAudit)).not.toContain(SUMMARY);
      const job = jobQueueOf(api).find('ai-generation', data.id);
      expect(job).toMatchObject({
        name: 'generate',
        jobId: data.id,
        options: { attempts: 3, backoffMs: 10_000 },
      });
      expect(job?.data.payload).toEqual({ generationId: data.id });
      expect(job?.data.meta).toMatchObject({
        tenantId: A,
        actor: { type: 'USER', userId: FAKE_USERS.lucia.id },
      });

      await expect(runAiJob(api, data.id)).resolves.toBe('completed');
      const done = stored(data.id);
      expect(done).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 1,
        costUsd: '0.000000',
        model: 'fake-draft-1',
      });
      expect(done?.inputRefs.map((ref) => ref.kind)).toEqual(['USER_SUMMARY', 'PROCESS']);
      expect(done?.contextHash).toMatch(/^[0-9a-f]{64}$/);
      expect(done?.outputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(done?.totalTokens).toBe((done?.inputTokens ?? 0) + (done?.outputTokens ?? 0));
      expect(done?.totalTokens).toBeGreaterThan(0);
      expect(done?.latencyMs).toBeGreaterThanOrEqual(0);
      expect((done?.expiresAt?.getTime() ?? 0) - (done?.completedAt?.getTime() ?? 0)).toBe(
        7 * 24 * 3_600_000,
      );
      expect(done?.output?.sections.map((section) => section.sectionKey)).toEqual([
        'NECESSIDADE',
        'JUSTIFICATIVA',
      ]);
      expect(provider.calls).toHaveLength(1);

      const [completed] = eventsOf(data.id, 'AiGenerationCompleted');
      expect(completed?.payload).toMatchObject({
        requestedById: FAKE_USERS.lucia.id,
        promptKey: 'test.draft',
        sectionsCount: 2,
        risksCount: 0,
      });
      const [completeAudit] = auditOf('ai.generation_complete', data.id);
      expect(completeAudit?.metadata).toMatchObject({
        contextHash: done?.contextHash,
        outputHash: done?.outputHash,
      });
      expect(JSON.stringify(completeAudit)).not.toContain('Aquisição');
      const entry = timelineRowsOf(api).find(
        (row) => row.type === 'AI_CONTENT_GENERATED' && row.entityId === data.id,
      );
      expect(entry).toMatchObject({ actorId: FAKE_USERS.lucia.id, processId: target.processId });

      const after = documentRepositoryOf(api)
        .allDocuments()
        .find((row) => row.id === target.documentId);
      expect(after).toEqual(before);
    });

    it('Pós-processamento registrado altera a saída antes de gravar (groundingReplacements = 1)', async () => {
      api.app.get(AiPostProcessorRegistry).register(new TestValueGuard());
      provider.enqueue({ kind: 'output', output: validOutput('Custo estimado de R$ 1.500,00.') });
      const id = await requested(await newDfd());
      await runAiJob(api, id);
      const done = stored(id);
      expect(done?.status).toBe('SUCCEEDED');
      expect(done?.groundingReplacements).toBe(2);
      const [first] = done?.output?.sections ?? [];
      expect(first?.groundingReplacements).toBe(1);
      expect(JSON.stringify(first?.content)).not.toContain('R$ 1.500,00');
      expect(JSON.stringify(first?.content)).toContain('"toConfirm"');
      // `[a confirmar: quantidade]` do texto + a troca do gancho.
      expect(first?.placeholdersCount).toBe(2);
    });

    it('GroundingGuard (US-122): troca valor e prazo sem entrada, mantém citação legal e conta as trocas', async () => {
      const chain = api.app.get(AiPostProcessorRegistry);
      chain.clear();
      chain.register(new GroundingGuard());
      provider.enqueue({
        kind: 'output',
        output: validOutput('Estimativa de R$ 80.000,00 em 90 dias, conforme o art. 18, § 1º.'),
      });
      const id = await requested(await newDfd());
      await runAiJob(api, id);
      const done = stored(id);
      expect(done?.status).toBe('SUCCEEDED');
      // 2 trocas por seção (valor e prazo) nas duas seções; + o "[a confirmar: quantidade]".
      expect(done).toMatchObject({ groundingReplacements: 4, placeholdersCount: 6 });
      const [first] = done?.output?.sections ?? [];
      expect(first).toMatchObject({ groundingReplacements: 2, placeholdersCount: 3 });
      const text = JSON.stringify(first?.content);
      expect(text).not.toContain('80.000');
      expect(text).not.toContain('90 dias');
      expect(text).toContain('art. 18, § 1º');
      expect(text).toContain('"category":"VALUE"');
      expect(text).toContain('"category":"DEADLINE"');
      // AI-02 expõe as contagens.
      const get = await call('get', `/ai-generations/${id}`, { key: null });
      expect(aiGenerationSchema.parse((get.body as { data: unknown }).data)).toMatchObject({
        groundingReplacements: 4,
        placeholdersCount: 6,
      });
    });

    it('Consultar (AI-02), listar (AI-03) e descartar (AI-04)', async () => {
      const target = await newDfd();
      const id = await requested(target);
      await runAiJob(api, id);

      const get = await call('get', `/ai-generations/${id}`, { key: null });
      expect(get.status, JSON.stringify(get.body)).toBe(200);
      const dto = aiGenerationSchema.parse((get.body as { data: unknown }).data);
      expect(dto.status).toBe('SUCCEEDED');
      expect(dto.output?.sections).toHaveLength(2);
      expect(dto.usage.totalTokens).toBeGreaterThan(0);
      expect(get.body).not.toHaveProperty('data.costUsd');
      expect(get.headers.etag).toMatch(/^"SUCCEEDED-\d+"$/);

      const list = await call('get', `/processes/${target.processId}/ai-generations`, {
        key: null,
      });
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const items = (list.body as { data: unknown[]; meta: { hasMore: boolean } }).data;
      expect(items.map((item) => aiGenerationListItemSchema.parse(item).id)).toEqual([id]);
      expect(items[0]).not.toHaveProperty('output');
      const filtered = await call(
        'get',
        `/processes/${target.processId}/ai-generations?status=QUEUED,RUNNING`,
        { key: null },
      );
      expect((filtered.body as { data: unknown[] }).data).toEqual([]);

      const discard = await call('post', `/ai-generations/${id}/discard`, { body: {} });
      expect(discard.status, JSON.stringify(discard.body)).toBe(200);
      expect((discard.body as { data: AiGenerationDto }).data.status).toBe('DISCARDED');
      expect(stored(id)).toMatchObject({ status: 'DISCARDED', discardedById: FAKE_USERS.lucia.id });
      expect(auditOf('ai.generation_discard', id)[0]?.metadata).toMatchObject({
        statusBefore: 'SUCCEEDED',
        statusAfter: 'DISCARDED',
      });
      // Repetir: devolve sem novo efeito; o descarte não gera evento.
      const again = await call('post', `/ai-generations/${id}/discard`, { body: {} });
      expect(again.status).toBe(200);
      expect(auditOf('ai.generation_discard', id)).toHaveLength(1);
      expect(eventsOf(id).map((row) => row.eventType)).toEqual([
        'AiGenerationRequested',
        'AiGenerationCompleted',
      ]);
      // AI-02 em DISCARDED: só metadados.
      const afterDiscard = await call('get', `/ai-generations/${id}`, { key: null });
      expect((afterDiscard.body as { data: AiGenerationDto }).data.output).toBeNull();
    });

    it('Proposta vence após 7 dias: EXPIRED mantendo o output (ai-proposals-expire)', async () => {
      const id = await requested(await newDfd());
      await runAiJob(api, id);
      const done = stored(id);
      if (done === undefined) throw new Error('geração ausente');
      aiRepositoryOf(api).seed({ ...done, expiresAt: new Date(Date.now() - 1_000) });
      const expired = await inTenant(() => api.app.get(AiMaintenanceService).expireProposals());
      expect(expired).toBeGreaterThanOrEqual(1);
      expect(stored(id)).toMatchObject({ status: 'EXPIRED', outputHash: done.outputHash });
      expect(stored(id)?.output).toEqual(done.output);
      // Vencida não se aplica (porta do shared kernel).
      await expect(
        inTenant(() =>
          runSimulatedTransaction((tx) =>
            api.app.get(AiSuggestionSourceRegistry).loadForApply(tx, {
              generationId: id,
              targetModule: 'DFD',
              documentId: done.documentId,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'AI_GENERATION_NOT_APPLICABLE' });
    });

    it('Um novo rascunho do mesmo alvo descarta a proposta anterior não aplicada (RN-AI-32)', async () => {
      const target = await newDfd();
      const first = await requested(target);
      await runAiJob(api, first);
      const second = await requested(target);
      expect(stored(first)?.status).toBe('DISCARDED');
      expect(stored(second)?.status).toBe('QUEUED');
      expect(auditOf('ai.generation_discard', first)[0]?.metadata).toMatchObject({
        reason: 'SUPERSEDED',
      });
    });
  });

  describe('[Validação]', () => {
    it('Seção sem ação ou chave: 422 VALIDATION_ERROR em sectionKey e nenhuma geração criada', async () => {
      const target = await newDfd();
      const total = aiRepositoryOf(api).all().length;
      const response = await requestDraft(target, {
        body: {
          targetModule: 'DFD',
          kind: 'SECTION',
          documentId: target.documentId,
          action: 'REWRITE',
        },
      });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'sectionKey', code: 'CONDITIONAL_REQUIRED' }),
      ]);
      expect(aiRepositoryOf(api).all()).toHaveLength(total);
    });

    it('V-01/V-03: par sem gerador e resumo exigido pelo gerador', async () => {
      const target = await newDfd();
      expectProblem(
        await requestDraft(target, {
          body: { targetModule: 'ETP', kind: 'DRAFT', documentId: target.documentId },
        }),
        422,
        'VALIDATION_ERROR',
      );
      const missing = await requestDraft(target, {
        body: { targetModule: 'DFD', kind: 'DRAFT', documentId: target.documentId },
      });
      expect(expectProblem(missing, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'needSummary', code: 'REQUIRED' }),
      ]);
      const short = await requestDraft(target, {
        body: {
          targetModule: 'DFD',
          kind: 'DRAFT',
          documentId: target.documentId,
          needSummary: 'curto',
        },
      });
      expect(expectProblem(short, 422, 'VALIDATION_ERROR').errors[0]?.field).toBe('needSummary');
    });

    it('V-05/V-06: documento de outro processo e documento fora de DRAFT/RETURNED', async () => {
      const target = await newDfd();
      const other = await newDfd();
      const foreign = await requestDraft(target, {
        body: {
          targetModule: 'DFD',
          kind: 'DRAFT',
          documentId: other.documentId,
          needSummary: SUMMARY,
        },
      });
      expect(expectProblem(foreign, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'documentId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      await runAsUser(LUCIA, async (tx) => {
        const repository = documentRepositoryOf(api);
        const document = await repository.findById(tx, target.documentId);
        if (document === null) throw new Error('DFD ausente');
        await repository.update(
          tx,
          { ...document, status: 'FINALIZED', version: document.version + 1 },
          document.version,
        );
      });
      expectProblem(await requestDraft(target), 409, 'DOCUMENT_NOT_EDITABLE');
    });

    it('Contexto minimizado antes de sair: CPF/e-mail redigidos, sem comentários, fornecedores nem orçamento sigiloso', async () => {
      generator.confidential = true;
      generator.extraParts = [
        {
          ref: { kind: 'PROCESS_ITEMS', id: null },
          label: 'Itens',
          data: {
            itens: [
              { descricao: 'Notebook', quantidade: 30, valorUnitario: 4_321.5, unitPrice: 4_321.5 },
            ],
            estimatedValue: 129_645,
            comments: [{ text: 'Comentário interno do Bruno' }],
            suppliers: [{ name: 'Fornecedora Alfa Ltda' }],
            responsibleName: 'Marcos Pereira',
            requestingDepartmentName: 'Secretaria de Educação',
          },
        },
      ];
      const target = await newDfd();
      const id = await requested(target);
      // O resumo chega com CPF e e-mail (o pedido é guardado como veio; o contexto é que sai limpo).
      const generation = stored(id);
      if (generation === undefined) throw new Error('geração ausente');
      aiRepositoryOf(api).seed({
        ...generation,
        needSummary: `${SUMMARY} Contato: joana.silva@prefeitura.gov.br, CPF 123.456.789-09.`,
      });
      await runAiJob(api, id);
      const sent = provider.calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
      expect(sent).toContain('[dado pessoal omitido]');
      for (const leaked of [
        'joana.silva@prefeitura.gov.br',
        '123.456.789-09',
        'Comentário interno',
        'Fornecedora Alfa',
        'Marcos Pereira',
        '4321.5',
        '129645',
      ]) {
        expect(sent).not.toContain(leaked);
      }
      expect(sent).toContain('Secretaria de Educação');
      expect(sent).toContain('<<<DADOS');
      expect(stored(id)?.output?.warnings).toContainEqual({
        code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED',
      });
    });

    it('Saída inválida com um reparo: SUCCEEDED somando os tokens; inválida no reparo → FAILED/OUTPUT_INVALID', async () => {
      provider.enqueue(
        { kind: 'output', output: { secoes: [] }, usage: { inputTokens: 100, outputTokens: 10 } },
        { kind: 'output', output: validOutput(), usage: { inputTokens: 150, outputTokens: 40 } },
      );
      const repaired = await requested(await newDfd());
      await runAiJob(api, repaired);
      expect(stored(repaired)).toMatchObject({
        status: 'SUCCEEDED',
        inputTokens: 250,
        outputTokens: 50,
        totalTokens: 300,
      });
      expect(provider.calls.map((call) => call.metadata.call)).toEqual(['initial', 'repair']);
      expect(provider.calls[1]?.messages.at(-1)?.content).toContain('sections');

      provider.reset();
      provider.enqueue(
        { kind: 'output', output: 'isto não é JSON' },
        { kind: 'output', output: { sections: [{ sectionKey: 'OUTRA', blocks: [] }] } },
      );
      const invalid = await requested(await newDfd());
      await runAiJob(api, invalid);
      expect(stored(invalid)).toMatchObject({
        status: 'FAILED',
        errorCode: 'OUTPUT_INVALID',
        output: null,
      });
      expect(eventsOf(invalid, 'AiGenerationFailed')[0]?.payload).toMatchObject({
        errorCode: 'OUTPUT_INVALID',
        requestedById: FAKE_USERS.lucia.id,
      });
    });

    it('Provedor devolve marcação inválida (US-122 · V-09): toConfirm de categoria XYZ → FAILED/OUTPUT_INVALID após o reparo, sem output', async () => {
      const invalidMarker = {
        sections: [
          {
            sectionKey: 'NECESSIDADE',
            blocks: [
              {
                type: 'paragraph',
                text: [
                  { type: 'toConfirm', attrs: { label: 'prazo', category: 'XYZ', origin: 'AI' } },
                ],
              },
            ],
          },
        ],
      };
      provider.enqueue(
        { kind: 'output', output: invalidMarker },
        { kind: 'output', output: invalidMarker },
      );
      const id = await requested(await newDfd());
      await runAiJob(api, id);
      expect(provider.calls.map((call) => call.metadata.call)).toEqual(['initial', 'repair']);
      expect(stored(id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'OUTPUT_INVALID',
        output: null,
      });
    });

    it('Falha fechada do pós-processamento (RN-AI-54): gancho com erro ou toConfirm fora do contrato → OUTPUT_INVALID sem output', async () => {
      const chain = api.app.get(AiPostProcessorRegistry);
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      chain.register({
        name: 'quebrado',
        process: () => {
          throw new Error('falha do guard');
        },
      });
      provider.enqueue({ kind: 'output', output: validOutput('R$ 10,00') });
      const broken = await requested(await newDfd());
      await runAiJob(api, broken);
      expect(stored(broken)).toMatchObject({
        status: 'FAILED',
        errorCode: 'OUTPUT_INVALID',
        output: null,
      });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ai.grounding_failed', generationId: broken }),
        'ai.grounding_failed',
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain('R$ 10,00');

      chain.clear();
      chain.register({
        name: 'marcacao-invalida',
        process: ({ output }) => ({
          ...output,
          sections: output.sections.map((section) => ({
            ...section,
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'toConfirm', attrs: { label: '', category: 'XYZ', origin: 'AI' } },
                  ],
                },
              ],
            },
          })),
        }),
      });
      provider.enqueue({ kind: 'output', output: validOutput() });
      const invalid = await requested(await newDfd());
      await runAiJob(api, invalid);
      expect(stored(invalid)).toMatchObject({
        status: 'FAILED',
        errorCode: 'OUTPUT_INVALID',
        output: null,
      });
      error.mockRestore();
    });

    it('Política mudou antes da execução (FA-06): CANCELED_BY_POLICY sem chamar o provedor', async () => {
      const id = await requested(await newDfd());
      gate.decision = { allowed: false, code: 'AI_USAGE_LIMIT_REACHED' };
      await runAiJob(api, id);
      expect(stored(id)).toMatchObject({ status: 'CANCELED', errorCode: 'CANCELED_BY_POLICY' });
      expect(provider.calls).toHaveLength(0);
      expect(eventsOf(id).map((row) => row.eventType)).toEqual(['AiGenerationRequested']);

      gate.decision = { allowed: true };
      generator.revoked = true;
      const lost = await requested(await newDfd());
      await runAiJob(api, lost);
      expect(stored(lost)).toMatchObject({ status: 'CANCELED', errorCode: 'CANCELED_BY_POLICY' });
    });

    it('Portão do órgão recusa o pedido (US-116): 403 AI_DISABLED e 422 de limite', async () => {
      const target = await newDfd();
      gate.decision = { allowed: false, code: 'AI_DISABLED' };
      expectProblem(await requestDraft(target), 403, 'AI_DISABLED');
      gate.decision = { allowed: false, code: 'AI_USER_DAILY_LIMIT_REACHED' };
      expectProblem(await requestDraft(target), 422, 'AI_USER_DAILY_LIMIT_REACHED');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem AI_GENERATE: 403 PERMISSION_DENIED e access.denied', async () => {
      const target = await newDfd();
      const response = await requestDraft(target, { subject: 'sub-otavio' });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(
        api
          .auditRecords()
          .some(
            (row) =>
              row.action === 'access.denied' &&
              row.reasonCode === 'AI_GENERATE' &&
              row.actorUserId === FAKE_USERS.otavio.id,
          ),
      ).toBe(true);
    });

    it('Com AI_GENERATE, mas sem custódia nem participação (POL-02): 403 sem gravar', async () => {
      const target = await newDfd();
      const total = aiRepositoryOf(api).all().length;
      const response = await requestDraft(target, { subject: 'sub-ana' });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(aiRepositoryOf(api).all()).toHaveLength(total);
    });

    it('Outra pessoa tenta descartar: 403 AI_GENERATION_NOT_OWNED e status inalterado', async () => {
      const id = await requested(await newDfd());
      const response = await call('post', `/ai-generations/${id}/discard`, {
        subject: 'sub-otavio',
        body: {},
      });
      expectProblem(response, 403, 'AI_GENERATION_NOT_OWNED');
      expect(stored(id)?.status).toBe('QUEUED');
      // Consultar exige só PROCESS_VIEW (Otávio vê o processo).
      expect(
        (await call('get', `/ai-generations/${id}`, { subject: 'sub-otavio', key: null })).status,
      ).toBe(200);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Geração e processo de outro tenant: 404 sem revelar nada', async () => {
      const foreign = requestGeneration({
        id: newId(),
        tenantId: B,
        processId: newId(),
        documentId: newId(),
        targetModule: 'DFD',
        kind: 'DRAFT',
        action: null,
        sectionKey: null,
        baseRevision: null,
        needSummary: SUMMARY,
        instruction: null,
        provider: 'fake',
        promptKey: 'test.draft',
        promptVersion: '1.0.0',
        reservedTokens: 15_000,
        createdById: FAKE_USERS.heitor.id,
        now: new Date(),
      });
      aiRepositoryOf(api).seed(foreign);
      const get = await call('get', `/ai-generations/${foreign.id}`, { key: null });
      const problem = expectProblem(get, 404, 'AI_GENERATION_NOT_FOUND');
      expect(JSON.stringify(problem)).not.toContain(foreign.processId);
      expectProblem(
        await call('post', `/ai-generations/${foreign.id}/discard`, { body: {} }),
        404,
        'AI_GENERATION_NOT_FOUND',
      );
      expect(
        aiRepositoryOf(api)
          .all()
          .find((row) => row.id === foreign.id)?.status,
      ).toBe('QUEUED');
      expectProblem(
        await requestDraft({ processId: foreign.processId, documentId: foreign.documentId ?? '' }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expectProblem(
        await call('get', `/processes/${foreign.processId}/ai-generations`, { key: null }),
        404,
        'PROCESS_NOT_FOUND',
      );
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave de idempotência: 202 + Idempotent-Replayed, uma geração e um job', async () => {
      const target = await newDfd();
      const key = randomUUID();
      const first = await requestDraft(target, { key });
      expect(first.status).toBe(202);
      const replay = await requestDraft(target, { key });
      expect(replay.status).toBe(202);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const id = (first.body as { data: { id: string } }).data.id;
      expect((replay.body as { data: { id: string } }).data.id).toBe(id);
      expect(
        aiRepositoryOf(api)
          .all()
          .filter((row) => row.processId === target.processId),
      ).toHaveLength(1);
      expect(
        jobQueueOf(api)
          .all()
          .filter((job) => job.jobId === id),
      ).toHaveLength(1);
    });

    it('Segunda geração ativa para o mesmo alvo: 409 AI_GENERATION_IN_PROGRESS com meta.generationId', async () => {
      const target = await newDfd();
      const id = await requested(target);
      const generation = stored(id);
      if (generation === undefined) throw new Error('geração ausente');
      aiRepositoryOf(api).seed({ ...generation, status: 'RUNNING', attempts: 1 });
      const response = await requestDraft(target);
      const problem = expectProblem(response, 409, 'AI_GENERATION_IN_PROGRESS');
      expect(problem).toMatchObject({ meta: { generationId: id } });
    });
  });

  describe('[Concorrência]', () => {
    it('Cancelamento durante a execução: fica CANCELED, sem output, com os tokens registrados', async () => {
      // O cenário é o cancelamento, não o timeout: com a suíte inteira em paralelo, o POST do
      // descarte pode passar dos 200 ms do provedor e virar TIMEOUT (falso negativo).
      settings.requestTimeoutMs = 30_000;
      onTestFinished(() => {
        settings.requestTimeoutMs = 200;
      });
      const gateway = deferred();
      provider.enqueue({
        kind: 'wait',
        until: gateway.promise,
        then: {
          kind: 'output',
          output: validOutput(),
          usage: { inputTokens: 90, outputTokens: 30 },
        },
      });
      const id = await requested(await newDfd());
      const running = runAiJob(api, id);
      await vi.waitFor(() => {
        expect(provider.calls).toHaveLength(1);
      });
      expect(stored(id)?.status).toBe('RUNNING');
      const cancel = await call('post', `/ai-generations/${id}/discard`, { body: {} });
      expect((cancel.body as { data: AiGenerationDto }).data.status).toBe('CANCELED');
      gateway.release();
      await running;
      expect(stored(id)).toMatchObject({
        status: 'CANCELED',
        output: null,
        errorCode: null,
        inputTokens: 90,
        outputTokens: 30,
      });
      expect(eventsOf(id).map((row) => row.eventType)).toEqual(['AiGenerationRequested']);
    });

    it('Job duplicado: só um chama o provedor; aplicações simultâneas: uma vence', async () => {
      const id = await requested(await newDfd());
      await Promise.all([runAiJob(api, id), runAiJob(api, id)]);
      expect(provider.calls).toHaveLength(1);
      expect(stored(id)?.status).toBe('SUCCEEDED');
      // Mesmo job relido numa tentativa já feita: não executa de novo.
      await runAiJob(api, id, 1);
      expect(provider.calls).toHaveLength(1);

      const source = api.app.get(AiSuggestionSourceRegistry);
      const apply = () =>
        inTenant(() =>
          runSimulatedTransaction((tx) =>
            source.markApplied(tx, {
              generationId: id,
              targets: { sectionKeys: ['NECESSIDADE'], riskIds: [] },
            }),
          ),
        );
      const results = await Promise.allSettled([apply(), apply()]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected?.reason).toMatchObject({
        code: 'AI_GENERATION_NOT_APPLICABLE',
      });
      expect(stored(id)).toMatchObject({
        status: 'APPLIED',
        appliedById: FAKE_USERS.lucia.id,
        appliedTargets: { sectionKeys: ['NECESSIDADE'], riskIds: [] },
      });
    });

    it('Só o solicitante lê a proposta para aplicar (porta AiSuggestionSource)', async () => {
      const id = await requested(await newDfd());
      await runAiJob(api, id);
      const otavio: FixtureActor = {
        tenantId: A,
        userId: FAKE_USERS.otavio.id,
        membershipId: membershipOf(FAKE_USERS.otavio.id),
      };
      await expect(
        inTenant(
          () =>
            runSimulatedTransaction((tx) =>
              api.app
                .get(AiSuggestionSourceRegistry)
                .loadForApply(tx, { generationId: id, targetModule: 'DFD', documentId: null }),
            ),
          otavio,
        ),
      ).rejects.toMatchObject({ code: 'AI_GENERATION_NOT_OWNED' });
      const suggestion = await inTenant(() =>
        runSimulatedTransaction((tx) =>
          api.app.get(AiSuggestionSourceRegistry).loadForApply(tx, {
            generationId: id,
            targetModule: 'DFD',
            documentId: stored(id)?.documentId ?? null,
          }),
        ),
      );
      expect(suggestion).toMatchObject({ generationId: id, status: 'SUCCEEDED' });
      await expect(
        inTenant(() =>
          runSimulatedTransaction((tx) =>
            api.app
              .get(AiSuggestionSourceRegistry)
              .loadForApply(tx, { generationId: id, targetModule: 'ETP', documentId: null }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'AI_GENERATION_NOT_APPLICABLE' });
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na solicitação: 503 DEPENDENCY_UNAVAILABLE, sem registro e sem job', async () => {
      const target = await newDfd();
      const total = aiRepositoryOf(api).all().length;
      const jobs = jobQueueOf(api).all().length;
      transactions.down = true;
      expectProblem(await requestDraft(target), 503, 'DEPENDENCY_UNAVAILABLE');
      expect(aiRepositoryOf(api).all()).toHaveLength(total);
      expect(jobQueueOf(api).all()).toHaveLength(jobs);
    });

    it('Banco indisponível ao gravar o resultado: nada parcial; a retentativa conclui', async () => {
      const id = await requested(await newDfd());
      aiRepositoryOf(api).failWrite = (next) =>
        next.status === 'SUCCEEDED' ? new DatabaseUnavailableError(new Error('ECONNRESET')) : null;
      await expect(runAiJob(api, id, 1)).rejects.toBeInstanceOf(DatabaseUnavailableError);
      expect(stored(id)).toMatchObject({ status: 'RUNNING', output: null, outputHash: null });
      expect(eventsOf(id, 'AiGenerationCompleted')).toHaveLength(0);
      await runAiJob(api, id, 2);
      expect(stored(id)).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
      expect(stored(id)?.output).not.toBeNull();
    });
  });

  describe('[Falha de integração]', () => {
    it('Provedor com 429 duas vezes e depois sucesso: SUCCEEDED com attempts = 3', async () => {
      provider.enqueue(
        { kind: 'error', error: 'RATE_LIMITED' },
        { kind: 'error', error: 'RATE_LIMITED' },
        { kind: 'output', output: validOutput() },
      );
      const id = await requested(await newDfd());
      const { attempts, error } = await runAiJobWithRetries(api, id);
      expect(error).toBeNull();
      expect(attempts).toBe(3);
      expect(stored(id)).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
    });

    it('Timeout em todas as tentativas: FAILED/TIMEOUT, evento, auditoria e aviso ao solicitante', async () => {
      provider.enqueue({ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' });
      const id = await requested(await newDfd());
      const { error } = await runAiJobWithRetries(api, id);
      expect(error).toBeNull();
      expect(stored(id)).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT', attempts: 3 });
      expect(eventsOf(id, 'AiGenerationFailed')[0]?.payload).toMatchObject({
        errorCode: 'TIMEOUT',
        attempts: 3,
        requestedById: FAKE_USERS.lucia.id,
      });
      expect(auditOf('ai.generation_fail', id)[0]?.metadata).toMatchObject({
        errorCode: 'TIMEOUT',
      });
      const circuit = api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE);
      await circuit.recordSuccess();
    });

    it('Disjuntor aberto: 503 AI_PROVIDER_UNAVAILABLE com Retry-After', async () => {
      const circuit = api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE);
      const now = Date.now();
      for (let failure = 0; failure < 5; failure += 1) await circuit.recordFailure(now);
      const response = await requestDraft(await newDfd());
      expectProblem(response, 503, 'AI_PROVIDER_UNAVAILABLE');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      await circuit.recordSuccess();
    });

    it('RUNNING há mais de 10 min → FAILED/TIMEOUT pela manutenção (ai-generations-timeout)', async () => {
      const id = await requested(await newDfd());
      const generation = stored(id);
      if (generation === undefined) throw new Error('geração ausente');
      aiRepositoryOf(api).seed({
        ...generation,
        status: 'RUNNING',
        attempts: 1,
        startedAt: new Date(Date.now() - 11 * 60_000),
      });
      const failed = await inTenant(() => api.app.get(AiMaintenanceService).failStaleRunning());
      expect(failed).toBeGreaterThanOrEqual(1);
      expect(stored(id)).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT' });
      expect(eventsOf(id, 'AiGenerationFailed')[0]?.payload).toMatchObject({
        errorCode: 'TIMEOUT',
      });
      expect(auditOf('ai.generation_fail', id)[0]?.metadata).toMatchObject({
        reason: 'RUNNING_TIMEOUT',
      });
      // Repetir não duplica (gravação condicional ao status).
      await inTenant(() => api.app.get(AiMaintenanceService).failStaleRunning());
      expect(eventsOf(id, 'AiGenerationFailed')).toHaveLength(1);
    });

    it('AI_PROVIDER=none: 503 para todos', async () => {
      settings.provider = 'none';
      expectProblem(await requestDraft(await newDfd()), 503, 'AI_PROVIDER_UNAVAILABLE');
    });

    it('Redis de filas fora: 202 e a geração fica QUEUED; relay fora: eventos PENDING no outbox', async () => {
      jobQueueOf(api).down = true;
      const id = await requested(await newDfd());
      expect(stored(id)?.status).toBe('QUEUED');
      expect(jobQueueOf(api).find('ai-generation', id)).toBeUndefined();
      // Sem relay (modo em memória): o evento fica gravado no outbox até ser publicado.
      expect(eventsOf(id, 'AiGenerationRequested')).toHaveLength(1);
    });

    it('Limite "Geração com IA": 10 req/min por usuário + tenant', async () => {
      const target = await newDfd();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        statuses.push((await requestDraft(target)).status);
      }
      expect(statuses.at(-1)).toBe(429);
    });
  });
});

import { randomUUID } from 'node:crypto';

import {
  aiGenerationSchema,
  dfdSchema,
  documentAiApplyResultSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { AiGenerationDto, DfdDto, ProcessDto } from '@contrataflow/validation';
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
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import {
  TestAiGate,
  aiRepositoryOf,
  dfdRepositoryOf,
  jobQueueOf,
  runAiJob,
  runAiJobWithRetries,
} from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  DOCUMENT_TRANSACTIONS,
  documentItemRepositoryOf,
  documentRepositoryOf,
  filledSection,
} from '../../../../test/support/document-fixtures.js';
import type { DocumentTransactions } from '../../../../test/support/document-fixtures.js';
import {
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { AiTenantGateRegistry } from '../application/ai-extension-points.js';
import { AI_PROVIDER } from '../application/ai-provider.port.js';
import { AI_SETTINGS } from '../application/ports.js';
import type { AiSettings } from '../application/ports.js';
import { requestGeneration } from '../domain/ai-generation.js';
import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from '../infrastructure/fake-ai.provider.js';

/*
 * US-117 — Gerar o rascunho do DFD com IA (AI-01 → job `ai-generation` → AI-02 → DOC-26) pelo
 * pipeline HTTP completo, com o gerador REAL `draft.dfd` (contexto pelas fachadas de `document`,
 * `dfd`, `process`, `catalog`, `organization` e `tenancy`), o `FakeAiProvider` com a fixture
 * `draft.dfd/padrao` (nenhuma chamada real) e os adaptadores em memória. O portão do órgão é o de
 * teste (US-116 tem a suíte própria). Notificações `AI_GENERATION_READY/FAILED`: o worker as deriva
 * de `AiGenerationCompleted/Failed` (`apps/worker/src/notifications/notification-rules.spec.ts`);
 * aqui conferimos o evento. Atomicidade e RLS em PostgreSQL: `test/tenant-leak/ai-dfd-draft.spec.ts`.
 *
 * Personas: "Rita" (REQUISITANTE com AI_GENERATE e custódia) = Ana, que abre o processo; "Carla"
 * (DFD_UPDATE por participação COLLABORATOR) = Lúcia; "Bruno" (sem AI_GENERATE) = Otávio.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const SUMMARY =
  'Aquisição de computadores para os laboratórios de informática das escolas municipais, que hoje operam com equipamentos obsoletos e sem suporte, prejudicando as aulas.';
const UNITS_A = {
  organizationId: '0192d117-0000-7000-8000-0000000000a0',
  obras: '0192d117-0000-7000-8000-0000000000a1',
  manutencao: '0192d117-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d117-0000-7000-8000-0000000000a3',
  saude: '0192d117-0000-7000-8000-0000000000a4',
  posto: '0192d117-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d117-0000-7000-8000-0000000000b0',
  obras: '0192d117-0000-7000-8000-0000000000b1',
  manutencao: '0192d117-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d117-0000-7000-8000-0000000000b3',
  saude: '0192d117-0000-7000-8000-0000000000b4',
  posto: '0192d117-0000-7000-8000-0000000000b5',
};
const NARRATIVE = ['JUSTIFICATION', 'EXPECTED_RESULTS', 'NOTES'];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do `document` que simulam o banco fora do ar (Falha de banco no DOC-26). */
class FlakyDocumentTransactions implements DocumentTransactions {
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

interface Target {
  readonly processId: string;
  readonly documentId: string;
}
type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Gerar o rascunho do DFD com IA (US-117)', () => {
  let api: TestApi;
  const provider = new FakeAiProvider(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR));
  const transactions = new FlakyDocumentTransactions();
  const gate = new TestAiGate();
  const settings: { -readonly [K in keyof AiSettings]: AiSettings[K] } = {
    provider: 'fake',
    models: { draft: 'fake-draft-1', section: 'fake-section-1' },
    requestTimeoutMs: 5_000,
    maxAttempts: 3,
    backoffBaseMs: 10_000,
    maxContextChars: 240_000,
  };
  let units: { un: string };
  const words = () => randomUUID().replaceAll('-', '').slice(0, 10);

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);

  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const stored = (id: string) =>
    aiRepositoryOf(api)
      .all()
      .find((row) => row.id === id);
  const auditOf = (action: string, entityId?: string) =>
    api
      .auditRecords()
      .filter(
        (row) => row.action === action && (entityId === undefined || row.entityId === entityId),
      );
  const eventsOf = (aggregateId: string, eventType: string) =>
    api
      .outboxRows()
      .filter((row) => row.aggregateId === aggregateId && row.eventType === eventType);

  /** Processo aberto por Ana (custódia), com os valores do cenário. */
  async function newProcess(
    fields: Partial<Process> = {},
    subject = 'sub-ana',
    tenant: string = A,
  ): Promise<Process> {
    const units = tenant === A ? UNITS_A : UNITS_B;
    const response = await auth(request(api.server).post('/api/v1/processes'), subject, tenant)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, tenant, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: units.obras,
        requestingDepartmentId: units.manutencao,
        originId: catalogItemId(api, tenant, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        priority: 'HIGH',
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: ProcessDto }).data.id;
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!created) throw new Error('processo ausente');
    const process: Process = { ...created, ...fields };
    processRepositoryOf(api).replace(process);
    return process;
  }

  async function createDfd(processId: string, subject = 'sub-ana', tenant: string = A) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/dfds`),
      subject,
      tenant,
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return dfdSchema.parse((response.body as { data: DfdDto }).data);
  }

  /** Itens do DFD (DOC-07) sobre itens novos do processo. */
  async function addItems(target: Target, descriptions: readonly string[]) {
    const items: { processItemId: string; quantity: string }[] = [];
    for (const [index, description] of descriptions.entries()) {
      const response = await auth(
        request(api.server).post(`/api/v1/processes/${target.processId}/items`),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'GOOD', description, unitOfMeasureId: units.un });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      items.push({
        processItemId: (response.body as { data: { id: string } }).data.id,
        quantity: String(10 * (index + 1)),
      });
    }
    const saved = await auth(
      request(api.server).put(`/api/v1/documents/${target.documentId}/items`),
    )
      .set('If-Match', `"${String(documentOf(target.documentId).version)}"`)
      .send({ items });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }

  /** Background: processo "0012/2026" com o DFD em DRAFT e 3 itens; Lúcia colaboradora. */
  async function background(
    options: { items?: boolean; process?: Partial<Process> } = {},
  ): Promise<Target> {
    const process = await newProcess(options.process);
    const dfd = await createDfd(process.id);
    const target = { processId: process.id, documentId: dfd.documentId };
    if (options.items !== false) {
      await addItems(target, ['Computador desktop', 'Monitor 24 polegadas', 'Teclado e mouse']);
    }
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.lucia.id,
      role: 'COLLABORATOR',
    });
    return target;
  }

  const requestDraft = (
    target: Target,
    options: { subject?: string; key?: string; body?: object; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(
        options.body ?? {
          targetModule: 'DFD',
          kind: 'DRAFT',
          documentId: target.documentId,
          needSummary: SUMMARY,
        },
      );

  async function requested(target: Target): Promise<string> {
    const response = await requestDraft(target);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { data: AiGenerationDto }).data.id;
  }

  /** Proposta `SUCCEEDED` de Rita para o DFD. */
  async function proposal(target: Target): Promise<string> {
    const id = await requested(target);
    await expect(runAiJob(api, id)).resolves.toBe('completed');
    expect(stored(id)?.status).toBe('SUCCEEDED');
    return id;
  }

  const apply = (
    documentId: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string | null; subject?: string; key?: string; tenant?: string } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/documents/${documentId}/ai-apply`),
      options.subject,
      options.tenant,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    const ifMatch =
      options.ifMatch === undefined
        ? `"${String(documentOf(documentId).version)}"`
        : options.ifMatch;
    return (ifMatch === null ? call : call.set('If-Match', ifMatch)).send(body);
  };

  const discard = (id: string, subject = 'sub-ana') =>
    auth(request(api.server).post(`/api/v1/ai-generations/${id}/discard`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({});

  function seedSection(documentId: string, key: string, section: ReturnType<typeof filledSection>) {
    const document = documentOf(documentId);
    documentRepositoryOf(api).seed({
      ...document,
      draftContent: { sections: { ...document.draftContent.sections, [key]: section } },
    });
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: AI_PROVIDER, value: provider },
        { token: AI_SETTINGS, value: settings },
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
      ],
    });
    for (const tenant of [A, B]) {
      await runTenantSeeders(api, tenant, [
        'catalog.items',
        'access.defaultRoles',
        'document.systemTypes',
        'document.templateLibrary',
        'workflow.seedWorkflows',
      ]);
    }
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    seedDefaultRolesOf(api, A);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    units = { un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN') };
    api.app.get(AiTenantGateRegistry).register(gate);
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
    settings.requestTimeoutMs = 5_000;
  });

  describe('[Sucesso]', () => {
    it('Solicitar o rascunho do DFD: 202 QUEUED + Location, auditoria, evento e job depois do commit', async () => {
      const target = await background();
      const response = await requestDraft(target);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const body = response.body as { data: AiGenerationDto; meta: { pollAfterMs: number } };
      const generation = aiGenerationSchema.parse(body.data);
      expect(generation).toMatchObject({
        status: 'QUEUED',
        targetModule: 'DFD',
        kind: 'DRAFT',
        documentId: target.documentId,
        promptKey: 'draft.dfd',
        promptVersion: '1.0.0',
      });
      expect(response.headers.location).toBe(`/api/v1/ai-generations/${generation.id}`);
      expect(body.meta.pollAfterMs).toBe(2000);
      expect(stored(generation.id)).toMatchObject({ status: 'QUEUED', reservedTokens: 15_000 });
      expect(auditOf('ai.generation_request', generation.id)[0]?.metadata).toMatchObject({
        promptKey: 'draft.dfd',
        reservedTokens: 15_000,
      });
      expect(JSON.stringify(auditOf('ai.generation_request', generation.id))).not.toContain(
        SUMMARY,
      );
      expect(eventsOf(generation.id, 'AiGenerationRequested')).toHaveLength(1);
      // Gravado (commit) e só então enfileirado; nenhuma chamada ao provedor na requisição.
      expect(jobQueueOf(api).find('ai-generation', generation.id)).toMatchObject({
        jobId: generation.id,
      });
      expect(provider.calls).toHaveLength(0);
    });

    it('Concluir a geração: SUCCEEDED com JUSTIFICATION/EXPECTED_RESULTS/NOTES, inputRefs de todas as fontes, evento e timeline', async () => {
      const target = await background();
      const before = documentOf(target.documentId);
      const id = await proposal(target);
      const done = stored(id);
      expect(done?.output?.sections.map((section) => section.sectionKey)).toEqual(NARRATIVE);
      expect(done?.inputRefs.map((ref) => ref.kind)).toEqual([
        'USER_SUMMARY',
        'PROCESS',
        'CATALOG',
        'DOCUMENT_DRAFT',
        'PROCESS_ITEMS',
        'ORGANIZATION',
        'TEMPLATE_VERSION',
      ]);
      expect(done?.inputRefs.find((ref) => ref.kind === 'TEMPLATE_VERSION')?.id).toBe(
        before.templateVersionId,
      );
      expect(done?.placeholdersCount).toBeGreaterThan(0);
      // Sem data prevista no DFD: lacuna avisada (FA-07); itens presentes.
      expect(done?.output?.warnings).toEqual([
        { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'EXPECTED_DATE' } },
      ]);

      // O contexto enviado: itens, unidade requisitante e guia do modelo; sem pessoas.
      const sent = JSON.stringify(provider.calls[0]?.messages);
      expect(sent).toContain('Computador desktop');
      expect(sent).toContain('Justificativa da necessidade');
      expect(sent).not.toContain(FAKE_USERS.ana.id);
      expect(provider.calls[0]?.metadata.promptKey).toBe('draft.dfd');

      // AI_GENERATION_READY é derivada deste evento pelo worker (ao solicitante).
      expect(eventsOf(id, 'AiGenerationCompleted')[0]?.payload).toMatchObject({
        requestedById: FAKE_USERS.ana.id,
        promptKey: 'draft.dfd',
        sectionsCount: 3,
      });
      expect(
        timelineRowsOf(api).find(
          (row) => row.type === 'AI_CONTENT_GENERATED' && row.entityId === id,
        ),
      ).toMatchObject({ actorId: FAKE_USERS.ana.id, processId: target.processId });
      // A geração nunca altera o documento.
      expect(documentOf(target.documentId)).toEqual(before);

      const polled = await auth(request(api.server).get(`/api/v1/ai-generations/${id}`));
      expect(polled.status).toBe(200);
      expect(aiGenerationSchema.parse((polled.body as { data: unknown }).data).status).toBe(
        'SUCCEEDED',
      );
    });

    it('Aplicar apenas as seções vazias: 200, FILLED com revisão pendente, APPLIED, cabeçalho e itens intactos, auditoria e evento', async () => {
      const target = await background();
      const id = await proposal(target);
      const before = documentOf(target.documentId);
      const dfdBefore = dfdRepositoryOf(api)
        .snapshot()
        .find((row) => row.id === target.documentId);
      const itemsBefore = documentItemRepositoryOf(api)
        .snapshot()
        .filter((row) => row.documentId === target.documentId);

      const response = await apply(target.documentId, {
        generationId: id,
        sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = documentAiApplyResultSchema.parse((response.body as { data: unknown }).data);
      expect(result.appliedSectionKeys).toEqual(['JUSTIFICATION', 'EXPECTED_RESULTS']);
      expect(result.versionCreated).toBeNull();
      expect(response.headers.etag).toBe(`"${String(before.version + 1)}"`);

      const after = documentOf(target.documentId);
      for (const key of ['JUSTIFICATION', 'EXPECTED_RESULTS']) {
        expect(after.draftContent.sections[key]).toMatchObject({
          state: 'FILLED',
          ai: { generationId: id, appliedById: FAKE_USERS.ana.id, reviewedAt: null },
        });
      }
      expect(after.draftContent.sections.NOTES?.state).not.toBe('FILLED');
      expect(after.draftRevision).toBe(before.draftRevision + 1);
      expect(stored(id)).toMatchObject({
        status: 'APPLIED',
        appliedTargets: { sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'], riskIds: [] },
      });
      expect(
        dfdRepositoryOf(api)
          .snapshot()
          .find((row) => row.id === target.documentId),
      ).toEqual(dfdBefore);
      expect(
        documentItemRepositoryOf(api)
          .snapshot()
          .filter((row) => row.documentId === target.documentId),
      ).toEqual(itemsBefore);
      expect(documentRepositoryOf(api).versionsOf(target.documentId)).toHaveLength(0);

      const [audit] = auditOf('ai.content_apply', target.documentId);
      expect(audit?.metadata).toMatchObject({
        generationId: id,
        promptKey: 'draft.dfd',
        promptVersion: '1.0.0',
        model: 'fake-draft-1',
        replacedFilledSections: 0,
        versionCreated: null,
      });
      expect(audit?.changes).toMatchObject([
        { path: 'sections.JUSTIFICATION.ai.appliedAt', old: null },
        { path: 'sections.EXPECTED_RESULTS.ai.appliedAt', old: null },
      ]);
      expect(JSON.stringify(audit)).not.toContain('área requisitante necessita');
      const [event] = eventsOf(target.documentId, 'AiContentApplied');
      expect(event?.routingKey).toBe('document.ai_content_applied.dfd');
      expect(event?.payload).toEqual({
        generationId: id,
        documentId: target.documentId,
        documentTypeCode: 'DFD',
        targetModule: 'DFD',
        sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'],
        riskIds: [],
        replacedFilledSections: 0,
      });
      expect(
        timelineRowsOf(api).find(
          (row) => row.type === 'AI_CONTENT_APPLIED' && row.entityId === target.documentId,
        ),
      ).toMatchObject({ actorId: FAKE_USERS.ana.id });

      // Uma aplicação por geração: as seções não marcadas não ficam disponíveis depois.
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['NOTES'] }),
        409,
        'AI_GENERATION_NOT_APPLICABLE',
      );
    });

    it('Substituir seção preenchida cria antes a versão SYSTEM com o texto anterior', async () => {
      const target = await background();
      seedSection(
        target.documentId,
        'JUSTIFICATION',
        filledSection('Texto escrito por Rita', { revision: 3, updatedById: FAKE_USERS.ana.id }),
      );
      const id = await proposal(target);
      const response = await apply(target.documentId, {
        generationId: id,
        sectionKeys: ['JUSTIFICATION'],
        confirmReplaceFilled: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = documentAiApplyResultSchema.parse((response.body as { data: unknown }).data);
      const [version] = documentRepositoryOf(api).versionsOf(target.documentId);
      expect(result.versionCreated).toEqual({ id: version?.id, versionNumber: 1 });
      expect(version).toMatchObject({
        reason: 'SYSTEM',
        changeSummary: 'Antes de aplicar conteúdo gerado por IA',
      });
      expect(JSON.stringify(version?.content)).toContain('Texto escrito por Rita');
      expect(documentOf(target.documentId)).toMatchObject({ currentVersionNumber: 1 });
      expect(documentOf(target.documentId).draftContent.sections.JUSTIFICATION?.revision).toBe(4);
      expect(eventsOf(target.documentId, 'AiContentApplied')[0]?.payload).toMatchObject({
        replacedFilledSections: 1,
      });
      expect(eventsOf(target.documentId, 'DocumentVersionCreated')[0]?.payload).toMatchObject({
        reason: 'SYSTEM',
        versionNumber: 1,
      });
    });

    it('Descartar e substituir propostas (AI-04 · RN-AI-32)', async () => {
      const target = await background();
      const first = await proposal(target);
      const discarded = await discard(first);
      expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
      expect(stored(first)?.status).toBe('DISCARDED');
      expect(auditOf('ai.generation_discard', first)[0]?.metadata).toMatchObject({
        statusBefore: 'SUCCEEDED',
      });

      const second = await proposal(target);
      const third = await requested(target);
      expect(stored(second)?.status).toBe('DISCARDED');
      expect(stored(third)?.status).toBe('QUEUED');
      expect(auditOf('ai.generation_discard', second)[0]?.metadata).toMatchObject({
        reason: 'SUPERSEDED',
      });
    });

    it('Orçamento sigiloso e entradas faltantes: sem valor no contexto, avisos BUDGET_CONFIDENTIAL_VALUES_OMITTED e MISSING_OPTIONAL_INPUT', async () => {
      const target = await background({
        items: false,
        process: { isBudgetConfidential: true, estimatedValue: '987654.32' },
      });
      const dfds = dfdRepositoryOf(api);
      const dfd = dfds.snapshot().find((row) => row.id === target.documentId);
      if (dfd === undefined) throw new Error('DFD ausente');
      dfds.seed({ ...dfd, estimatedValue: '987654.32' });

      const id = await proposal(target);
      const sent = JSON.stringify(provider.calls[0]);
      expect(sent).not.toContain('987654');
      expect(sent).not.toContain('valorEstimado');
      expect(stored(id)?.output?.warnings).toEqual(
        expect.arrayContaining([
          { code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' },
          { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ITEMS' } },
          { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'EXPECTED_DATE' } },
        ]),
      );
    });

    it('Seção opcional sem base pode vir ausente (FA-08): a proposta lista só as obrigatórias', async () => {
      const target = await background();
      provider.enqueue({
        kind: 'output',
        output: {
          sections: ['JUSTIFICATION', 'EXPECTED_RESULTS'].map((sectionKey) => ({
            sectionKey,
            blocks: [{ type: 'paragraph', text: 'Texto proposto para a seção.' }],
          })),
        },
      });
      const id = await proposal(target);
      expect(stored(id)?.output?.sections.map((section) => section.sectionKey)).toEqual([
        'JUSTIFICATION',
        'EXPECTED_RESULTS',
      ]);
    });
  });

  describe('[Validação]', () => {
    it('Resumo fora do tamanho permitido: 422 VALIDATION_ERROR em needSummary e nenhuma geração', async () => {
      const target = await background({ items: false });
      const before = aiRepositoryOf(api).all().length;
      for (const needSummary of ['Computadores', 'x'.repeat(2_001)]) {
        const problem = expectProblem(
          await requestDraft(target, {
            body: {
              targetModule: 'DFD',
              kind: 'DRAFT',
              documentId: target.documentId,
              needSummary,
            },
          }),
          422,
          'VALIDATION_ERROR',
        );
        expect(JSON.stringify(problem)).toContain('needSummary');
      }
      const missing = expectProblem(
        await requestDraft(target, {
          body: { targetModule: 'DFD', kind: 'DRAFT', documentId: target.documentId },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(missing)).toContain('needSummary');
      expect(aiRepositoryOf(api).all()).toHaveLength(before);
    });

    it('DFD em aprovação → 409 DOCUMENT_NOT_EDITABLE; IA desligada → 403 AI_DISABLED', async () => {
      const target = await background({ items: false });
      const document = documentOf(target.documentId);
      documentRepositoryOf(api).seed({ ...document, status: 'IN_REVIEW' });
      expectProblem(await requestDraft(target), 409, 'DOCUMENT_NOT_EDITABLE');
      documentRepositoryOf(api).seed({ ...document, status: 'DRAFT' });
      gate.decision = { allowed: false, code: 'AI_DISABLED' };
      expectProblem(await requestDraft(target), 403, 'AI_DISABLED');
    });

    it('Substituição sem confirmação → 422 CONDITIONAL_REQUIRED; proposta vencida → 409 AI_GENERATION_NOT_APPLICABLE', async () => {
      const target = await background({ items: false });
      seedSection(target.documentId, 'JUSTIFICATION', filledSection('Texto de Rita'));
      const id = await proposal(target);
      const problem = expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['JUSTIFICATION'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(problem)).toContain('confirmReplaceFilled');
      expect(JSON.stringify(problem)).toContain('CONDITIONAL_REQUIRED');
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['OBJECT'] }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: [] }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['NOTES'] },
          { ifMatch: null },
        ),
        428,
        'PRECONDITION_REQUIRED',
      );

      const generation = stored(id);
      if (generation === undefined) throw new Error('geração ausente');
      aiRepositoryOf(api).seed({
        ...generation,
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 1_000),
      });
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['NOTES'] }),
        409,
        'AI_GENERATION_NOT_APPLICABLE',
      );
      expect(documentOf(target.documentId).draftContent.sections.NOTES?.state).not.toBe('FILLED');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem AI_GENERATE: 403 PERMISSION_DENIED e access.denied', async () => {
      const target = await background({ items: false });
      seedParticipant(api, {
        tenantId: A,
        processId: target.processId,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
      });
      const before = aiRepositoryOf(api).all().length;
      expectProblem(
        await requestDraft(target, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(aiRepositoryOf(api).all()).toHaveLength(before);
      expect(
        api
          .auditRecords()
          .some(
            (row) =>
              row.action === 'access.denied' &&
              row.actorUserId === FAKE_USERS.otavio.id &&
              row.reasonCode === 'AI_GENERATE',
          ),
      ).toBe(true);
    });

    it('Outro usuário com DFD_UPDATE tenta aplicar ou descartar: 403 AI_GENERATION_NOT_OWNED', async () => {
      const target = await background({ items: false });
      const id = await proposal(target);
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['JUSTIFICATION'] },
          { subject: 'sub-lucia' },
        ),
        403,
        'AI_GENERATION_NOT_OWNED',
      );
      expectProblem(await discard(id, 'sub-lucia'), 403, 'AI_GENERATION_NOT_OWNED');
      expect(stored(id)?.status).toBe('SUCCEEDED');
      // Quem tem PROCESS_VIEW consulta a proposta somente leitura (FA-06).
      const read = await auth(request(api.server).get(`/api/v1/ai-generations/${id}`), 'sub-lucia');
      expect(read.status).toBe(200);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Geração e DFD de outro tenant: 404 sem revelar nada', async () => {
      const own = await background({ items: false });
      const foreignProcess = await newProcess({}, 'sub-heitor', B);
      const foreignDfd = await createDfd(foreignProcess.id, 'sub-heitor', B);
      const foreign = requestGeneration({
        id: newId(),
        tenantId: B,
        processId: foreignProcess.id,
        documentId: foreignDfd.documentId,
        targetModule: 'DFD',
        kind: 'DRAFT',
        action: null,
        sectionKey: null,
        baseRevision: null,
        needSummary: SUMMARY,
        instruction: null,
        provider: 'fake',
        promptKey: 'draft.dfd',
        promptVersion: '1.0.0',
        reservedTokens: 15_000,
        createdById: FAKE_USERS.heitor.id,
        now: new Date(),
      });
      aiRepositoryOf(api).seed(foreign);

      const get = expectProblem(
        await auth(request(api.server).get(`/api/v1/ai-generations/${foreign.id}`)),
        404,
        'AI_GENERATION_NOT_FOUND',
      );
      expect(JSON.stringify(get)).not.toContain(foreignProcess.id);
      const crossed = expectProblem(
        await requestDraft({ processId: own.processId, documentId: foreignDfd.documentId }),
        404,
        'NOT_FOUND',
      );
      expect(JSON.stringify(crossed)).not.toContain(foreignProcess.id);
      expectProblem(
        await apply(
          foreignDfd.documentId,
          { generationId: foreign.id, sectionKeys: ['JUSTIFICATION'] },
          { ifMatch: '"1"' },
        ),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 202 + Idempotent-Replayed, uma geração e um job; dois cliques em "Aplicar" com a mesma chave aplicam uma vez', async () => {
      const target = await background({ items: false });
      const k1 = randomUUID();
      const first = await requestDraft(target, { key: k1 });
      expect(first.status).toBe(202);
      const replay = await requestDraft(target, { key: k1 });
      expect(replay.status).toBe(202);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const id = (first.body as { data: AiGenerationDto }).data.id;
      expect((replay.body as { data: AiGenerationDto }).data.id).toBe(id);
      expect(
        aiRepositoryOf(api)
          .all()
          .filter((row) => row.documentId === target.documentId),
      ).toHaveLength(1);
      expect(
        jobQueueOf(api)
          .all()
          .filter((job) => job.jobId === id),
      ).toHaveLength(1);

      await runAiJob(api, id);
      const ifMatch = `"${String(documentOf(target.documentId).version)}"`;
      const body = { generationId: id, sectionKeys: ['JUSTIFICATION'] };
      const k2 = randomUUID();
      const once = await apply(target.documentId, body, { key: k2, ifMatch });
      const twice = await apply(target.documentId, body, { key: k2, ifMatch });
      expect(once.status).toBe(200);
      expect(twice.status).toBe(200);
      expect(twice.headers['idempotent-replayed']).toBe('true');
      expect(auditOf('ai.content_apply', target.documentId)).toHaveLength(1);
      expect(eventsOf(target.documentId, 'AiContentApplied')).toHaveLength(1);
    });

    it('Segunda geração enquanto há uma ativa: 409 AI_GENERATION_IN_PROGRESS com meta.generationId', async () => {
      const target = await background({ items: false });
      const id = await requested(target);
      const generation = stored(id);
      if (generation === undefined) throw new Error('geração ausente');
      aiRepositoryOf(api).seed({ ...generation, status: 'RUNNING', attempts: 1 });
      const response = await requestDraft(target);
      expectProblem(response, 409, 'AI_GENERATION_IN_PROGRESS');
      expect(response.body).toMatchObject({ meta: { generationId: id } });
    });
  });

  describe('[Concorrência]', () => {
    it('DFD alterado entre abrir o painel e aplicar: 412 VERSION_CONFLICT e a geração continua SUCCEEDED', async () => {
      const target = await background({ items: false });
      const id = await proposal(target);
      const opened = documentOf(target.documentId).version;
      // Outra pessoa altera o documento (nova versão do ETag).
      documentRepositoryOf(api).seed({ ...documentOf(target.documentId), version: opened + 1 });
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['JUSTIFICATION'] },
          { ifMatch: `"${String(opened)}"` },
        ),
        412,
        'VERSION_CONFLICT',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');
      expect(auditOf('ai.content_apply', target.documentId)).toHaveLength(0);
    });

    it('Cancelamento durante a execução: CANCELED, resposta descartada e nenhuma seção alterada', async () => {
      settings.requestTimeoutMs = 30_000;
      onTestFinished(() => {
        settings.requestTimeoutMs = 5_000;
      });
      const target = await background({ items: false });
      const before = documentOf(target.documentId);
      const gateway = deferred();
      provider.enqueue({
        kind: 'wait',
        until: gateway.promise,
        then: {
          kind: 'output',
          output: {
            sections: NARRATIVE.map((sectionKey) => ({
              sectionKey,
              blocks: [{ type: 'paragraph', text: 'Texto que será descartado.' }],
            })),
          },
        },
      });
      const id = await requested(target);
      const running = runAiJob(api, id);
      await vi.waitFor(() => {
        expect(provider.calls).toHaveLength(1);
      });
      const canceled = await discard(id);
      expect((canceled.body as { data: AiGenerationDto }).data.status).toBe('CANCELED');
      gateway.release();
      await running;
      expect(stored(id)).toMatchObject({ status: 'CANCELED', output: null });
      expect(documentOf(target.documentId)).toEqual(before);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na aplicação: 503 DEPENDENCY_UNAVAILABLE, nenhuma seção alterada e a geração continua SUCCEEDED', async () => {
      const target = await background({ items: false });
      const id = await proposal(target);
      const before = documentOf(target.documentId);
      transactions.down = true;
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['JUSTIFICATION'] }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(documentOf(target.documentId)).toEqual(before);
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Falha de integração]', () => {
    it('Provedor indisponível em todas as tentativas: FAILED/PROVIDER_UNAVAILABLE após 3, evento e auditoria', async () => {
      const target = await background({ items: false });
      provider.enqueue(
        { kind: 'error', error: 'UNAVAILABLE' },
        { kind: 'error', error: 'UNAVAILABLE' },
        { kind: 'error', error: 'UNAVAILABLE' },
      );
      const id = await requested(target);
      const { error } = await runAiJobWithRetries(api, id);
      expect(error).toBeNull();
      expect(stored(id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'PROVIDER_UNAVAILABLE',
        attempts: 3,
      });
      // AI_GENERATION_FAILED é derivada deste evento pelo worker (ao solicitante).
      expect(eventsOf(id, 'AiGenerationFailed')[0]?.payload).toMatchObject({
        errorCode: 'PROVIDER_UNAVAILABLE',
        attempts: 3,
        requestedById: FAKE_USERS.ana.id,
      });
      expect(auditOf('ai.generation_fail', id)).toHaveLength(1);
      await api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE).recordSuccess();
    });

    it('Circuito aberto → 503 AI_PROVIDER_UNAVAILABLE com Retry-After; relay fora → aplicação 200 com AiContentApplied pendente no outbox', async () => {
      const target = await background({ items: false });
      const circuit = api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE);
      const id = await proposal(target);
      const now = Date.now();
      for (let failure = 0; failure < 5; failure += 1) await circuit.recordFailure(now);
      const blocked = await requestDraft(await background({ items: false }));
      expectProblem(blocked, 503, 'AI_PROVIDER_UNAVAILABLE');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      await circuit.recordSuccess();

      // Sem relay (modo em memória): o evento fica gravado no outbox até ser publicado.
      const applied = await apply(target.documentId, {
        generationId: id,
        sectionKeys: ['JUSTIFICATION'],
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(eventsOf(target.documentId, 'AiContentApplied')).toHaveLength(1);
    });
  });
});

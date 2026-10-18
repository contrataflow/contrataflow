import { randomUUID } from 'node:crypto';

import {
  aiGenerationSchema,
  applyAiRisksResultSchema,
  dfdSchema,
  documentSchema,
  problemDetailsSchema,
  reviewAiRisksResultSchema,
  riskSchema,
} from '@contrataflow/validation';
import type {
  AiGenerationDto,
  ApplyAiRisksResultDto,
  DfdDto,
  DocumentDto,
  ProcessDto,
  RiskDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import type { AiCircuitStorePort } from '#shared/ai/ai-circuit-store.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import {
  RISK_TRANSACTIONS,
  TestAiGate,
  aiRepositoryOf,
  jobQueueOf,
  riskRepositoryOf,
  runAiJob,
  runAiJobWithRetries,
  seedRisk,
} from '../../../../test/support/ai-fixtures.js';
import type { RiskTransactions } from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { documentRepositoryOf } from '../../../../test/support/document-fixtures.js';
import {
  PROCESS_PREREQUISITE_SEEDERS,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
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
 * US-119 — Gerar a proposta do mapa de riscos com IA (AI-01 → job `ai-generation` → AI-02 → RSK-11
 * / DOC-26 → RSK-12 → DOC-08/10) pelo pipeline HTTP completo, com o gerador REAL `draft.risk_map`
 * (contexto pelas fachadas de `document`, `process`, `risk`, `catalog` e `tenancy`), o
 * `FakeAiProvider` com a fixture `draft.risk_map/padrao` (6 riscos × 2 tratamentos — nenhuma
 * chamada real) e os adaptadores em memória. O portão do órgão é o de teste (US-116 tem a suíte
 * própria). Notificações `AI_GENERATION_READY/FAILED`: derivadas pelo worker dos eventos
 * `AiGenerationCompleted/Failed` — aqui conferimos o evento. Atomicidade, RLS e corrida em
 * PostgreSQL: `test/tenant-leak/ai-risk-map-draft.spec.ts`.
 *
 * Personas: "Carla" (PLANEJAMENTO com AI_GENERATE, RISK_MANAGE e custódia) = Ana (REQUISITANTE +
 * GESTOR_CONTRATACOES); "Bruno" (RISK_MANAGE sem AI_GENERATE) = Otávio (SOMENTE_LEITURA +
 * participação COLLABORATOR); "Marta" (RISK_MANAGE, não é a solicitante) = Lúcia (COLLABORATOR);
 * "Prefeitura B" = Heitor.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const UNITS_A = {
  organizationId: '0192d119-0000-7000-8000-0000000000a0',
  obras: '0192d119-0000-7000-8000-0000000000a1',
  manutencao: '0192d119-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d119-0000-7000-8000-0000000000a3',
  saude: '0192d119-0000-7000-8000-0000000000a4',
  posto: '0192d119-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d119-0000-7000-8000-0000000000b0',
  obras: '0192d119-0000-7000-8000-0000000000b1',
  manutencao: '0192d119-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d119-0000-7000-8000-0000000000b3',
  saude: '0192d119-0000-7000-8000-0000000000b4',
  posto: '0192d119-0000-7000-8000-0000000000b5',
};
const FOREIGN_TITLE = 'Risco exclusivo da Prefeitura B';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do `risk` que simulam o banco fora do ar (Falha de banco no RSK-11). */
class FlakyRiskTransactions implements RiskTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
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

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Risco como o provedor de teste o devolve (sem chaves da proposta). */
const providerRisk = (fields: Record<string, unknown> = {}) => ({
  title: 'Atraso na entrega dos equipamentos',
  description: 'O fornecedor pode atrasar a entrega prevista.',
  categoryCode: 'PRAZO',
  phase: 'CONTRACT_MANAGEMENT',
  cause: 'Dificuldade logística do fornecedor contratado.',
  consequence: 'Interrupção das aulas nos laboratórios.',
  probability: 2,
  impact: 2,
  rationale: 'Mercado regional restrito.',
  treatments: [
    { type: 'PREVENTIVE', description: 'Definir marcos de acompanhamento da entrega.' },
    { type: 'CONTINGENCY', description: 'Aplicar as sanções e acionar o segundo colocado.' },
  ],
  ...fields,
});

const NARRATIVE_OUTPUT = ['INTRODUCTION', 'METHODOLOGY'].map((sectionKey) => ({
  sectionKey,
  blocks: [{ type: 'paragraph', text: `Texto proposto para ${sectionKey} do mapa de riscos.` }],
}));

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

interface Target {
  readonly processId: string;
  readonly dfdId: string | null;
  readonly riskMap: DocumentDto | null;
  readonly manual: RiskDto | null;
}

describe('Feature: Gerar a proposta do mapa de riscos com IA (US-119)', () => {
  let api: TestApi;
  const provider = new FakeAiProvider(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR));
  const riskTransactions = new FlakyRiskTransactions();
  const gate = new TestAiGate();
  const settings: { -readonly [K in keyof AiSettings]: AiSettings[K] } = {
    provider: 'fake',
    models: { draft: 'fake-draft-1', section: 'fake-section-1' },
    requestTimeoutMs: 5_000,
    maxAttempts: 3,
    backoffBaseMs: 10_000,
    maxContextChars: 240_000,
  };
  let catalog: { contractingType: string; origin: string; market: string };
  const words = () => randomUUID().replaceAll('-', '').slice(0, 10);

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const stored = (id: string) =>
    aiRepositoryOf(api)
      .all()
      .find((row) => row.id === id);
  const riskStore = () => riskRepositoryOf(api);
  const risksOf = (processId: string) =>
    riskStore()
      .snapshot()
      .filter((risk) => risk.processId === processId && risk.deletedAt === null);
  const treatmentsOf = (processId: string) =>
    riskStore()
      .treatmentRows()
      .filter((row) => row.processId === processId);
  const auditOf = (action: string, processId?: string) =>
    api
      .auditRecords()
      .filter(
        (row) => row.action === action && (processId === undefined || row.processId === processId),
      );
  const eventsOf = (eventType: string, processId?: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.eventType === eventType && (processId === undefined || row.processId === processId),
      );
  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };

  /** Processo aberto por Ana (custódia). */
  async function newProcess(subject = 'sub-ana', tenant: string = A): Promise<Process> {
    const units = tenant === A ? UNITS_A : UNITS_B;
    const response = await auth(request(api.server).post('/api/v1/processes'), subject, tenant)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Computadores ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, tenant, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: units.obras,
        requestingDepartmentId: units.manutencao,
        originId: catalogItemId(api, tenant, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        priority: 'HIGH',
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    return created;
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
    return dfdSchema.parse(data<DfdDto>(response));
  }

  /** O processo vai à etapa "ETP e mapa de riscos", em andamento (riscos editáveis). */
  function toRiskStage(process: Process, tenant: string = A): void {
    const stage = workflowStagesOf(api, tenant).find(
      (candidate) =>
        candidate.key === 'ESTUDOS_PRELIMINARES' &&
        candidate.workflowVersionId === process.workflowVersionId,
    );
    processRepositoryOf(api).replace({
      ...process,
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stage?.id ?? process.currentWorkflowStageId,
    });
  }

  async function addRisk(processId: string, title = 'Fornecedores insuficientes') {
    const response = await auth(request(api.server).post(`/api/v1/processes/${processId}/risks`))
      .set('Idempotency-Key', randomUUID())
      .send({
        title,
        categoryId: catalog.market,
        phase: 'PLANNING',
        cause: 'Mercado local com poucos fornecedores habilitados',
        consequence: 'Licitação deserta e atraso na contratação',
        probability: 1,
        impact: 1,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return riskSchema.parse(data<RiskDto>(response));
  }

  async function emitRiskMap(processId: string): Promise<DocumentDto> {
    const response = await auth(request(api.server).post(`/api/v1/processes/${processId}/risk-map`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return documentSchema.parse(data<DocumentDto>(response));
  }

  /**
   * Background: processo "0012/2026" com DFD e nenhum risco; Lúcia colaboradora. Com `riskMap`, um
   * risco manual (R01) e o `RISK_MAP` emitido em DRAFT.
   */
  async function background(options: { dfd?: boolean; riskMap?: boolean } = {}): Promise<Target> {
    const process = await newProcess();
    const dfd = options.dfd === false ? null : await createDfd(process.id);
    toRiskStage(process);
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.lucia.id,
      role: 'COLLABORATOR',
    });
    if (options.riskMap !== true) {
      return { processId: process.id, dfdId: dfd?.documentId ?? null, riskMap: null, manual: null };
    }
    const manual = await addRisk(process.id);
    const riskMap = await emitRiskMap(process.id);
    return { processId: process.id, dfdId: dfd?.documentId ?? null, riskMap, manual };
  }

  const requestProposal = (
    target: Target,
    options: { subject?: string; key?: string; body?: object } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
      options.subject,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(
        options.body ?? {
          targetModule: 'RISK_MAP',
          kind: 'DRAFT',
          ...(target.riskMap === null ? {} : { documentId: target.riskMap.id }),
        },
      );

  async function requested(target: Target): Promise<string> {
    const response = await requestProposal(target);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return data<AiGenerationDto>(response).id;
  }

  /** Proposta `SUCCEEDED` de Ana para o processo. */
  async function proposal(target: Target): Promise<string> {
    const id = await requested(target);
    await expect(runAiJob(api, id)).resolves.toBe('completed');
    expect(stored(id)?.status, JSON.stringify(stored(id)?.errorCode)).toBe('SUCCEEDED');
    return id;
  }

  const applyRisks = (
    processId: string,
    body: Record<string, unknown>,
    options: { subject?: string; key?: string } = {},
  ) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/risks/ai-apply`), options.subject)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);

  const reviewRisks = (processId: string, risks: readonly { id: string; version: number }[]) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/risks/ai-review`)).send({
      riskIds: risks.map((risk) => risk.id),
      expectedVersions: Object.fromEntries(risks.map((risk) => [risk.id, risk.version])),
    });

  /** R1..R4 da fixture com 7 tratamentos (R4 só com o primeiro). */
  const FOUR_WITH_SEVEN = [
    { proposalKey: 'R1', treatments: ['R1.T1', 'R1.T2'] },
    { proposalKey: 'R2', treatments: ['R2.T1', 'R2.T2'] },
    { proposalKey: 'R3', treatments: ['R3.T1', 'R3.T2'] },
    { proposalKey: 'R4', treatments: ['R4.T1'] },
  ];

  async function appliedOk(processId: string, body: Record<string, unknown>) {
    const response = await applyRisks(processId, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return applyAiRisksResultSchema.parse(data<ApplyAiRisksResultDto>(response)).risks;
  }

  async function fillNarrative(documentId: string): Promise<void> {
    for (const key of ['INTRODUCTION', 'METHODOLOGY']) {
      const response = await auth(
        request(api.server).put(`/api/v1/documents/${documentId}/sections/${key}`),
      )
        .set('If-Match', '"s1"')
        .send({
          content: paragraph(`Texto da seção ${key} do mapa de riscos da contratação.`),
          notApplicable: false,
          justification: null,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
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
        { token: RISK_TRANSACTIONS, value: riskTransactions },
      ],
    });
    for (const tenant of [A, B]) {
      await runTenantSeeders(api, tenant, [
        ...PROCESS_PREREQUISITE_SEEDERS,
        'document.templateLibrary',
      ]);
    }
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.ana.id),
      roleId: roles.get('GESTOR_CONTRATACOES')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      market: catalogItemId(api, A, 'RISK_CATEGORY', 'MERCADO_FORNECEDOR'),
    };
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
    riskTransactions.down = false;
    jobQueueOf(api).down = false;
    gate.decision = { allowed: true };
  });

  describe('[Sucesso]', () => {
    it('Gerar a proposta sem criar riscos: 202 QUEUED + Location, auditoria e evento; o job conclui SUCCEEDED com 6 riscos', async () => {
      const target = await background();
      const response = await requestProposal(target);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const generation = aiGenerationSchema.parse(data<AiGenerationDto>(response));
      expect(generation).toMatchObject({
        status: 'QUEUED',
        targetModule: 'RISK_MAP',
        kind: 'DRAFT',
        documentId: null,
        promptKey: 'draft.risk_map',
        promptVersion: '1.0.0',
      });
      expect(response.headers.location).toBe(`/api/v1/ai-generations/${generation.id}`);
      expect(stored(generation.id)).toMatchObject({ status: 'QUEUED', reservedTokens: 25_000 });
      expect(auditOf('ai.generation_request', target.processId)).toHaveLength(1);
      expect(
        eventsOf('AiGenerationRequested').filter((row) => row.aggregateId === generation.id),
      ).toHaveLength(1);
      expect(provider.calls).toHaveLength(0);

      await expect(runAiJob(api, generation.id)).resolves.toBe('completed');
      const done = stored(generation.id);
      expect(done?.status).toBe('SUCCEEDED');
      expect(done?.output?.risks).toHaveLength(6);
      expect(done?.output?.risks?.[0]).toMatchObject({
        proposalKey: 'R1',
        categoryCode: 'PLANEJAMENTO',
        treatments: [{ proposalKey: 'R1.T1' }, { proposalKey: 'R1.T2' }],
      });
      // Mapa ainda não emitido: só riscos (FA-03 · RN-AI-41).
      expect(done?.output?.sections).toEqual([]);
      expect(done?.output?.warnings).toEqual(
        expect.arrayContaining([
          { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ETP' } },
          { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'TERM_OF_REFERENCE' } },
          { code: 'USED_DRAFT_INPUTS', params: { input: 'DFD' } },
        ]),
      );
      expect(done?.inputRefs.map((ref) => ref.kind)).toEqual(
        expect.arrayContaining(['PROCESS', 'CATALOG', 'DOCUMENT_DRAFT', 'RISKS']),
      );
      // AI_GENERATION_READY é derivada deste evento pelo worker (ao solicitante).
      expect(
        eventsOf('AiGenerationCompleted').find((row) => row.aggregateId === generation.id)?.payload,
      ).toMatchObject({ requestedById: FAKE_USERS.ana.id });
      expect(risksOf(target.processId)).toHaveLength(0);
      expect(treatmentsOf(target.processId)).toHaveLength(0);
    });

    it('Aplicar seletivamente 4 riscos com 7 tratamentos: 201, R01–R04 gerados por IA, PLANNED sem responsável, eventos e auditoria', async () => {
      const target = await background();
      const id = await proposal(target);
      const risks = await appliedOk(target.processId, { generationId: id, risks: FOUR_WITH_SEVEN });
      expect(risks.map((risk) => [risk.code, risk.level, risk.score])).toEqual([
        ['R01', 'HIGH', 12],
        ['R02', 'MEDIUM', 9],
        ['R03', 'MEDIUM', 8],
        ['R04', 'MEDIUM', 6],
      ]);
      for (const risk of risks) {
        expect(risk).toMatchObject({
          aiGenerationId: id,
          aiReviewedAt: null,
          aiReviewedBy: null,
          ownerId: null,
          status: 'IN_TREATMENT',
        });
        for (const treatment of risk.treatments) {
          expect(treatment).toMatchObject({
            status: 'PLANNED',
            responsibleId: null,
            responsibleDepartmentId: null,
            dueDate: null,
          });
        }
      }
      expect(risks.flatMap((risk) => risk.treatments)).toHaveLength(7);
      expect(eventsOf('RiskCreated', target.processId)).toHaveLength(4);
      expect(eventsOf('RiskTreatmentChanged', target.processId)).toHaveLength(7);
      const [applied] = eventsOf('AiContentApplied', target.processId);
      expect(applied?.routingKey).toBe('document.ai_content_applied.risk_map');
      expect(applied?.payload).toMatchObject({
        generationId: id,
        documentId: null,
        targetModule: 'RISK_MAP',
        riskIds: risks.map((risk) => risk.id),
        sectionKeys: [],
      });
      expect(auditOf('risk.create', target.processId)).toHaveLength(4);
      expect(auditOf('risk.treatment_create', target.processId)).toHaveLength(7);
      const [contentApply] = auditOf('ai.content_apply', target.processId);
      expect(contentApply?.metadata).toMatchObject({
        generationId: id,
        riskIds: risks.map((risk) => risk.id),
        promptKey: 'draft.risk_map',
      });
      expect(stored(id)).toMatchObject({
        status: 'APPLIED',
        appliedTargets: { sectionKeys: [], riskIds: risks.map((risk) => risk.id) },
      });
      expect(
        timelineRowsOf(api).some(
          (row) => row.type === 'AI_CONTENT_APPLIED' && row.processId === target.processId,
        ),
      ).toBe(true);
      // Nunca o texto proposto na auditoria.
      expect(JSON.stringify(auditOf('ai.content_apply', target.processId))).not.toContain(
        'Especificação técnica insuficiente',
      );
    });

    it('Mapa emitido: aplicar INTRODUCTION pelo DOC-26 (proveniência ai), depois os riscos e revisar R02/R03', async () => {
      const target = await background({ riskMap: true });
      const riskMap = target.riskMap;
      if (riskMap === null) throw new Error('mapa ausente');
      const id = await proposal(target);
      expect(stored(id)?.output?.sections.map((section) => section.sectionKey)).toEqual([
        'INTRODUCTION',
        'METHODOLOGY',
        'NOTES',
      ]);

      const section = await auth(
        request(api.server).post(`/api/v1/documents/${riskMap.id}/ai-apply`),
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${String(documentOf(riskMap.id).version)}"`)
        .send({ generationId: id, sectionKeys: ['INTRODUCTION'] });
      expect(section.status, JSON.stringify(section.body)).toBe(200);
      const introduction = documentOf(riskMap.id).draftContent.sections.INTRODUCTION;
      expect(introduction).toMatchObject({
        state: 'FILLED',
        ai: { generationId: id, reviewedAt: null },
      });

      // A outra parte da proposta (riscos) ainda é aceita (`appliedTargets` acumula).
      const risks = await appliedOk(target.processId, {
        generationId: id,
        risks: [
          { proposalKey: 'R1', treatments: ['R1.T1'] },
          { proposalKey: 'R2', treatments: ['R2.T1'] },
        ],
      });
      expect(risks.map((risk) => risk.code)).toEqual(['R02', 'R03']);
      expect(stored(id)?.appliedTargets).toEqual({
        sectionKeys: ['INTRODUCTION'],
        riskIds: risks.map((risk) => risk.id),
      });

      const reviewed = await reviewRisks(target.processId, risks);
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      const result = reviewAiRisksResultSchema.parse(data(reviewed));
      expect(result.reviewedRiskIds).toEqual(risks.map((risk) => risk.id));
      for (const risk of result.risks) {
        expect(risk.aiReviewedAt).not.toBeNull();
        expect(risk.aiReviewedBy?.id).toBe(FAKE_USERS.ana.id);
      }
      const [event] = eventsOf('AiContentReviewed', target.processId);
      expect(event?.routingKey).toBe('document.ai_content_reviewed.risk_map');
      expect(event?.payload).toMatchObject({
        documentId: riskMap.id,
        riskIds: risks.map((risk) => risk.id),
        generationIds: [id],
      });
      expect(auditOf('ai.content_review', target.processId)).toHaveLength(1);
      // Idempotente: revisar de novo não muda nada.
      const again = await reviewRisks(target.processId, result.risks);
      expect(reviewAiRisksResultSchema.parse(data(again)).reviewedRiskIds).toEqual([]);
      expect(auditOf('ai.content_review', target.processId)).toHaveLength(1);
    });
  });

  describe('[Validação]', () => {
    it('Processo sem DFD: 422 AI_PREREQUISITE_MISSING com meta.missing = DFD e nenhuma geração', async () => {
      const target = await background({ dfd: false });
      const before = aiRepositoryOf(api).all().length;
      const response = await requestProposal(target);
      expectProblem(response, 422, 'AI_PREREQUISITE_MISSING');
      expect(response.body).toMatchObject({ meta: { missing: ['DFD'] } });
      expect(aiRepositoryOf(api).all()).toHaveLength(before);
    });

    it('Orientações acima de 2.000 caracteres ou campos de SECTION: 422 VALIDATION_ERROR', async () => {
      const target = await background();
      expectProblem(
        await requestProposal(target, {
          body: { targetModule: 'RISK_MAP', kind: 'DRAFT', needSummary: 'a'.repeat(2_001) },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await requestProposal(target, {
          body: { targetModule: 'RISK_MAP', kind: 'DRAFT', sectionKey: 'INTRODUCTION' },
        }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('Categoria desconhecida vira OUTRO, seleção vazia é recusada e a conclusão fica bloqueada por revisão e "[a confirmar"', async () => {
      const target = await background({ riskMap: true });
      const riskMap = target.riskMap;
      if (riskMap === null) throw new Error('mapa ausente');
      provider.enqueue({
        kind: 'output',
        output: {
          sections: NARRATIVE_OUTPUT,
          risks: [
            providerRisk({ categoryCode: 'INEXISTENTE' }),
            providerRisk({
              title: 'Especificação incompleta',
              cause: 'Requisitos com [a confirmar: prazo] de levantamento.',
            }),
          ],
        },
      });
      const id = await proposal(target);
      expect(stored(id)?.output?.risks?.map((risk) => risk.categoryCode)).toEqual([
        'OUTRO',
        'PRAZO',
      ]);

      expectProblem(
        await applyRisks(target.processId, { generationId: id, risks: [] }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await applyRisks(target.processId, {
          generationId: id,
          risks: [{ proposalKey: 'R9', treatments: [] }],
        }),
        422,
        'VALIDATION_ERROR',
      );
      const [unreviewed, placeholder] = await appliedOk(target.processId, {
        generationId: id,
        risks: [
          { proposalKey: 'R1', treatments: ['R1.T1'] },
          { proposalKey: 'R2', treatments: ['R2.T1'] },
        ],
      });
      if (unreviewed === undefined || placeholder === undefined) throw new Error('riscos ausentes');
      expect(unreviewed.category.code).toBe('OUTRO');
      const review = await reviewRisks(target.processId, [placeholder]);
      expect(review.status, JSON.stringify(review.body)).toBe(200);
      await fillNarrative(riskMap.id);

      const finalize = await auth(
        request(api.server).post(`/api/v1/documents/${riskMap.id}/finalize`),
      )
        .set('If-Match', `"${String(documentOf(riskMap.id).version)}"`)
        .set('Idempotency-Key', randomUUID())
        .send({});
      const problem = expectProblem(finalize, 422, 'DOCUMENT_INCOMPLETE');
      expect(problem.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'RISK_AI_REVIEW_PENDING', itemId: unreviewed.id }),
          expect.objectContaining({ code: 'RISK_PLACEHOLDER_PENDING', itemId: placeholder.id }),
        ]),
      );
      const validation = await auth(
        request(api.server).get(`/api/v1/documents/${riskMap.id}/validation`),
      );
      expect(
        data<{ violations: { code: string }[] }>(validation).violations.map((item) => item.code),
      ).toEqual(expect.arrayContaining(['RISK_AI_REVIEW_PENDING', 'RISK_PLACEHOLDER_PENDING']));
      expect(documentOf(riskMap.id).status).toBe('DRAFT');
    });

    it('Mapa concluído (FA-05): AI-01 e RSK-11 respondem 409 DOCUMENT_NOT_EDITABLE', async () => {
      const target = await background({ riskMap: true });
      const riskMap = target.riskMap;
      if (riskMap === null) throw new Error('mapa ausente');
      const id = await proposal(target);
      documentRepositoryOf(api).seed({ ...documentOf(riskMap.id), status: 'FINALIZED' });
      expectProblem(await requestProposal(target), 409, 'DOCUMENT_NOT_EDITABLE');
      expectProblem(
        await applyRisks(target.processId, {
          generationId: id,
          risks: [{ proposalKey: 'R1', treatments: [] }],
        }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem AI_GENERATE: 403 PERMISSION_DENIED e access.denied; outro usuário com RISK_MANAGE aplicando: 403 AI_GENERATION_NOT_OWNED', async () => {
      const target = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: target.processId,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
      });
      const before = aiRepositoryOf(api).all().length;
      expectProblem(
        await requestProposal(target, { subject: 'sub-otavio' }),
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

      const id = await proposal(target);
      expectProblem(
        await applyRisks(
          target.processId,
          { generationId: id, risks: [{ proposalKey: 'R1', treatments: [] }] },
          { subject: 'sub-lucia' },
        ),
        403,
        'AI_GENERATION_NOT_OWNED',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');
      expect(risksOf(target.processId)).toHaveLength(0);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Proposta de outro tenant: 404 AI_GENERATION_NOT_FOUND; o contexto não leva riscos nem textos da Prefeitura B', async () => {
      const own = await background();
      const foreignProcess = await newProcess('sub-heitor', B);
      await seedRisk(
        api,
        {
          title: FOREIGN_TITLE,
          description: null,
          categoryId: catalogItemId(api, B, 'RISK_CATEGORY', 'PRAZO'),
          phase: 'PLANNING',
          cause: 'Causa sigilosa do outro tenant.',
          consequence: 'Consequência sigilosa do outro tenant.',
          probability: 2,
          impact: 2,
          ownerId: null,
          ownerDepartmentId: null,
        },
        {
          id: newId(),
          tenantId: B,
          processId: foreignProcess.id,
          code: 'R01',
          snapshot: {
            scale: { max: 5, probabilityLabels: [], impactLabels: [] },
            levelThresholds: [{ level: 'LOW', minScore: 1, maxScore: 25 }],
          },
          now: new Date(),
          userId: null,
        },
      );
      const foreign = requestGeneration({
        id: newId(),
        tenantId: B,
        processId: foreignProcess.id,
        documentId: null,
        targetModule: 'RISK_MAP',
        kind: 'DRAFT',
        action: null,
        sectionKey: null,
        baseRevision: null,
        needSummary: null,
        instruction: null,
        provider: 'fake',
        promptKey: 'draft.risk_map',
        promptVersion: '1.0.0',
        reservedTokens: 25_000,
        createdById: FAKE_USERS.heitor.id,
        now: new Date(),
      });
      aiRepositoryOf(api).seed(foreign);

      const problem = expectProblem(
        await applyRisks(own.processId, {
          generationId: foreign.id,
          risks: [{ proposalKey: 'R1', treatments: [] }],
        }),
        404,
        'AI_GENERATION_NOT_FOUND',
      );
      expect(JSON.stringify(problem)).not.toContain(foreignProcess.id);

      await proposal(own);
      const sent = JSON.stringify(provider.calls);
      expect(sent).not.toContain(FOREIGN_TITLE);
      expect(sent).not.toContain(foreignProcess.title);
      expect(sent).not.toContain('Causa sigilosa');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 201 + Idempotent-Replayed sem duplicar; outra chave: 409 AI_GENERATION_NOT_APPLICABLE', async () => {
      const target = await background();
      const id = await proposal(target);
      const body = { generationId: id, risks: [{ proposalKey: 'R1', treatments: ['R1.T1'] }] };
      const k1 = randomUUID();
      const first = await applyRisks(target.processId, body, { key: k1 });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const replay = await applyRisks(target.processId, body, { key: k1 });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(risksOf(target.processId)).toHaveLength(1);
      expectProblem(
        await applyRisks(target.processId, body, { key: randomUUID() }),
        409,
        'AI_GENERATION_NOT_APPLICABLE',
      );
      expect(risksOf(target.processId)).toHaveLength(1);
      expect(auditOf('ai.content_apply', target.processId)).toHaveLength(1);
    });

    it('Risco parecido com um existente: similarToRiskId aponta o risco registrado', async () => {
      const target = await background({ riskMap: true });
      const manual = target.manual;
      if (manual === null) throw new Error('risco manual ausente');
      provider.enqueue({
        kind: 'output',
        output: {
          sections: NARRATIVE_OUTPUT,
          risks: [
            providerRisk({ similarToRiskCode: 'R01' }),
            providerRisk({ title: 'Outro risco' }),
          ],
        },
      });
      const id = await proposal(target);
      expect(stored(id)?.output?.risks?.map((risk) => risk.similarToRiskId)).toEqual([
        manual.id,
        undefined,
      ]);
      // O contexto levou os riscos já registrados (sem ids — o código identifica o risco).
      expect(JSON.stringify(provider.calls)).toContain('Fornecedores insuficientes');
    });
  });

  describe('[Concorrência]', () => {
    it('Duas aplicações simultâneas: exatamente uma 201 e outra 409; códigos sequenciais sem repetição', async () => {
      const target = await background();
      const id = await proposal(target);
      const body = { generationId: id, risks: FOUR_WITH_SEVEN };
      const responses = await Promise.all([
        applyRisks(target.processId, body),
        applyRisks(target.processId, body),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const conflict = responses.find((response) => response.status === 409);
      expect(conflict?.body).toMatchObject({ code: 'AI_GENERATION_NOT_APPLICABLE' });
      expect(
        risksOf(target.processId)
          .map((risk) => risk.code)
          .sort(),
      ).toEqual(['R01', 'R02', 'R03', 'R04']);
    });

    it('Revisão com versão antiga: 412 VERSION_CONFLICT e o risco não é marcado como revisado', async () => {
      const target = await background();
      const id = await proposal(target);
      const [r01] = await appliedOk(target.processId, {
        generationId: id,
        risks: [{ proposalKey: 'R1', treatments: [] }],
      });
      if (r01 === undefined) throw new Error('risco ausente');
      const edited = await auth(request(api.server).patch(`/api/v1/risks/${r01.id}`))
        .set('If-Match', `"${String(r01.version)}"`)
        .send({ title: 'Especificação técnica revisada pela equipe' });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const response = await reviewRisks(target.processId, [r01]);
      expectProblem(response, 412, 'VERSION_CONFLICT');
      expect(response.body).toMatchObject({ meta: { current: { [r01.id]: r01.version + 1 } } });
      expect(risksOf(target.processId)[0]?.aiReviewedAt).toBeNull();
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível no RSK-11: 503 DEPENDENCY_UNAVAILABLE, nada criado e a geração continua SUCCEEDED', async () => {
      const target = await background();
      const id = await proposal(target);
      riskTransactions.down = true;
      expectProblem(
        await applyRisks(target.processId, { generationId: id, risks: FOUR_WITH_SEVEN }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      riskTransactions.down = false;
      expect(risksOf(target.processId)).toHaveLength(0);
      expect(treatmentsOf(target.processId)).toHaveLength(0);
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Falha de integração]', () => {
    it('Provedor com 503 nas 3 tentativas: FAILED/PROVIDER_UNAVAILABLE e AiGenerationFailed', async () => {
      const target = await background();
      provider.enqueue(
        { kind: 'error', error: 'UNAVAILABLE' },
        { kind: 'error', error: 'UNAVAILABLE' },
        { kind: 'error', error: 'UNAVAILABLE' },
      );
      const id = await requested(target);
      const { error } = await runAiJobWithRetries(api, id);
      expect(error).toBeNull();
      expect(stored(id)).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_UNAVAILABLE' });
      // AI_GENERATION_FAILED é derivada deste evento pelo worker (ao solicitante).
      expect(
        eventsOf('AiGenerationFailed').find((row) => row.aggregateId === id)?.payload,
      ).toMatchObject({ errorCode: 'PROVIDER_UNAVAILABLE', requestedById: FAKE_USERS.ana.id });
      await api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE).recordSuccess();
    });

    it('Probabilidade 7 numa escala de 1 a 5 mesmo após o reparo: FAILED/OUTPUT_INVALID sem proposta', async () => {
      const target = await background();
      const invalid = {
        kind: 'output' as const,
        output: { sections: [], risks: [providerRisk({ probability: 7 })] },
      };
      provider.enqueue(invalid, invalid);
      const id = await requested(target);
      await runAiJob(api, id);
      expect(stored(id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'OUTPUT_INVALID',
        output: null,
      });
      expect(provider.calls).toHaveLength(2);
    });

    it('Circuito aberto: 503 AI_PROVIDER_UNAVAILABLE com Retry-After', async () => {
      const target = await background();
      const circuit = api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE);
      const now = Date.now();
      for (let failure = 0; failure < 5; failure += 1) await circuit.recordFailure(now);
      const blocked = await requestProposal(target);
      expectProblem(blocked, 503, 'AI_PROVIDER_UNAVAILABLE');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      await circuit.recordSuccess();
    });
  });
});

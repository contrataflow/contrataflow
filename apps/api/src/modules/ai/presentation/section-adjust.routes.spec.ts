import { randomUUID } from 'node:crypto';

import type { AiTargetModule } from '@contrataflow/types';
import {
  aiGenerationSchema,
  documentAiApplyResultSchema,
  documentSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { AiGenerationDto, DfdDto, DocumentDto, ProcessDto } from '@contrataflow/validation';
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
  TestAiGate,
  aiRepositoryOf,
  jobQueueOf,
  runAiJob,
  runAiJobWithRetries,
} from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  DOCUMENT_TRANSACTIONS,
  documentRepositoryOf,
  filledSection,
  openStageForAnyType,
} from '../../../../test/support/document-fixtures.js';
import type { DocumentTransactions } from '../../../../test/support/document-fixtures.js';
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
  seedCustomRole,
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
 * US-121 — Ajustar seção com IA (AI-01 `SECTION` → job `ai-generation` → AI-02 → DOC-26 →
 * "Desfazer" pelo DOC-05) pelo pipeline HTTP completo, com o gerador REAL `SectionAdjustGenerator`
 * dos quatro documentos (contexto pelas fachadas de `document`, `process`, `catalog` e `tenancy`),
 * o `FakeAiProvider` (sem fixture para `section.*`: resposta genérica com "[a confirmar]"; os
 * cenários roteirizam a saída) e os adaptadores em memória. O portão do órgão é o de teste (US-116
 * tem a suíte própria). Atomicidade e RLS em PostgreSQL: `test/tenant-leak/ai-section-adjust.spec.ts`.
 *
 * Personas: "Carla" (REQUISITANTE + GESTOR_CONTRATACOES, AI_GENERATE e custódia) = Ana; "Bruno"
 * (ETP_UPDATE por participação, sem AI_GENERATE) = Otávio; "Marta" (AI_GENERATE + ETP_UPDATE por
 * participação, não é a solicitante) = Lúcia; "Prefeitura B" = Heitor.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const UNITS_A = {
  organizationId: '0192d121-0000-7000-8000-0000000000a0',
  obras: '0192d121-0000-7000-8000-0000000000a1',
  manutencao: '0192d121-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d121-0000-7000-8000-0000000000a3',
  saude: '0192d121-0000-7000-8000-0000000000a4',
  posto: '0192d121-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d121-0000-7000-8000-0000000000b0',
  obras: '0192d121-0000-7000-8000-0000000000b1',
  manutencao: '0192d121-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d121-0000-7000-8000-0000000000b3',
  saude: '0192d121-0000-7000-8000-0000000000b4',
  posto: '0192d121-0000-7000-8000-0000000000b5',
};

/** Texto de 400 caracteres da "NEED_DESCRIPTION" (Background). */
const NEED_TEXT = (
  'A Secretaria de Educação precisa substituir os computadores dos laboratórios das escolas ' +
  'municipais, que operam com equipamentos obsoletos, sem suporte do fabricante e com falhas ' +
  'frequentes, o que prejudica as aulas e o uso pedagógico das salas de informática. A demanda ' +
  'atende ao planejamento da rede de ensino e à continuidade do serviço público prestado. '
)
  .repeat(2)
  .slice(0, 400);
const FOREIGN_MARK = 'Necessidade exclusiva da Prefeitura B para os postos de saúde rurais.';

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

/** Saída do provedor com a seção pedida. */
const sectionOutput = (sectionKey: string, text: string) => ({
  sections: [{ sectionKey, blocks: [{ type: 'paragraph', text }] }],
});

interface Target {
  readonly processId: string;
  readonly documentId: string;
  readonly targetModule: AiTargetModule;
}
type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Ajustar seção com IA (US-121)', () => {
  let api: TestApi;
  let openStages: Set<string>;
  let catalog: { contractingType: string; origin: string; market: string };
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
  const sectionOf = (documentId: string, key: string) =>
    documentOf(documentId).draftContent.sections[key];
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
  const versionRowsOf = (documentId: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.eventType === 'DocumentVersionCreated' &&
          (row.payload as { documentId?: string }).documentId === documentId,
      );

  /** Processo aberto por Ana (custódia), em andamento na etapa de estudos, com etapa aberta. */
  async function newProcess(subject = 'sub-ana', tenant: string = A): Promise<Process> {
    const units = tenant === A ? UNITS_A : UNITS_B;
    const response = await auth(request(api.server).post('/api/v1/processes'), subject, tenant)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Computadores ${words()} ${words()}`,
        object: `Aquisição de computadores ${words()} ${words()}`,
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
    const stage = workflowStagesOf(api, tenant).find(
      (candidate) =>
        candidate.key === 'ESTUDOS_PRELIMINARES' &&
        candidate.workflowVersionId === created.workflowVersionId,
    );
    const moved: Process = {
      ...created,
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stage?.id ?? created.currentWorkflowStageId,
    };
    processRepositoryOf(api).replace(moved);
    openStages.add(moved.id);
    return moved;
  }

  async function create(
    path: string,
    subject = 'sub-ana',
    tenant: string = A,
  ): Promise<request.Response> {
    const response = await auth(request(api.server).post(path), subject, tenant)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response;
  }

  async function createDfd(processId: string, subject = 'sub-ana', tenant: string = A) {
    return data<DfdDto>(await create(`/api/v1/processes/${processId}/dfds`, subject, tenant))
      .documentId;
  }

  async function createEtp(processId: string, subject = 'sub-ana', tenant: string = A) {
    return data<{ documentId: string }>(
      await create(`/api/v1/processes/${processId}/etps`, subject, tenant),
    ).documentId;
  }

  async function createTerm(processId: string) {
    return data<{ documentId: string }>(await create(`/api/v1/processes/${processId}/terms`))
      .documentId;
  }

  async function emitRiskMap(processId: string) {
    const risk = await auth(request(api.server).post(`/api/v1/processes/${processId}/risks`))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: 'Fornecedores insuficientes',
        categoryId: catalog.market,
        phase: 'PLANNING',
        cause: 'Mercado local com poucos fornecedores habilitados',
        consequence: 'Licitação deserta e atraso na contratação',
        probability: 1,
        impact: 1,
      });
    expect(risk.status, JSON.stringify(risk.body)).toBe(201);
    return documentSchema.parse(
      data<DocumentDto>(await create(`/api/v1/processes/${processId}/risk-map`)),
    ).id;
  }

  /** Grava a seção direto no rascunho (estado do Background), com a revisão informada. */
  function seedSection(documentId: string, key: string, text: string, revision: number) {
    const document = documentOf(documentId);
    documentRepositoryOf(api).seed({
      ...document,
      draftContent: {
        sections: {
          ...document.draftContent.sections,
          [key]: filledSection(text, { revision }),
        },
      },
    });
  }

  /**
   * Background: processo "0012/2026" com o ETP em DRAFT — "NEED_DESCRIPTION" preenchida (400
   * caracteres, revisão 3) e "PROBLEM" vazia; Lúcia colaboradora.
   */
  async function background(): Promise<Target> {
    const process = await newProcess();
    const documentId = await createEtp(process.id);
    seedSection(documentId, 'NEED_DESCRIPTION', NEED_TEXT, 3);
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.lucia.id,
      role: 'COLLABORATOR',
    });
    return { processId: process.id, documentId, targetModule: 'ETP' };
  }

  const requestAdjust = (
    target: Target,
    sectionKey: string,
    action: 'REWRITE' | 'COMPLETE' | 'SUMMARIZE',
    options: { subject?: string; key?: string; instruction?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({
        targetModule: target.targetModule,
        documentId: target.documentId,
        kind: 'SECTION',
        action,
        sectionKey,
        ...(options.instruction === undefined ? {} : { instruction: options.instruction }),
      });

  async function requested(
    target: Target,
    sectionKey: string,
    action: 'REWRITE' | 'COMPLETE' | 'SUMMARIZE',
  ): Promise<string> {
    const response = await requestAdjust(target, sectionKey, action);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return data<AiGenerationDto>(response).id;
  }

  /** Sugestão `SUCCEEDED` de Ana para a seção. */
  async function suggestion(
    target: Target,
    sectionKey: string,
    action: 'REWRITE' | 'COMPLETE' | 'SUMMARIZE' = 'REWRITE',
  ): Promise<string> {
    const id = await requested(target, sectionKey, action);
    await expect(runAiJob(api, id)).resolves.toBe('completed');
    expect(stored(id)?.status, JSON.stringify(stored(id)?.errorCode)).toBe('SUCCEEDED');
    return id;
  }

  const apply = (
    documentId: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string | null; subject?: string; key?: string } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/documents/${documentId}/ai-apply`),
      options.subject,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    const ifMatch =
      options.ifMatch === undefined
        ? `"${String(documentOf(documentId).version)}"`
        : options.ifMatch;
    return (ifMatch === null ? call : call.set('If-Match', ifMatch)).send(body);
  };

  /** DOC-05 (autosave do editor e o "Desfazer" do painel). */
  const putSection = (documentId: string, key: string, text: string, subject = 'sub-ana') =>
    auth(request(api.server).put(`/api/v1/documents/${documentId}/sections/${key}`), subject)
      .set('If-Match', `"s${String(sectionOf(documentId, key)?.revision ?? 0)}"`)
      .send({
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
        notApplicable: false,
        justification: null,
      });

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
    // "Bruno": edita o ETP, mas não tem AI_GENERATE.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedCustomRole(api, A, 'Editor sem IA', ['PROCESS_VIEW', 'ETP_UPDATE']).id,
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      market: catalogItemId(api, A, 'RISK_CATEGORY', 'MERCADO_FORNECEDOR'),
    };
    openStages = openStageForAnyType(api);
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
  });

  describe('[Sucesso]', () => {
    it('Reescrever uma seção e aplicar depois da comparação', async () => {
      const target = await background();
      const response = await requestAdjust(target, 'NEED_DESCRIPTION', 'REWRITE', {
        instruction: 'Use linguagem mais direta.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const generation = aiGenerationSchema.parse(data<AiGenerationDto>(response));
      expect(generation).toMatchObject({
        status: 'QUEUED',
        kind: 'SECTION',
        action: 'REWRITE',
        sectionKey: 'NEED_DESCRIPTION',
        baseRevision: 3,
        targetModule: 'ETP',
        promptKey: 'section.rewrite',
        promptVersion: '1.0.0',
      });
      expect(response.headers.location).toBe(`/api/v1/ai-generations/${generation.id}`);
      expect(stored(generation.id)).toMatchObject({ reservedTokens: 6_000 });
      expect(auditOf('ai.generation_request', generation.id)[0]?.metadata).toMatchObject({
        kind: 'SECTION',
        action: 'REWRITE',
        sectionKey: 'NEED_DESCRIPTION',
        promptKey: 'section.rewrite',
        promptVersion: '1.0.0',
      });
      expect(JSON.stringify(auditOf('ai.generation_request', generation.id))).not.toContain(
        'linguagem mais direta',
      );
      expect(eventsOf(generation.id, 'AiGenerationRequested')[0]?.payload).toMatchObject({
        kind: 'SECTION',
        action: 'REWRITE',
        sectionKey: 'NEED_DESCRIPTION',
      });

      provider.enqueue({
        kind: 'output',
        output: sectionOutput(
          'NEED_DESCRIPTION',
          'Os laboratórios de informática das escolas municipais operam com computadores obsoletos e sem suporte, o que compromete as aulas.',
        ),
      });
      await expect(runAiJob(api, generation.id)).resolves.toBe('completed');
      const done = stored(generation.id);
      expect(done?.status).toBe('SUCCEEDED');
      expect(done?.output?.sections.map((section) => section.sectionKey)).toEqual([
        'NEED_DESCRIPTION',
      ]);
      expect(done?.inputRefs[0]).toMatchObject({ kind: 'USER_INSTRUCTION' });
      expect(done?.inputRefs.find((ref) => ref.kind === 'SECTION')).toMatchObject({
        id: 'NEED_DESCRIPTION',
        revision: 3,
      });
      // O texto atual vai ao provedor como dado; a geração não toca o documento.
      expect(JSON.stringify(provider.calls[0]?.messages)).toContain(NEED_TEXT.slice(0, 60));
      expect(provider.calls[0]?.model).toBe('fake-section-1');
      expect(provider.calls[0]?.metadata.promptKey).toBe('section.rewrite');
      expect(sectionOf(target.documentId, 'NEED_DESCRIPTION')?.revision).toBe(3);
      expect(
        timelineRowsOf(api).find(
          (row) => row.type === 'AI_CONTENT_GENERATED' && row.entityId === generation.id,
        ),
      ).toMatchObject({ processId: target.processId });

      const versionsBefore = versionRowsOf(target.documentId).length;
      const draftRevision = documentOf(target.documentId).draftRevision;
      const applied = await apply(target.documentId, {
        generationId: generation.id,
        sectionKeys: ['NEED_DESCRIPTION'],
        confirmReplaceFilled: true,
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      const result = documentAiApplyResultSchema.parse(data(applied));
      expect(result.versionCreated).toBeNull();
      expect(result.appliedSectionKeys).toEqual(['NEED_DESCRIPTION']);
      const section = sectionOf(target.documentId, 'NEED_DESCRIPTION');
      expect(section).toMatchObject({ state: 'FILLED', revision: 4 });
      expect(section?.ai).toMatchObject({ generationId: generation.id, reviewedAt: null });
      expect(documentOf(target.documentId).draftRevision).toBe(draftRevision + 1);
      expect(stored(generation.id)?.status).toBe('APPLIED');
      expect(versionRowsOf(target.documentId)).toHaveLength(versionsBefore);
      expect(eventsOf(target.documentId, 'AiContentApplied')[0]?.payload).toMatchObject({
        generationId: generation.id,
        sectionKeys: ['NEED_DESCRIPTION'],
        riskIds: [],
        replacedFilledSections: 1,
      });
      expect(auditOf('ai.content_apply', target.documentId)[0]?.metadata).toMatchObject({
        sectionKeys: ['NEED_DESCRIPTION'],
        replacedFilledSections: 1,
        versionCreated: null,
        promptKey: 'section.rewrite',
      });
    });

    it('Completar seção vazia, resumir e desfazer', async () => {
      const target = await background();
      const complete = await suggestion(target, 'PROBLEM', 'COMPLETE');
      expect(stored(complete)?.promptKey).toBe('section.complete');
      const filled = await apply(target.documentId, {
        generationId: complete,
        sectionKeys: ['PROBLEM'],
      });
      expect(filled.status, JSON.stringify(filled.body)).toBe(200);
      expect(sectionOf(target.documentId, 'PROBLEM')?.state).toBe('FILLED');
      expect(eventsOf(target.documentId, 'AiContentApplied')[0]?.payload).toMatchObject({
        replacedFilledSections: 0,
      });

      provider.enqueue({
        kind: 'output',
        output: sectionOutput(
          'NEED_DESCRIPTION',
          'A rede municipal precisa substituir os computadores obsoletos dos laboratórios.',
        ),
      });
      const summarize = await suggestion(target, 'NEED_DESCRIPTION', 'SUMMARIZE');
      expect(stored(summarize)?.promptKey).toBe('section.summarize');
      const summarized = await apply(target.documentId, {
        generationId: summarize,
        sectionKeys: ['NEED_DESCRIPTION'],
        confirmReplaceFilled: true,
      });
      expect(summarized.status, JSON.stringify(summarized.body)).toBe(200);
      expect(sectionOf(target.documentId, 'NEED_DESCRIPTION')?.revision).toBe(4);

      // "Desfazer": o painel regrava o texto anterior pelo DOC-05 (If-Match "s4").
      const undo = await putSection(target.documentId, 'NEED_DESCRIPTION', NEED_TEXT);
      expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      const restored = sectionOf(target.documentId, 'NEED_DESCRIPTION');
      expect(JSON.stringify(restored?.content)).toContain(NEED_TEXT.slice(0, 60));
      expect(restored?.revision).toBe(5);
      // Editar não revisa (RN-AI-55): a proveniência "ai" continua pendente (lacuna 1).
      expect(restored?.ai).toMatchObject({ generationId: summarize, reviewedAt: null });
    });

    it('Ajustar seção nos quatro editores', async () => {
      const process = await newProcess();
      const dfd = await createDfd(process.id);
      const etp = await createEtp(process.id);
      const riskMap = await emitRiskMap(process.id);
      const term = await createTerm(process.id);
      const cases: readonly [AiTargetModule, string, string][] = [
        ['DFD', dfd, 'JUSTIFICATION'],
        ['ETP', etp, 'NEED_DESCRIPTION'],
        ['RISK_MAP', riskMap, 'INTRODUCTION'],
        ['TERM_OF_REFERENCE', term, 'OBJECT'],
      ];
      const ids: string[] = [];
      for (const [targetModule, documentId, sectionKey] of cases) {
        seedSection(documentId, sectionKey, NEED_TEXT, 1);
        ids.push(await suggestion({ processId: process.id, documentId, targetModule }, sectionKey));
      }
      expect(ids.map((id) => stored(id)?.targetModule)).toEqual([
        'DFD',
        'ETP',
        'RISK_MAP',
        'TERM_OF_REFERENCE',
      ]);
      expect(ids.map((id) => stored(id)?.status)).toEqual([
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
      ]);
      // O TR usa os antecessores que existem (DFD, ETP e Mapa de Riscos), sem exigir nenhum.
      const trRefs = stored(ids[3] ?? '')?.inputRefs.map((ref) => ref.documentTypeCode);
      expect(trRefs).toEqual(expect.arrayContaining(['DFD', 'ETP', 'RISK_MAP']));
      // O DFD não tem antecessor: nenhum aviso de entrada faltante.
      expect(stored(ids[0] ?? '')?.output?.warnings).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ code: 'MISSING_OPTIONAL_INPUT' })]),
      );
    });
  });

  describe('[Validação]', () => {
    it('Seção curta, sem narrativa ou valor inventado', async () => {
      const target = await background();
      seedSection(target.documentId, 'OBJECTIVE', 'Texto com 20 letras.', 1);
      const before = aiRepositoryOf(api).all().length;
      const short = expectProblem(
        await requestAdjust(target, 'OBJECTIVE', 'REWRITE'),
        422,
        'AI_SECTION_EMPTY',
      );
      expect(short.detail).toContain('50 caracteres');
      expectProblem(await requestAdjust(target, 'OBJECTIVE', 'SUMMARIZE'), 422, 'AI_SECTION_EMPTY');
      expect(aiRepositoryOf(api).all()).toHaveLength(before);

      // Seção calculada do Mapa de Riscos (render RISK_MATRIX, sem narrativa) e chave fora do modelo.
      const riskMap = await emitRiskMap(target.processId);
      const riskTarget = { ...target, documentId: riskMap, targetModule: 'RISK_MAP' as const };
      expectProblem(
        await requestAdjust(riskTarget, 'RISK_MATRIX', 'COMPLETE'),
        422,
        'AI_SECTION_NOT_SUPPORTED',
      );
      expectProblem(
        await requestAdjust(target, 'NOT_IN_TEMPLATE', 'COMPLETE'),
        422,
        'AI_SECTION_NOT_SUPPORTED',
      );
      // "Não se aplica" (V-03).
      const document = documentOf(target.documentId);
      documentRepositoryOf(api).seed({
        ...document,
        draftContent: {
          sections: {
            ...document.draftContent.sections,
            OBJECTIVE: filledSection('', {
              state: 'NOT_APPLICABLE',
              content: null,
              justification: 'Não se aplica a esta contratação de bens comuns.',
            }),
          },
        },
      });
      expectProblem(
        await requestAdjust(target, 'OBJECTIVE', 'COMPLETE'),
        422,
        'AI_SECTION_NOT_SUPPORTED',
      );
      // V-01: orientação acima de 500 caracteres.
      expectProblem(
        await requestAdjust(target, 'NEED_DESCRIPTION', 'REWRITE', {
          instruction: 'x'.repeat(501),
        }),
        422,
        'VALIDATION_ERROR',
      );

      // Valor inventado pelo provedor → "[a confirmar]" da categoria VALUE.
      provider.enqueue({
        kind: 'output',
        output: sectionOutput(
          'NEED_DESCRIPTION',
          'Os computadores dos laboratórios estão obsoletos; a substituição custará R$ 90.000,00.',
        ),
      });
      const id = await suggestion(target, 'NEED_DESCRIPTION');
      const [section] = stored(id)?.output?.sections ?? [];
      expect(JSON.stringify(section?.content)).not.toContain('90.000');
      expect(JSON.stringify(section?.content)).toContain('"category":"VALUE"');
      expect(section?.groundingReplacements).toBe(1);
      expect(stored(id)?.groundingReplacements).toBe(1);
    });

    it('Aplicar sem confirmar a substituição', async () => {
      const target = await background();
      const id = await suggestion(target, 'NEED_DESCRIPTION');
      const before = sectionOf(target.documentId, 'NEED_DESCRIPTION');
      const response = expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['NEED_DESCRIPTION'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(response)).toContain('CONDITIONAL_REQUIRED');
      expect(sectionOf(target.documentId, 'NEED_DESCRIPTION')).toEqual(before);
      expect(stored(id)?.status).toBe('SUCCEEDED');
      // V-08: só a seção da geração.
      expectProblem(
        await apply(target.documentId, {
          generationId: id,
          sectionKeys: ['NEED_DESCRIPTION', 'PROBLEM'],
          confirmReplaceFilled: true,
        }),
        422,
        'VALIDATION_ERROR',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Sem AI_GENERATE e solicitante diferente', async () => {
      const target = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: target.processId,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
      });
      expectProblem(
        await requestAdjust(target, 'NEED_DESCRIPTION', 'REWRITE', { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
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

      const id = await suggestion(target, 'NEED_DESCRIPTION');
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['NEED_DESCRIPTION'], confirmReplaceFilled: true },
          { subject: 'sub-lucia' },
        ),
        403,
        'AI_GENERATION_NOT_OWNED',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Sugestão e documento de outro tenant', async () => {
      const own = await background();
      const foreignProcess = await newProcess('sub-heitor', B);
      const foreignEtp = await createEtp(foreignProcess.id, 'sub-heitor', B);
      seedSection(foreignEtp, 'NEED_DESCRIPTION', `${FOREIGN_MARK} ${NEED_TEXT}`, 1);
      const foreign = requestGeneration({
        id: newId(),
        tenantId: B,
        processId: foreignProcess.id,
        documentId: foreignEtp,
        targetModule: 'ETP',
        kind: 'SECTION',
        action: 'REWRITE',
        sectionKey: 'NEED_DESCRIPTION',
        baseRevision: 1,
        needSummary: null,
        instruction: null,
        provider: 'fake',
        promptKey: 'section.rewrite',
        promptVersion: '1.0.0',
        reservedTokens: 6_000,
        createdById: FAKE_USERS.heitor.id,
        now: new Date(),
      });
      aiRepositoryOf(api).seed(foreign);

      expectProblem(
        await apply(own.documentId, {
          generationId: foreign.id,
          sectionKeys: ['NEED_DESCRIPTION'],
          confirmReplaceFilled: true,
        }),
        404,
        'AI_GENERATION_NOT_FOUND',
      );
      const crossed = expectProblem(
        await requestAdjust(
          { processId: own.processId, documentId: foreignEtp, targetModule: 'ETP' },
          'NEED_DESCRIPTION',
          'REWRITE',
        ),
        404,
        'NOT_FOUND',
      );
      expect(JSON.stringify(crossed)).not.toContain(foreignProcess.id);

      // O contexto enviado ao provedor só tem dados do próprio tenant.
      await suggestion(own, 'NEED_DESCRIPTION');
      expect(JSON.stringify(provider.calls)).not.toContain(FOREIGN_MARK);
      expect(JSON.stringify(provider.calls)).not.toContain(foreignProcess.id);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da aplicação e ajuste ativo na mesma seção', async () => {
      const target = await background();
      const id = await suggestion(target, 'NEED_DESCRIPTION');
      const body = {
        generationId: id,
        sectionKeys: ['NEED_DESCRIPTION'],
        confirmReplaceFilled: true,
      };
      const ifMatch = `"${String(documentOf(target.documentId).version)}"`;
      const k1 = randomUUID();
      const once = await apply(target.documentId, body, { key: k1, ifMatch });
      expect(once.status, JSON.stringify(once.body)).toBe(200);
      const twice = await apply(target.documentId, body, { key: k1, ifMatch });
      expect(twice.status).toBe(200);
      expect(twice.headers['idempotent-replayed']).toBe('true');
      expect(sectionOf(target.documentId, 'NEED_DESCRIPTION')?.revision).toBe(4);
      expect(auditOf('ai.content_apply', target.documentId)).toHaveLength(1);

      const running = await requested(target, 'NEED_DESCRIPTION', 'REWRITE');
      const generation = stored(running);
      if (generation === undefined) throw new Error('geração ausente');
      aiRepositoryOf(api).seed({ ...generation, status: 'RUNNING', attempts: 1 });
      const conflict = await requestAdjust(target, 'NEED_DESCRIPTION', 'SUMMARIZE');
      expectProblem(conflict, 409, 'AI_GENERATION_IN_PROGRESS');
      expect(conflict.body).toMatchObject({ meta: { generationId: running } });
      // Seções diferentes podem ser pedidas em paralelo (RN-AI-52).
      expect((await requestAdjust(target, 'PROBLEM', 'COMPLETE')).status).toBe(202);
    });
  });

  describe('[Concorrência]', () => {
    it('Seção editada depois do pedido: 410 AI_SUGGESTION_STALE e a seção fica como o colega a deixou', async () => {
      const target = await background();
      const id = await suggestion(target, 'NEED_DESCRIPTION');
      expect(stored(id)?.baseRevision).toBe(3);
      const edited = `${NEED_TEXT.slice(0, 200)} Texto revisto pela colega.`;
      const save = await putSection(target.documentId, 'NEED_DESCRIPTION', edited, 'sub-lucia');
      expect(save.status, JSON.stringify(save.body)).toBe(200);
      const after = sectionOf(target.documentId, 'NEED_DESCRIPTION');
      expect(after?.revision).toBe(4);

      const stale = expectProblem(
        await apply(target.documentId, {
          generationId: id,
          sectionKeys: ['NEED_DESCRIPTION'],
          confirmReplaceFilled: true,
        }),
        410,
        'AI_SUGGESTION_STALE',
      );
      expect(stale.detail).toContain('Gere o ajuste novamente');
      expect(sectionOf(target.documentId, 'NEED_DESCRIPTION')).toEqual(after);
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });

    it('If-Match divergente responde 412 antes da checagem da revisão da seção', async () => {
      const target = await background();
      const id = await suggestion(target, 'NEED_DESCRIPTION');
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['NEED_DESCRIPTION'], confirmReplaceFilled: true },
          { ifMatch: '"999"' },
        ),
        412,
        'VERSION_CONFLICT',
      );
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['NEED_DESCRIPTION'], confirmReplaceFilled: true },
          { ifMatch: null },
        ),
        428,
        'PRECONDITION_REQUIRED',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante a aplicação: 503, seção intacta e a geração continua SUCCEEDED', async () => {
      const target = await background();
      const id = await suggestion(target, 'NEED_DESCRIPTION');
      const before = sectionOf(target.documentId, 'NEED_DESCRIPTION');
      transactions.down = true;
      expectProblem(
        await apply(target.documentId, {
          generationId: id,
          sectionKeys: ['NEED_DESCRIPTION'],
          confirmReplaceFilled: true,
        }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(sectionOf(target.documentId, 'NEED_DESCRIPTION')).toEqual(before);
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Falha de integração]', () => {
    it('Provedor com 429 nas 3 tentativas: FAILED/PROVIDER_RATE_LIMITED e a seção não muda', async () => {
      const target = await background();
      const before = sectionOf(target.documentId, 'NEED_DESCRIPTION');
      provider.enqueue(
        { kind: 'error', error: 'RATE_LIMITED' },
        { kind: 'error', error: 'RATE_LIMITED' },
        { kind: 'error', error: 'RATE_LIMITED' },
      );
      const id = await requested(target, 'NEED_DESCRIPTION', 'REWRITE');
      const { error } = await runAiJobWithRetries(api, id);
      expect(error).toBeNull();
      expect(stored(id)).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_RATE_LIMITED' });
      expect(eventsOf(id, 'AiGenerationFailed')[0]?.payload).toMatchObject({
        errorCode: 'PROVIDER_RATE_LIMITED',
        requestedById: FAKE_USERS.ana.id,
      });
      expect(sectionOf(target.documentId, 'NEED_DESCRIPTION')).toEqual(before);
      await api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE).recordSuccess();
    });

    it('Saída fora do schema mesmo após o reparo: FAILED/OUTPUT_INVALID', async () => {
      const target = await background();
      // Seção errada e, no reparo, nenhuma seção — as duas fora do pedido.
      provider.enqueue(
        { kind: 'output', output: sectionOutput('PROBLEM', 'Outra seção.') },
        { kind: 'output', output: { sections: [] } },
      );
      const id = await requested(target, 'NEED_DESCRIPTION', 'REWRITE');
      await runAiJob(api, id);
      expect(stored(id)).toMatchObject({ status: 'FAILED', errorCode: 'OUTPUT_INVALID' });
      expect(provider.calls).toHaveLength(2);
    });

    it('Circuito aberto: 503 AI_PROVIDER_UNAVAILABLE com Retry-After', async () => {
      const target = await background();
      const circuit = api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE);
      const now = Date.now();
      for (let failure = 0; failure < 5; failure += 1) await circuit.recordFailure(now);
      const blocked = await requestAdjust(target, 'NEED_DESCRIPTION', 'REWRITE');
      expectProblem(blocked, 503, 'AI_PROVIDER_UNAVAILABLE');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      await circuit.recordSuccess();
    });
  });
});

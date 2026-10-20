import { randomUUID } from 'node:crypto';

import {
  aiGenerationSchema,
  documentAiApplyResultSchema,
  etpSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  AiGenerationDto,
  DfdDto,
  DocumentSnapshot,
  EtpDto,
  ProcessDto,
  RichTextNode,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  buildDocument,
  buildVersion,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  filledSection,
} from '../../../../test/support/document-fixtures.js';
import type { DocumentTransactions } from '../../../../test/support/document-fixtures.js';
import {
  etpAlternativeRepositoryOf,
  etpRepositoryOf,
} from '../../../../test/support/etp-fixtures.js';
import { seedPriceResearch } from '../../../../test/support/price-research-fixtures.js';
import {
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
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
  CONCLUSION_PENDING,
  PARCELING_PENDING,
  SOLUTION_PENDING,
  VALUE_PENDING,
} from '../domain/etp-draft-context.js';
import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from '../infrastructure/fake-ai.provider.js';

/*
 * US-118 — Gerar o rascunho do ETP com IA a partir do DFD (AI-01 → job `ai-generation` → AI-02 →
 * DOC-26) pelo pipeline HTTP completo, com o gerador REAL `draft.etp` (contexto pelas fachadas de
 * `document`, `dfd`, `etp`, `price-research`, `process`, `catalog` e `organization`), o
 * `FakeAiProvider` com a fixture `draft.etp/padrao` (nenhuma chamada real) e os adaptadores em
 * memória. O portão do órgão é o de teste (US-116 tem a suíte própria). Notificações
 * `AI_GENERATION_READY/FAILED`: o worker as deriva de `AiGenerationCompleted/Failed`
 * (`apps/worker/src/notifications/notification-rules.spec.ts`); aqui conferimos o evento. RLS em
 * PostgreSQL: `test/tenant-leak/ai-etp-draft.spec.ts`.
 *
 * Personas: "Carla" (PLANEJAMENTO, custódia do processo nos estudos preliminares) = Lúcia; "Bruno"
 * (sem AI_GENERATE) = Otávio (SOMENTE_LEITURA); "Paula" (participante colaboradora) = Ana, que abre
 * o processo e elabora o DFD.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';
const PAULA = 'sub-ana';
const UNITS_A = {
  organizationId: '0192d118-0000-7000-8000-0000000000a0',
  obras: '0192d118-0000-7000-8000-0000000000a1',
  manutencao: '0192d118-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d118-0000-7000-8000-0000000000a3',
  saude: '0192d118-0000-7000-8000-0000000000a4',
  posto: '0192d118-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d118-0000-7000-8000-0000000000b0',
  obras: '0192d118-0000-7000-8000-0000000000b1',
  manutencao: '0192d118-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d118-0000-7000-8000-0000000000b3',
  saude: '0192d118-0000-7000-8000-0000000000b4',
  posto: '0192d118-0000-7000-8000-0000000000b5',
};
/** As 15 seções da fixture `draft.etp/padrao` (a opcional OBJECTIVE fica de fora — sem base). */
const PROPOSED = [
  'NEED_DESCRIPTION',
  'PROBLEM',
  'PCA_ALIGNMENT',
  'REQUIREMENTS',
  'MARKET_SURVEY',
  'ALTERNATIVES',
  'ESTIMATES',
  'RECOMMENDED_SOLUTION',
  'PARCELING',
  'RELATED_CONTRACTS',
  'EXPECTED_RESULTS',
  'ENVIRONMENTAL_IMPACTS',
  'PRIOR_MEASURES',
  'RISKS',
  'CONCLUSION',
];
const DFD_TEXT = 'Os laboratórios de informática operam com equipamentos obsoletos e sem suporte.';

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

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Rótulos das marcações `[a confirmar]` (nós `toConfirm`) de um conteúdo TipTap. */
function toConfirmLabels(content: unknown): string[] {
  const labels: string[] = [];
  const walk = (nodes: readonly RichTextNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type === 'toConfirm') labels.push(String(node.attrs?.label));
      walk(node.content);
    }
  };
  walk((content as RichTextNode | null)?.content);
  return labels;
}

interface Target {
  readonly processId: string;
  readonly documentId: string;
  readonly dfdId: string | null;
}
type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Gerar o rascunho do ETP com IA a partir do DFD (US-118)', () => {
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
  let catalog: { contractingType: string; origin: string; un: string };
  // Só letras: o teste confere que o custo (777…) não vaza, e um hexadecimal podia conter "777".
  const words = () =>
    randomUUID()
      .replaceAll('-', '')
      .slice(0, 10)
      .replace(/\d/g, (digit) => String.fromCharCode(103 + Number(digit)));

  const auth = (call: request.Test, subject = CARLA, tenant: string = A) =>
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
  const etpRowOf = (id: string) =>
    etpRepositoryOf(api)
      .snapshot()
      .find((row) => row.id === id);
  const alternativesOf = (etpId: string) =>
    etpAlternativeRepositoryOf(api)
      .snapshot()
      .filter((row) => row.etpId === etpId);
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
  const typeOf = (code: string, tenantId: string = A) =>
    documentTypeRepositoryOf(api)
      .snapshot()
      .find((type) => type.tenantId === tenantId && type.code === code);

  /** Processo aberto por Ana; itens e DFD (opcional) antes de ir aos estudos preliminares. */
  async function newProcess(
    options: { tenant?: string; subject?: string; fields?: Partial<Process> } = {},
  ): Promise<Process> {
    const tenant = options.tenant ?? A;
    const units = tenant === A ? UNITS_A : UNITS_B;
    const response = await auth(
      request(api.server).post('/api/v1/processes'),
      options.subject ?? PAULA,
      tenant,
    )
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
    return created;
  }

  async function createDfd(processId: string, subject = PAULA, tenant: string = A) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/dfds`),
      subject,
      tenant,
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: DfdDto }).data;
  }

  /** O DFD aprovado na versão `versionNumber`, com a justificativa congelada na versão. */
  function approveDfd(dfdId: string, versionNumber = 2) {
    const document = documentOf(dfdId);
    const version = buildVersion(document, {
      versionNumber,
      reason: 'SUBMISSION',
      statusAtCreation: 'APPROVED',
      content: {
        sections: { JUSTIFICATION: filledSection(DFD_TEXT) },
      } as unknown as DocumentSnapshot,
    });
    documentRepositoryOf(api).seedVersion(version);
    documentRepositoryOf(api).seed({
      ...document,
      status: 'APPROVED',
      approvedVersionId: version.id,
      currentVersionId: version.id,
      currentVersionNumber: versionNumber,
    });
  }

  /** Processo nos estudos preliminares sob custódia da Carla (Lúcia). */
  function toPreliminaryStudies(process: Process, fields: Partial<Process> = {}): Process {
    const stageId =
      workflowStagesOf(api, process.tenantId).find(
        (candidate) =>
          candidate.key === 'ESTUDOS_PRELIMINARES' &&
          candidate.workflowVersionId === process.workflowVersionId,
      )?.id ?? null;
    const moved: Process = {
      ...process,
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId,
      currentResponsibleId: FAKE_USERS.lucia.id,
      ...fields,
    };
    processRepositoryOf(api).replace(moved);
    return moved;
  }

  async function createEtp(processId: string, subject = CARLA, tenant: string = A) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/etps`),
      subject,
      tenant,
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return etpSchema.parse((response.body as { data: EtpDto }).data);
  }

  /** Item do processo, criado por Ana enquanto ela tem a custódia. */
  async function createItem(processId: string): Promise<string> {
    const item = await auth(request(api.server).post(`/api/v1/processes/${processId}/items`), PAULA)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description: 'Computador desktop', unitOfMeasureId: catalog.un });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    return (item.body as { data: { id: string } }).data.id;
  }

  /** A linha do ETP com a memória de cálculo (DOC-07). */
  async function addEtpItem(etpId: string, processItemId: string) {
    const saved = await auth(request(api.server).put(`/api/v1/documents/${etpId}/items`))
      .set('If-Match', `"${String(documentOf(etpId).version)}"`)
      .send({
        items: [
          {
            processItemId,
            quantity: '120',
            calculationMemo: paragraph('12 escolas com 10 estações cada'),
          },
        ],
      });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }

  async function addAlternative(etpId: string, name: string) {
    const response = await auth(request(api.server).post(`/api/v1/etps/${etpId}/alternatives`))
      .set('Idempotency-Key', randomUUID())
      .send({
        name,
        description: paragraph(`${name} dos equipamentos`),
        estimatedCost: '777777.77',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  /** Pesquisa de preços do processo (documento finalizado = concluída) com o total. */
  function seedResearch(process: Pick<Process, 'id' | 'tenantId'>, total = '125000.00') {
    const type = typeOf('PRICE_RESEARCH', process.tenantId);
    const id = newId();
    documentRepositoryOf(api).seed(
      buildDocument({
        id,
        tenantId: process.tenantId,
        processId: process.id,
        documentTypeId: type?.id ?? newId(),
        code: 'PP 0003/2026',
        title: 'Pesquisa de preços — computadores',
        status: 'FINALIZED',
        singletonKey: type?.id ?? null,
      }),
    );
    seedPriceResearch(api, {
      id,
      tenantId: process.tenantId,
      processId: process.id,
      totalEstimatedValue: total,
      completedAt: new Date(),
      now: new Date(),
    });
    return id;
  }

  /**
   * Background: processo "0012/2026" com o DFD aprovado na versão 2 e o ETP em DRAFT (seções
   * EMPTY), um item com memória de cálculo e duas alternativas em análise; Carla com custódia.
   */
  async function background(
    options: {
      dfd?: 'APPROVED' | 'DRAFT' | 'NONE';
      research?: boolean;
      process?: Partial<Process>;
    } = {},
  ): Promise<Target> {
    const created = await newProcess();
    const processItemId = await createItem(created.id);
    const dfd = options.dfd === 'NONE' ? null : await createDfd(created.id);
    if (dfd !== null && options.dfd !== 'DRAFT') approveDfd(dfd.documentId);
    const process = toPreliminaryStudies(created, options.process);
    const etp = await createEtp(process.id);
    await addEtpItem(etp.documentId, processItemId);
    await addAlternative(etp.documentId, 'Aquisição');
    await addAlternative(etp.documentId, 'Locação');
    if (options.research !== false) seedResearch(process);
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.ana.id,
      role: 'COLLABORATOR',
    });
    return { processId: process.id, documentId: etp.documentId, dfdId: dfd?.documentId ?? null };
  }

  const requestDraft = (
    target: Pick<Target, 'processId' | 'documentId'>,
    options: { subject?: string; key?: string; body?: object; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${target.processId}/ai-generations`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(options.body ?? { targetModule: 'ETP', kind: 'DRAFT', documentId: target.documentId });

  async function requested(target: Target): Promise<string> {
    const response = await requestDraft(target);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { data: AiGenerationDto }).data.id;
  }

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

  function seedSection(documentId: string, key: string, section: ReturnType<typeof filledSection>) {
    const document = documentOf(documentId);
    documentRepositoryOf(api).seed({
      ...document,
      version: document.version + 1,
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
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.lucia.id),
      roleId: roles.get('PLANEJAMENTO')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
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
    transactions.down = false;
    jobQueueOf(api).down = false;
    gate.decision = { allowed: true };
    settings.requestTimeoutMs = 5_000;
  });

  describe('[Sucesso]', () => {
    it('Gerar o rascunho a partir do DFD aprovado: 202 QUEUED draft.etp e, no worker, SUCCEEDED com inputRefs do DFD v2, itens e pesquisa', async () => {
      const target = await background();
      const before = documentOf(target.documentId);
      const response = await requestDraft(target, { key: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const body = response.body as { data: AiGenerationDto; meta: { pollAfterMs: number } };
      const generation = aiGenerationSchema.parse(body.data);
      expect(generation).toMatchObject({
        status: 'QUEUED',
        targetModule: 'ETP',
        kind: 'DRAFT',
        documentId: target.documentId,
        promptKey: 'draft.etp',
        promptVersion: '1.0.0',
      });
      expect(response.headers.location).toBe(`/api/v1/ai-generations/${generation.id}`);
      expect(stored(generation.id)).toMatchObject({ reservedTokens: 40_000 });
      expect(auditOf('ai.generation_request', generation.id)[0]?.metadata).toMatchObject({
        promptKey: 'draft.etp',
        targetModule: 'ETP',
        kind: 'DRAFT',
      });
      expect(eventsOf(generation.id, 'AiGenerationRequested')).toHaveLength(1);
      expect(provider.calls).toHaveLength(0);

      await expect(runAiJob(api, generation.id)).resolves.toBe('completed');
      const done = stored(generation.id);
      expect(done?.status).toBe('SUCCEEDED');
      expect(done?.output?.sections.map((section) => section.sectionKey)).toEqual(PROPOSED);
      const refs = done?.inputRefs ?? [];
      expect(refs.find((ref) => ref.kind === 'DOCUMENT_VERSION')).toMatchObject({
        id: target.dfdId,
        documentTypeCode: 'DFD',
        versionNumber: 2,
      });
      expect(refs.map((ref) => ref.kind)).toEqual(
        expect.arrayContaining(['PROCESS_ITEMS', 'ETP_ALTERNATIVES', 'PRICE_RESEARCH']),
      );
      expect(refs.every((ref) => /^[0-9a-f]{64}$/.test(ref.contentHash))).toBe(true);
      expect(done?.output?.warnings).toEqual([]);

      // O contexto: DFD aprovado, memória de cálculo, alternativas sem custo e valor da pesquisa.
      const sent = JSON.stringify(provider.calls[0]?.messages);
      expect(sent).toContain(DFD_TEXT);
      expect(sent).toContain('12 escolas com 10 estações cada');
      expect(sent).toContain('Locação');
      expect(sent).toContain('R$ 125.000,00');
      expect(sent).not.toContain('777');
      expect(sent).not.toContain(FAKE_USERS.ana.id);
      expect(provider.calls[0]?.metadata.promptKey).toBe('draft.etp');

      expect(eventsOf(generation.id, 'AiGenerationCompleted')[0]?.payload).toMatchObject({
        requestedById: FAKE_USERS.lucia.id,
        promptKey: 'draft.etp',
        sectionsCount: PROPOSED.length,
      });
      // A geração nunca altera o ETP.
      expect(documentOf(target.documentId)).toEqual(before);
    });

    it('Aplicar a seleção padrão preservando a seção preenchida: 14 seções FILLED com IA pendente de revisão, PROBLEM intacta, APPLIED sem versão', async () => {
      const target = await background();
      seedSection(target.documentId, 'PROBLEM', filledSection('Texto escrito pela Carla'));
      const id = await proposal(target);
      const empty = PROPOSED.filter((key) => key !== 'PROBLEM');
      expect(empty).toHaveLength(14);
      const before = documentOf(target.documentId);
      const etpBefore = etpRowOf(target.documentId);

      const response = await apply(target.documentId, { generationId: id, sectionKeys: empty });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = documentAiApplyResultSchema.parse((response.body as { data: unknown }).data);
      expect(result.appliedSectionKeys).toEqual(empty);
      expect(result.versionCreated).toBeNull();

      const after = documentOf(target.documentId);
      for (const key of empty) {
        expect(after.draftContent.sections[key]).toMatchObject({
          state: 'FILLED',
          ai: { generationId: id, appliedById: FAKE_USERS.lucia.id, reviewedAt: null },
        });
      }
      expect(after.draftContent.sections.PROBLEM).toEqual(before.draftContent.sections.PROBLEM);
      expect(after.draftRevision).toBe(before.draftRevision + 1);
      expect(documentRepositoryOf(api).versionsOf(target.documentId)).toHaveLength(0);
      expect(stored(id)).toMatchObject({ status: 'APPLIED' });
      expect(etpRowOf(target.documentId)).toEqual(etpBefore);
      expect(auditOf('ai.content_apply', target.documentId)[0]?.metadata).toMatchObject({
        generationId: id,
        promptKey: 'draft.etp',
        replacedFilledSections: 0,
      });
      const [event] = eventsOf(target.documentId, 'AiContentApplied');
      expect(event?.routingKey).toBe('document.ai_content_applied.etp');
      expect(event?.payload).toMatchObject({ targetModule: 'ETP', sectionKeys: empty });
    });

    it('A IA não decide (RN-AI-35): conclusão, solução e parcelamento ficam [a confirmar] e os campos tipados e alternativas não mudam', async () => {
      const target = await background();
      // O provedor tenta decidir: a guarda devolve a decisão à pessoa.
      provider.enqueue({
        kind: 'output',
        output: {
          sections: PROPOSED.map((sectionKey) => ({
            sectionKey,
            blocks: [
              {
                type: 'paragraph',
                text:
                  sectionKey === 'CONCLUSION'
                    ? 'A contratação é viável.'
                    : sectionKey === 'RECOMMENDED_SOLUTION'
                      ? 'Recomenda-se a aquisição.'
                      : 'Texto proposto para a seção.',
              },
            ],
          })),
        },
      });
      const id = await proposal(target);
      const etpBefore = etpRowOf(target.documentId);
      const alternativesBefore = alternativesOf(target.documentId);
      const response = await apply(target.documentId, { generationId: id, sectionKeys: PROPOSED });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const sections = documentOf(target.documentId).draftContent.sections;
      expect(toConfirmLabels(sections.CONCLUSION?.content)).toContain(CONCLUSION_PENDING);
      expect(toConfirmLabels(sections.RECOMMENDED_SOLUTION?.content)).toContain(SOLUTION_PENDING);
      expect(toConfirmLabels(sections.PARCELING?.content)).toContain(PARCELING_PENDING);
      // Com a pesquisa concluída, o valor não fica pendente.
      expect(toConfirmLabels(sections.ESTIMATES?.content)).not.toContain(VALUE_PENDING);
      expect(etpRowOf(target.documentId)).toEqual(etpBefore);
      expect(etpRowOf(target.documentId)).toMatchObject({
        conclusion: 'PENDING',
        parcelingDecision: null,
        recommendedAlternativeId: null,
      });
      expect(alternativesOf(target.documentId)).toEqual(alternativesBefore);
    });

    it('Valor só da pesquisa de preços e DFD em rascunho: USED_DRAFT_INPUTS, valor inventado vira [a confirmar] e, sem pesquisa, MISSING_PRICE_RESEARCH', async () => {
      const target = await background({ dfd: 'DRAFT', research: false });
      provider.enqueue({
        kind: 'output',
        output: {
          sections: PROPOSED.map((sectionKey) => ({
            sectionKey,
            blocks: [
              {
                type: 'paragraph',
                text:
                  sectionKey === 'ESTIMATES'
                    ? 'O valor estimado é de R$ 99.999,00.'
                    : 'Texto proposto para a seção.',
              },
            ],
          })),
        },
      });
      const id = await proposal(target);
      const done = stored(id);
      expect(done?.output?.warnings).toEqual(
        expect.arrayContaining([
          { code: 'USED_DRAFT_INPUTS', params: { input: 'DFD' } },
          { code: 'MISSING_PRICE_RESEARCH' },
        ]),
      );
      expect(done?.inputRefs.find((ref) => ref.id === target.dfdId)).toMatchObject({
        kind: 'DOCUMENT_DRAFT',
      });
      expect(done?.groundingReplacements).toBeGreaterThan(0);
      const estimates = done?.output?.sections.find(
        (section) => section.sectionKey === 'ESTIMATES',
      );
      expect(JSON.stringify(estimates?.content)).not.toContain('99.999');
      expect(toConfirmLabels(estimates?.content)).toContain(VALUE_PENDING);
    });

    it('Orçamento sigiloso, mesmo com PROCESS_VIEW_CONFIDENTIAL_BUDGET: nenhum valor no contexto e BUDGET_CONFIDENTIAL_VALUES_OMITTED', async () => {
      const target = await background({ process: { isBudgetConfidential: true } });
      const id = await proposal(target);
      const sent = JSON.stringify(provider.calls[0]);
      expect(sent).not.toContain('R$');
      expect(sent).not.toContain('125.000');
      expect(sent).not.toContain('125000');
      expect(stored(id)?.output?.warnings).toContainEqual({
        code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED',
      });
      const estimates = stored(id)?.output?.sections.find(
        (section) => section.sectionKey === 'ESTIMATES',
      );
      expect(toConfirmLabels(estimates?.content)).toContain(VALUE_PENDING);
    });
  });

  describe('[Validação]', () => {
    it('Processo sem DFD não cancelado: 422 AI_PREREQUISITE_MISSING com meta.missing ["DFD"] e nenhuma geração', async () => {
      const target = await background({ dfd: 'NONE' });
      const before = aiRepositoryOf(api).all().length;
      const response = await requestDraft(target);
      expectProblem(response, 422, 'AI_PREREQUISITE_MISSING');
      expect(response.body).toMatchObject({ meta: { missing: ['DFD'] } });
      expect(aiRepositoryOf(api).all()).toHaveLength(before);

      const canceled = await background({ dfd: 'DRAFT' });
      documentRepositoryOf(api).seed({
        ...documentOf(canceled.dfdId ?? ''),
        status: 'CANCELED',
        singletonKey: null,
      });
      expectProblem(await requestDraft(canceled), 422, 'AI_PREREQUISITE_MISSING');
    });

    it('DFD cancelado entre o pedido e a execução: CANCELED/CANCELED_BY_POLICY sem chamar o provedor', async () => {
      const target = await background();
      const id = await requested(target);
      documentRepositoryOf(api).seed({
        ...documentOf(target.dfdId ?? ''),
        status: 'CANCELED',
        singletonKey: null,
      });
      await runAiJob(api, id);
      expect(stored(id)).toMatchObject({ status: 'CANCELED', errorCode: 'CANCELED_BY_POLICY' });
      expect(provider.calls).toHaveLength(0);
    });

    it('Resumo curto → 422 em needSummary; ETP em aprovação → 409 DOCUMENT_NOT_EDITABLE; substituição sem confirmação → 422 CONDITIONAL_REQUIRED', async () => {
      const target = await background();
      const problem = expectProblem(
        await requestDraft(target, {
          body: {
            targetModule: 'ETP',
            kind: 'DRAFT',
            documentId: target.documentId,
            needSummary: 'Computador',
          },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(problem)).toContain('needSummary');
      expectProblem(
        await requestDraft(target, {
          body: {
            targetModule: 'ETP',
            kind: 'DRAFT',
            documentId: target.documentId,
            instruction: 'x'.repeat(501),
          },
        }),
        422,
        'VALIDATION_ERROR',
      );

      seedSection(target.documentId, 'PROBLEM', filledSection('Texto da Carla'));
      const id = await proposal(target);
      const before = documentOf(target.documentId);
      const replace = expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['PROBLEM'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(replace)).toContain('CONDITIONAL_REQUIRED');
      expect(documentOf(target.documentId)).toEqual(before);

      documentRepositoryOf(api).seed({ ...documentOf(target.documentId), status: 'IN_REVIEW' });
      expectProblem(await requestDraft(target), 409, 'DOCUMENT_NOT_EDITABLE');
    });
  });

  describe('[Permissão]', () => {
    it('Sem AI_GENERATE → 403 PERMISSION_DENIED e access.denied; geração de outra pessoa → 403 AI_GENERATION_NOT_OWNED; IA desligada → 403 AI_DISABLED', async () => {
      const target = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: target.processId,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
      });
      const before = aiRepositoryOf(api).all().length;
      expectProblem(await requestDraft(target, { subject: BRUNO }), 403, 'PERMISSION_DENIED');
      expect(aiRepositoryOf(api).all()).toHaveLength(before);
      expect(provider.calls).toHaveLength(0);
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
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['NEED_DESCRIPTION'] },
          { subject: PAULA },
        ),
        403,
        'AI_GENERATION_NOT_OWNED',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');

      gate.decision = { allowed: false, code: 'AI_DISABLED' };
      expectProblem(await requestDraft(target), 403, 'AI_DISABLED');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('ETP e geração de outro tenant: 404 e nenhum contexto com dados do tenant B', async () => {
      const own = await background();
      const foreignProcess = await newProcess({ tenant: B, subject: 'sub-heitor' });
      const foreignDfd = await createDfd(foreignProcess.id, 'sub-heitor', B);
      const foreign = requestGeneration({
        id: newId(),
        tenantId: B,
        processId: foreignProcess.id,
        documentId: foreignDfd.documentId,
        targetModule: 'ETP',
        kind: 'DRAFT',
        action: null,
        sectionKey: null,
        baseRevision: null,
        needSummary: null,
        instruction: null,
        provider: 'fake',
        promptKey: 'draft.etp',
        promptVersion: '1.0.0',
        reservedTokens: 40_000,
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
      expectProblem(
        await requestDraft({ processId: own.processId, documentId: foreignDfd.documentId }),
        404,
        'NOT_FOUND',
      );
      // Processo de outro tenant: o 404 do próprio processo (RLS), sem revelar nada.
      const foreignTarget = expectProblem(
        await requestDraft({ processId: foreignProcess.id, documentId: foreignDfd.documentId }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(JSON.stringify(foreignTarget)).not.toContain(foreignProcess.title);
      await proposal(own);
      expect(JSON.stringify(provider.calls)).not.toContain(foreignProcess.title);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 202 + Idempotent-Replayed e uma geração; outra chave com geração ativa → 409 AI_GENERATION_IN_PROGRESS', async () => {
      const target = await background();
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

      const second = await requestDraft(target, { key: randomUUID() });
      expectProblem(second, 409, 'AI_GENERATION_IN_PROGRESS');
      expect(second.body).toMatchObject({ meta: { generationId: id } });
    });
  });

  describe('[Concorrência]', () => {
    it('ETP alterado entre a proposta e a aplicação: 412; seção preenchida por outra pessoa → 422 e o texto dela fica; segunda aplicação → 409', async () => {
      const target = await background();
      const id = await proposal(target);
      const opened = documentOf(target.documentId).version;
      // Outra pessoa preenche PROBLEM (nova versão do ETag).
      seedSection(target.documentId, 'PROBLEM', filledSection('Texto do outro usuário'));
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['PROBLEM'] },
          { ifMatch: `"${String(opened)}"` },
        ),
        412,
        'VERSION_CONFLICT',
      );
      const replace = expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['PROBLEM'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(replace)).toContain('CONDITIONAL_REQUIRED');
      expect(JSON.stringify(documentOf(target.documentId).draftContent.sections.PROBLEM)).toContain(
        'Texto do outro usuário',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');

      const once = await apply(target.documentId, { generationId: id, sectionKeys: ['OBJECTIVE'] });
      expectProblem(once, 422, 'VALIDATION_ERROR');
      const applied = await apply(target.documentId, {
        generationId: id,
        sectionKeys: ['NEED_DESCRIPTION'],
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['PCA_ALIGNMENT'] }),
        409,
        'AI_GENERATION_NOT_APPLICABLE',
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na aplicação: 503 DEPENDENCY_UNAVAILABLE, nenhuma seção alterada e a geração continua SUCCEEDED', async () => {
      const target = await background();
      const id = await proposal(target);
      const before = documentOf(target.documentId);
      transactions.down = true;
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['NEED_DESCRIPTION'] }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(documentOf(target.documentId)).toEqual(before);
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Falha de integração]', () => {
    it('Timeout nas 3 tentativas → FAILED/TIMEOUT com AiGenerationFailed; saída fora do esquema após o reparo → FAILED/OUTPUT_INVALID; o ETP não muda', async () => {
      const target = await background();
      const before = documentOf(target.documentId);
      provider.enqueue(
        { kind: 'error', error: 'TIMEOUT' },
        { kind: 'error', error: 'TIMEOUT' },
        { kind: 'error', error: 'TIMEOUT' },
      );
      const id = await requested(target);
      const { error } = await runAiJobWithRetries(api, id);
      expect(error).toBeNull();
      expect(stored(id)).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT', attempts: 3 });
      expect(eventsOf(id, 'AiGenerationFailed')[0]?.payload).toMatchObject({
        errorCode: 'TIMEOUT',
        requestedById: FAKE_USERS.lucia.id,
      });

      provider.enqueue(
        { kind: 'output', output: { secoes: [] } },
        { kind: 'output', output: { sections: [{ sectionKey: 'OUTRA', blocks: [] }] } },
      );
      const invalid = await requested(target);
      await runAiJob(api, invalid);
      expect(stored(invalid)).toMatchObject({ status: 'FAILED', errorCode: 'OUTPUT_INVALID' });
      expect(documentOf(target.documentId)).toEqual(before);
    });

    it('Relay do outbox indisponível: a aplicação responde 200 e AiContentApplied fica pendente no outbox', async () => {
      const target = await background();
      const id = await proposal(target);
      const applied = await apply(target.documentId, {
        generationId: id,
        sectionKeys: ['NEED_DESCRIPTION'],
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      // Sem relay (modo em memória): o evento fica gravado no outbox até ser publicado.
      expect(eventsOf(target.documentId, 'AiContentApplied')).toHaveLength(1);
      expect(documentOf(target.documentId).draftContent.sections.NEED_DESCRIPTION?.state).toBe(
        'FILLED',
      );
    });
  });
});

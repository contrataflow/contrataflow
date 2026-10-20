import { randomUUID } from 'node:crypto';

import {
  aiGenerationSchema,
  documentAiApplyResultSchema,
  etpSchema,
  problemDetailsSchema,
  richTextFromPlainText,
  termSchema,
} from '@contrataflow/validation';
import type {
  AiGenerationDto,
  DocumentSnapshot,
  EtpDto,
  ProcessDto,
  RichTextNode,
  TermDto,
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
  TestAiGate,
  aiRepositoryOf,
  jobQueueOf,
  runAiJob,
  runAiJobWithRetries,
  seedRisk,
} from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  DOCUMENT_TRANSACTIONS,
  buildDocument,
  buildVersion,
  documentItemRepositoryOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  filledSection,
} from '../../../../test/support/document-fixtures.js';
import type { DocumentTransactions } from '../../../../test/support/document-fixtures.js';
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
import { termRepositoryOf } from '../../../../test/support/term-fixtures.js';
import { AiTenantGateRegistry } from '../application/ai-extension-points.js';
import { AI_PROVIDER } from '../application/ai-provider.port.js';
import { AI_SETTINGS } from '../application/ports.js';
import type { AiSettings } from '../application/ports.js';
import { requestGeneration } from '../domain/ai-generation.js';
import { BUDGET_PENDING, LOCATION_PENDING, VALUE_PENDING } from '../domain/term-draft-context.js';
import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from '../infrastructure/fake-ai.provider.js';

/*
 * US-120 — Gerar o rascunho do TR com IA a partir do ETP (AI-01 → job `ai-generation` → AI-02 →
 * DOC-26) pelo pipeline HTTP completo, com o gerador REAL `draft.tr` (contexto pelas fachadas de
 * `document`, `term`, `etp`, `risk`, `price-research`, `process`, `catalog` e `organization`), o
 * `FakeAiProvider` com a fixture `draft.tr/padrao` (nenhuma chamada real) e os adaptadores em
 * memória. O portão do órgão é o de teste (US-116 tem a suíte própria). Notificações
 * `AI_GENERATION_READY/FAILED`: o worker as deriva de `AiGenerationCompleted/Failed`
 * (`apps/worker/src/notifications/notification-rules.spec.ts`); aqui conferimos o evento. RLS em
 * PostgreSQL: `test/tenant-leak/ai-term-draft.spec.ts`.
 *
 * Personas: "Carla" (PLANEJAMENTO, custódia do processo no TR) = Lúcia; "Bruno" (GESTOR_CONTRATO:
 * AI_GENERATE sem TERM_UPDATE) = Otávio; "Paula" (participante colaboradora, REQUISITANTE com
 * TERM_UPDATE) = Ana, que abre o processo.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';
const PAULA = 'sub-ana';
const UNITS_A = {
  organizationId: '0192d120-0000-7000-8000-0000000000a0',
  obras: '0192d120-0000-7000-8000-0000000000a1',
  manutencao: '0192d120-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d120-0000-7000-8000-0000000000a3',
  saude: '0192d120-0000-7000-8000-0000000000a4',
  posto: '0192d120-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d120-0000-7000-8000-0000000000b0',
  obras: '0192d120-0000-7000-8000-0000000000b1',
  manutencao: '0192d120-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d120-0000-7000-8000-0000000000b3',
  saude: '0192d120-0000-7000-8000-0000000000b4',
  posto: '0192d120-0000-7000-8000-0000000000b5',
};
/** As 15 seções do TR semeado (US-036), todas na fixture `draft.tr/padrao`. */
const PROPOSED = [
  'OBJECT',
  'JUSTIFICATION',
  'SPECIFICATIONS',
  'ACCEPTANCE_CRITERIA',
  'CONTRACTOR_OBLIGATIONS',
  'CONTRACTING_PARTY_OBLIGATIONS',
  'DEADLINES',
  'DELIVERY',
  'PAYMENT',
  'OVERSIGHT',
  'GUARANTEES',
  'SANCTIONS',
  'SELECTION_CRITERIA',
  'ESTIMATED_VALUE',
  'BUDGET_ADEQUACY',
];
const ETP_TEXT = 'Os laboratórios de informática operam com equipamentos obsoletos e sem suporte.';
const SPECIFICATION = 'Processador de 8 núcleos, 16 GB de memória e SSD de 512 GB.';
const RISK_TITLE = 'Atraso na entrega dos computadores';
const RISK_CAUSE = 'Causa interna sigilosa';

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
  readonly etpId: string;
}
type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Gerar o rascunho do TR com IA a partir do ETP (US-120)', () => {
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
  const words = () => randomUUID().replaceAll('-', '').slice(0, 10);

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
  const termRowOf = (id: string) =>
    termRepositoryOf(api)
      .snapshot()
      .find((row) => row.id === id);
  const itemRowsOf = (documentId: string) =>
    documentItemRepositoryOf(api)
      .snapshot()
      .filter((row) => row.documentId === documentId);
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

  /** Processo aberto por Ana com um item. */
  async function newProcess(
    options: { tenant?: string; subject?: string } = {},
  ): Promise<{ process: Process; processItemId: string | null }> {
    const tenant = options.tenant ?? A;
    const units = tenant === A ? UNITS_A : UNITS_B;
    const subject = options.subject ?? PAULA;
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
    if (tenant !== A) return { process: created, processItemId: null };
    const item = await auth(request(api.server).post(`/api/v1/processes/${id}/items`), PAULA)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description: 'Computador desktop', unitOfMeasureId: catalog.un });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    return { process: created, processItemId: (item.body as { data: { id: string } }).data.id };
  }

  /** Processo na etapa `stage`, sob custódia da Carla (Lúcia). */
  function toStage(process: Process, stage: string, fields: Partial<Process> = {}): Process {
    const current =
      processRepositoryOf(api)
        .allProcesses()
        .find((candidate) => candidate.id === process.id) ?? process;
    const stageId =
      workflowStagesOf(api, process.tenantId).find(
        (candidate) =>
          candidate.key === stage && candidate.workflowVersionId === process.workflowVersionId,
      )?.id ?? null;
    const moved: Process = {
      ...current,
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId,
      currentResponsibleId: FAKE_USERS.lucia.id,
      ...fields,
    };
    processRepositoryOf(api).replace(moved);
    return moved;
  }

  async function createEtp(processId: string) {
    const response = await auth(request(api.server).post(`/api/v1/processes/${processId}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return etpSchema.parse((response.body as { data: EtpDto }).data);
  }

  /** O ETP finalizado na versão 1, com a necessidade congelada na versão. */
  function finalizeEtp(etpId: string) {
    const document = documentOf(etpId);
    const version = buildVersion(document, {
      versionNumber: 1,
      reason: 'SUBMISSION',
      statusAtCreation: 'FINALIZED',
      content: {
        sections: { NEED_DESCRIPTION: filledSection(ETP_TEXT) },
      } as unknown as DocumentSnapshot,
    });
    documentRepositoryOf(api).seedVersion(version);
    documentRepositoryOf(api).seed({
      ...document,
      status: 'FINALIZED',
      currentVersionId: version.id,
      currentVersionNumber: 1,
    });
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

  async function addRisk(processId: string) {
    await seedRisk(
      api,
      {
        title: RISK_TITLE,
        description: 'Fornecedor sem estoque no prazo',
        categoryId: catalogItemId(api, A, 'RISK_CATEGORY', 'PRAZO'),
        phase: 'CONTRACT_MANAGEMENT',
        cause: RISK_CAUSE,
        consequence: 'Aulas suspensas',
        probability: 2,
        impact: 2,
        ownerId: FAKE_USERS.ana.id,
        ownerDepartmentId: null,
      },
      {
        id: newId(),
        tenantId: A,
        processId,
        code: 'R01',
        snapshot: {
          scale: { max: 5, probabilityLabels: [], impactLabels: [] },
          levelThresholds: [{ level: 'LOW', minScore: 1, maxScore: 25 }],
        },
        now: new Date(),
        userId: null,
      },
    );
  }

  /**
   * Background: processo "0012/2026" com o ETP finalizado (ou só em rascunho), pesquisa concluída
   * de R$ 125.000,00 (opcional), um risco (opcional) e o TR em DRAFT com o item especificado,
   * `contractDurationMonths` 12, `paymentTermDays` 30 e `deliveryLocation` vazio; Carla com custódia.
   */
  async function background(
    options: {
      etp?: 'FINALIZED' | 'DRAFT' | 'NONE';
      research?: boolean;
      risks?: boolean;
      process?: Partial<Process>;
    } = {},
  ): Promise<Target> {
    const { process: created, processItemId } = await newProcess();
    const studies = toStage(created, 'ESTUDOS_PRELIMINARES', options.process);
    const etp = options.etp === 'NONE' ? null : await createEtp(studies.id);
    if (etp !== null && options.etp !== 'DRAFT') finalizeEtp(etp.documentId);
    if (options.research !== false) seedResearch(studies);
    if (options.risks !== false) await addRisk(studies.id);
    const process = toStage(studies, 'TERMO_REFERENCIA');
    const created_ = await auth(request(api.server).post(`/api/v1/processes/${process.id}/terms`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created_.status, JSON.stringify(created_.body)).toBe(201);
    const term = termSchema.parse((created_.body as { data: TermDto }).data);
    const items = await auth(request(api.server).put(`/api/v1/documents/${term.documentId}/items`))
      .set('If-Match', `"${String(documentOf(term.documentId).version)}"`)
      .send({
        items: [
          {
            processItemId,
            quantity: '120',
            specification: richTextFromPlainText(SPECIFICATION),
            sortOrder: 0,
          },
        ],
      });
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    const conditions = await auth(request(api.server).patch(`/api/v1/terms/${term.id}`))
      .set('If-Match', `"${String(termRowOf(term.id)?.version ?? 1)}"`)
      .send({ contractDurationMonths: 12, paymentTermDays: 30 });
    expect(conditions.status, JSON.stringify(conditions.body)).toBe(200);
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.ana.id,
      role: 'COLLABORATOR',
    });
    return { processId: process.id, documentId: term.documentId, etpId: etp?.documentId ?? '' };
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
      .send(
        options.body ?? {
          targetModule: 'TERM_OF_REFERENCE',
          kind: 'DRAFT',
          documentId: target.documentId,
        },
      );

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

  const sectionOf = (id: string, key: string) =>
    stored(id)?.output?.sections.find((section) => section.sectionKey === key);

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
      roleId: roles.get('GESTOR_CONTRATO')?.id ?? '',
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

  afterEach(async () => {
    api.rateLimitStore.reset();
    transactions.down = false;
    jobQueueOf(api).down = false;
    gate.decision = { allowed: true };
    await api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE).recordSuccess();
  });

  describe('[Sucesso]', () => {
    it('Gerar o rascunho a partir do ETP: 202 QUEUED draft.tr e, no worker, SUCCEEDED com inputRefs do ETP, pesquisa, itens e condições; o TR não muda', async () => {
      const target = await background();
      const before = documentOf(target.documentId);
      const termBefore = termRowOf(target.documentId);
      const response = await requestDraft(target, { key: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const body = response.body as { data: AiGenerationDto; meta: { pollAfterMs: number } };
      const generation = aiGenerationSchema.parse(body.data);
      expect(generation).toMatchObject({
        status: 'QUEUED',
        targetModule: 'TERM_OF_REFERENCE',
        kind: 'DRAFT',
        documentId: target.documentId,
        promptKey: 'draft.tr',
        promptVersion: '1.0.0',
      });
      expect(response.headers.location).toBe(`/api/v1/ai-generations/${generation.id}`);
      expect(body.meta.pollAfterMs).toBeGreaterThan(0);
      expect(stored(generation.id)).toMatchObject({ reservedTokens: 40_000 });
      expect(auditOf('ai.generation_request', generation.id)[0]?.metadata).toMatchObject({
        promptKey: 'draft.tr',
        targetModule: 'TERM_OF_REFERENCE',
        kind: 'DRAFT',
      });
      expect(eventsOf(generation.id, 'AiGenerationRequested')).toHaveLength(1);
      expect(provider.calls).toHaveLength(0);

      await expect(runAiJob(api, generation.id)).resolves.toBe('completed');
      const done = stored(generation.id);
      expect(done?.status).toBe('SUCCEEDED');
      expect(done?.output?.sections.map((section) => section.sectionKey)).toEqual(PROPOSED);
      const refs = done?.inputRefs ?? [];
      expect(refs.find((ref) => ref.id === target.etpId)).toMatchObject({
        kind: 'DOCUMENT_VERSION',
        documentTypeCode: 'ETP',
        versionNumber: 1,
      });
      expect(refs.map((ref) => ref.kind)).toEqual(
        expect.arrayContaining(['PRICE_RESEARCH', 'PROCESS_ITEMS', 'TERM_CONDITIONS', 'RISKS']),
      );
      expect(refs.every((ref) => /^[0-9a-f]{64}$/.test(ref.contentHash))).toBe(true);
      // Sem DFD no processo: entrada opcional ausente.
      expect(done?.output?.warnings).toEqual([
        { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'DFD' } },
      ]);

      // O contexto: ETP finalizado, especificação, condições, risco sem pessoas e o valor da pesquisa.
      const sent = JSON.stringify(provider.calls[0]?.messages);
      expect(sent).toContain(ETP_TEXT);
      expect(sent).toContain(SPECIFICATION);
      expect(sent).toContain('12 meses');
      expect(sent).toContain('30 dias');
      expect(sent).toContain(RISK_TITLE);
      expect(sent).not.toContain(RISK_CAUSE);
      expect(sent).not.toContain(FAKE_USERS.ana.id);
      expect(sent).toContain('R$ 125.000,00');
      expect(provider.calls[0]?.metadata.promptKey).toBe('draft.tr');

      expect(eventsOf(generation.id, 'AiGenerationCompleted')[0]?.payload).toMatchObject({
        requestedById: FAKE_USERS.lucia.id,
        promptKey: 'draft.tr',
        sectionsCount: PROPOSED.length,
      });
      // A geração nunca altera o TR.
      expect(documentOf(target.documentId)).toEqual(before);
      expect(termRowOf(target.documentId)).toEqual(termBefore);
    });

    it('Prazos e pagamento só dos campos tipados e sanções sem percentual inventado: aplicar tudo não toca condições nem itens', async () => {
      const target = await background();
      provider.enqueue({
        kind: 'output',
        output: {
          sections: PROPOSED.map((sectionKey) => ({
            sectionKey,
            blocks: [
              {
                type: 'paragraph',
                text:
                  sectionKey === 'SANCTIONS'
                    ? 'Aplica-se multa de 20% sobre o valor do contrato, nos termos do art. 156 da Lei 14.133/2021.'
                    : sectionKey === 'DEADLINES'
                      ? 'O contrato terá vigência de 12 meses.'
                      : sectionKey === 'PAYMENT'
                        ? 'O pagamento será feito em até 30 dias após o atesto.'
                        : 'Texto proposto para a seção.',
              },
            ],
          })),
        },
      });
      const id = await proposal(target);
      const termBefore = termRowOf(target.documentId);
      const itemsBefore = itemRowsOf(target.documentId);
      const response = await apply(target.documentId, { generationId: id, sectionKeys: PROPOSED });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = documentAiApplyResultSchema.parse((response.body as { data: unknown }).data);
      expect(result.appliedSectionKeys).toEqual(PROPOSED);
      expect(result.versionCreated).toBeNull();

      const sections = documentOf(target.documentId).draftContent.sections;
      expect(JSON.stringify(sections.DEADLINES?.content)).toContain('12 meses');
      expect(JSON.stringify(sections.PAYMENT?.content)).toContain('30 dias');
      expect(toConfirmLabels(sections.DELIVERY?.content)).toContain(LOCATION_PENDING);
      const sanctions = JSON.stringify(sections.SANCTIONS?.content);
      expect(sanctions).not.toContain('20%');
      expect(sanctions).toContain('art. 156 da Lei 14.133/2021');
      expect(toConfirmLabels(sections.SANCTIONS?.content)).toHaveLength(1);
      expect(sectionOf(id, 'SANCTIONS')?.groundingReplacements).toBeGreaterThan(0);
      expect(toConfirmLabels(sections.BUDGET_ADEQUACY?.content)).toContain(BUDGET_PENDING);
      // Com a pesquisa concluída, o valor estimado não fica pendente.
      expect(toConfirmLabels(sections.ESTIMATED_VALUE?.content)).not.toContain(VALUE_PENDING);
      for (const key of PROPOSED) {
        expect(sections[key]).toMatchObject({
          state: 'FILLED',
          ai: { generationId: id, appliedById: FAKE_USERS.lucia.id, reviewedAt: null },
        });
      }
      // RN-AI-44: condições tipadas e itens intactos.
      expect(termRowOf(target.documentId)).toEqual(termBefore);
      expect(termRowOf(target.documentId)).toMatchObject({
        contractDurationMonths: 12,
        paymentTermDays: 30,
        deliveryLocation: null,
      });
      expect(itemRowsOf(target.documentId)).toEqual(itemsBefore);
      expect(stored(id)).toMatchObject({ status: 'APPLIED' });
      expect(auditOf('ai.content_apply', target.documentId)[0]?.metadata).toMatchObject({
        generationId: id,
        promptKey: 'draft.tr',
        replacedFilledSections: 0,
      });
      const [event] = eventsOf(target.documentId, 'AiContentApplied');
      expect(event?.routingKey).toBe('document.ai_content_applied.tr');
      expect(event?.payload).toMatchObject({
        targetModule: 'TERM_OF_REFERENCE',
        sectionKeys: PROPOSED,
      });
    });

    it('Convivência com a importação do ETP: seções importadas FILLED ficam; aplicar só as EMPTY; substituir com confirmação cria a versão SYSTEM', async () => {
      const target = await background();
      seedSection(target.documentId, 'OBJECT', filledSection('Objeto importado do ETP'));
      seedSection(target.documentId, 'JUSTIFICATION', filledSection('Justificativa importada'));
      const id = await proposal(target);
      expect(sectionOf(id, 'OBJECT')).toBeDefined();
      const empty = PROPOSED.filter((key) => key !== 'OBJECT' && key !== 'JUSTIFICATION');
      const response = await apply(target.documentId, { generationId: id, sectionKeys: empty });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const sections = documentOf(target.documentId).draftContent.sections;
      expect(JSON.stringify(sections.OBJECT)).toContain('Objeto importado do ETP');
      expect(JSON.stringify(sections.JUSTIFICATION)).toContain('Justificativa importada');
      expect(documentRepositoryOf(api).versionsOf(target.documentId)).toHaveLength(0);

      // A substituição da seção importada: nova proposta e confirmação explícita.
      const again = await proposal(target);
      const replaced = await apply(target.documentId, {
        generationId: again,
        sectionKeys: ['OBJECT'],
        confirmReplaceFilled: true,
      });
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
      const [version] = documentRepositoryOf(api).versionsOf(target.documentId);
      expect(version).toMatchObject({ reason: 'SYSTEM' });
      expect(JSON.stringify(version?.content)).toContain('Objeto importado do ETP');
      expect(eventsOf(target.documentId, 'AiContentApplied').at(-1)?.payload).toMatchObject({
        replacedFilledSections: 1,
      });
    });

    it('Orçamento sigiloso, sem riscos e ETP em DRAFT: BUDGET_CONFIDENTIAL_VALUES_OMITTED, MISSING_OPTIONAL_INPUT e USED_DRAFT_INPUTS, sem valores no contexto', async () => {
      const target = await background({
        etp: 'DRAFT',
        risks: false,
        process: { isBudgetConfidential: true },
      });
      const id = await proposal(target);
      expect(stored(id)?.output?.warnings).toEqual(
        expect.arrayContaining([
          { code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' },
          { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'RISKS' } },
          { code: 'USED_DRAFT_INPUTS', params: { input: 'ETP' } },
        ]),
      );
      expect(stored(id)?.inputRefs.find((ref) => ref.id === target.etpId)).toMatchObject({
        kind: 'DOCUMENT_DRAFT',
      });
      const sent = JSON.stringify(provider.calls[0]);
      expect(sent).not.toContain('R$');
      expect(sent).not.toContain('125.000');
      expect(sent).not.toContain('125000');
      expect(toConfirmLabels(sectionOf(id, 'ESTIMATED_VALUE')?.content)).toContain(VALUE_PENDING);
    });

    it('Sem pesquisa de preços concluída: ESTIMATED_VALUE com [a confirmar: valor estimado da pesquisa de preços] e MISSING_PRICE_RESEARCH; valor inventado vira [a confirmar]', async () => {
      const target = await background({ research: false });
      provider.enqueue({
        kind: 'output',
        output: {
          sections: PROPOSED.map((sectionKey) => ({
            sectionKey,
            blocks: [
              {
                type: 'paragraph',
                text:
                  sectionKey === 'ESTIMATED_VALUE'
                    ? 'O valor estimado é de R$ 99.999,00.'
                    : 'Texto proposto para a seção.',
              },
            ],
          })),
        },
      });
      const id = await proposal(target);
      expect(stored(id)?.output?.warnings).toContainEqual({ code: 'MISSING_PRICE_RESEARCH' });
      const estimated = sectionOf(id, 'ESTIMATED_VALUE');
      expect(JSON.stringify(estimated?.content)).not.toContain('99.999');
      expect(toConfirmLabels(estimated?.content)).toContain(VALUE_PENDING);
    });
  });

  describe('[Validação]', () => {
    it('Processo sem ETP não cancelado: 422 AI_PREREQUISITE_MISSING com meta.missing ["ETP"] e nenhuma geração', async () => {
      const target = await background({ etp: 'NONE' });
      const before = aiRepositoryOf(api).all().length;
      const response = await requestDraft(target);
      expectProblem(response, 422, 'AI_PREREQUISITE_MISSING');
      expect(response.body).toMatchObject({ meta: { missing: ['ETP'] } });
      expect(aiRepositoryOf(api).all()).toHaveLength(before);

      const canceled = await background({ etp: 'DRAFT' });
      documentRepositoryOf(api).seed({
        ...documentOf(canceled.etpId),
        status: 'CANCELED',
        singletonKey: null,
      });
      expectProblem(await requestDraft(canceled), 422, 'AI_PREREQUISITE_MISSING');
    });

    it('ETP cancelado entre o pedido e a execução: CANCELED/CANCELED_BY_POLICY sem chamar o provedor', async () => {
      const target = await background();
      const id = await requested(target);
      documentRepositoryOf(api).seed({
        ...documentOf(target.etpId),
        status: 'CANCELED',
        singletonKey: null,
      });
      await runAiJob(api, id);
      expect(stored(id)).toMatchObject({ status: 'CANCELED', errorCode: 'CANCELED_BY_POLICY' });
      expect(provider.calls).toHaveLength(0);
    });

    it('Orientação longa ou documento que não é o TR → 422; TR em IN_REVIEW → 409; seção FILLED sem confirmação → 422 CONDITIONAL_REQUIRED', async () => {
      const target = await background();
      expectProblem(
        await requestDraft(target, {
          body: {
            targetModule: 'TERM_OF_REFERENCE',
            kind: 'DRAFT',
            documentId: target.documentId,
            instruction: 'x'.repeat(501),
          },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await requestDraft({ processId: target.processId, documentId: target.etpId }),
        422,
        'VALIDATION_ERROR',
      );

      documentRepositoryOf(api).seed({ ...documentOf(target.documentId), status: 'IN_REVIEW' });
      expectProblem(await requestDraft(target), 409, 'DOCUMENT_NOT_EDITABLE');

      documentRepositoryOf(api).seed({ ...documentOf(target.documentId), status: 'DRAFT' });
      seedSection(target.documentId, 'OBJECT', filledSection('Texto da Carla'));
      const id = await proposal(target);
      const before = documentOf(target.documentId);
      const replace = expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['OBJECT'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(replace)).toContain('CONDITIONAL_REQUIRED');
      expect(documentOf(target.documentId)).toEqual(before);
    });
  });

  describe('[Permissão]', () => {
    it('AI_GENERATE sem TERM_UPDATE → 403 PERMISSION_DENIED e access.denied sem chamar o provedor; geração de outra pessoa → 403 AI_GENERATION_NOT_OWNED; IA desligada → 403 AI_DISABLED', async () => {
      const target = await background();
      // Bruno não participa do processo: a participação de colaborador concederia o TERM_UPDATE.
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
              row.reasonCode === 'TERM_UPDATE',
          ),
      ).toBe(true);

      const id = await proposal(target);
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['OBJECT'] },
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
    it('TR e geração de outro tenant: 404 e nenhum contexto com dados do tenant B', async () => {
      const own = await background();
      const { process: foreignProcess } = await newProcess({ tenant: B, subject: 'sub-heitor' });
      const foreignDocument = newId();
      const foreign = requestGeneration({
        id: newId(),
        tenantId: B,
        processId: foreignProcess.id,
        documentId: foreignDocument,
        targetModule: 'TERM_OF_REFERENCE',
        kind: 'DRAFT',
        action: null,
        sectionKey: null,
        baseRevision: null,
        needSummary: null,
        instruction: null,
        provider: 'fake',
        promptKey: 'draft.tr',
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
      // O TR de outro tenant (inexistente para A — RLS): 404 sem revelar nada.
      expectProblem(
        await requestDraft({ processId: own.processId, documentId: foreignDocument }),
        404,
        'NOT_FOUND',
      );
      const foreignTarget = expectProblem(
        await requestDraft({ processId: foreignProcess.id, documentId: foreignDocument }),
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
    it('Importação do ETP entre a proposta e a aplicação → 412; PAYMENT preenchida por outra pessoa → 422 e o texto dela fica; duas aplicações → uma 200 e outra 409', async () => {
      const target = await background();
      const id = await proposal(target);
      const opened = documentOf(target.documentId).version;
      // Outra pessoa importa do ETP (nova versão do ETag) e preenche PAYMENT.
      seedSection(
        target.documentId,
        'PAYMENT',
        filledSection('Pagamento definido pelo outro usuário'),
      );
      expectProblem(
        await apply(
          target.documentId,
          { generationId: id, sectionKeys: ['PAYMENT'] },
          { ifMatch: `"${String(opened)}"` },
        ),
        412,
        'VERSION_CONFLICT',
      );
      const replace = expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['PAYMENT'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(replace)).toContain('CONDITIONAL_REQUIRED');
      expect(JSON.stringify(documentOf(target.documentId).draftContent.sections.PAYMENT)).toContain(
        'Pagamento definido pelo outro usuário',
      );
      expect(stored(id)?.status).toBe('SUCCEEDED');

      const version = `"${String(documentOf(target.documentId).version)}"`;
      const [first, second] = await Promise.all([
        apply(
          target.documentId,
          { generationId: id, sectionKeys: ['OBJECT'] },
          { ifMatch: version },
        ),
        apply(
          target.documentId,
          { generationId: id, sectionKeys: ['DEADLINES'] },
          { ifMatch: version },
        ),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses[0]).toBe(200);
      expect([409, 412]).toContain(statuses[1]);
      expectProblem(
        await apply(target.documentId, { generationId: id, sectionKeys: ['OVERSIGHT'] }),
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
        await apply(target.documentId, { generationId: id, sectionKeys: ['OBJECT'] }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(documentOf(target.documentId)).toEqual(before);
      expect(stored(id)?.status).toBe('SUCCEEDED');
    });
  });

  describe('[Falha de integração]', () => {
    it('429 e depois sucesso → SUCCEEDED com attempts 2; 503 nas 3 tentativas → FAILED/PROVIDER_UNAVAILABLE com AiGenerationFailed; saída inválida após o reparo → OUTPUT_INVALID; o TR não muda', async () => {
      const target = await background();
      const before = documentOf(target.documentId);
      provider.enqueue({ kind: 'error', error: 'RATE_LIMITED' });
      const retried = await requested(target);
      const first = await runAiJobWithRetries(api, retried);
      expect(first.error).toBeNull();
      expect(stored(retried)).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
      await apply(target.documentId, { generationId: retried, sectionKeys: ['OBJECT'] }).then(
        (response) => {
          expect(response.status).toBe(200);
        },
      );
      const afterApply = documentOf(target.documentId);

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
      expect(eventsOf(id, 'AiGenerationFailed')[0]?.payload).toMatchObject({
        errorCode: 'PROVIDER_UNAVAILABLE',
        requestedById: FAKE_USERS.lucia.id,
      });
      await api.app.get<AiCircuitStorePort>(AI_CIRCUIT_STORE).recordSuccess();

      provider.enqueue(
        { kind: 'output', output: { secoes: [] } },
        { kind: 'output', output: { sections: [{ sectionKey: 'OUTRA', blocks: [] }] } },
      );
      const invalid = await requested(target);
      await runAiJob(api, invalid);
      expect(stored(invalid)).toMatchObject({ status: 'FAILED', errorCode: 'OUTPUT_INVALID' });
      expect(documentOf(target.documentId)).toEqual(afterApply);
      expect(before.draftContent.sections.OBJECT).not.toEqual(
        afterApply.draftContent.sections.OBJECT,
      );
    });

    it('Relay do outbox indisponível: a aplicação responde 200 e AiContentApplied fica pendente no outbox', async () => {
      const target = await background();
      const id = await proposal(target);
      const applied = await apply(target.documentId, { generationId: id, sectionKeys: ['OBJECT'] });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      // Sem relay (modo em memória): o evento fica gravado no outbox até ser publicado.
      expect(eventsOf(target.documentId, 'AiContentApplied')).toHaveLength(1);
      expect(documentOf(target.documentId).draftContent.sections.OBJECT?.state).toBe('FILLED');
    });
  });
});

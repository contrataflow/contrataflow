import { randomUUID } from 'node:crypto';

import {
  documentSchema,
  problemDetailsSchema,
  riskMatrixSchema,
  riskSchema,
} from '@contrataflow/validation';
import type {
  DocumentDto,
  ProcessDto,
  RiskDto,
  RiskMatrixDto,
  RiskTreatmentDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  DOCUMENT_TRANSACTIONS,
  documentRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import type { DocumentTransactions } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
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
import { RISK_CLOCK, RISK_TRANSACTIONS } from '../application/ports.js';
import type { RiskTransactions } from '../application/ports.js';

/*
 * US-035 — RSK-09 (matriz) e RSK-10 (emitir o Mapa de Riscos) pelo pipeline HTTP completo, e o
 * ciclo de vida do `RISK_MAP` pelos endpoints genéricos de documento (DOC-05/08/10/12 da US-065)
 * com o `RiskMapDocumentValidator` registrado. As 8 categorias do Gherkin. Ana (REQUISITANTE +
 * GESTOR_CONTRATACOES: RISK_MANAGE, RISK_MAP_SUBMIT e DOCUMENT_REOPEN) é a responsável; Otávio
 * (SOMENTE_LEITURA) vê o processo e, como participante COLLABORATOR, ganha RISK_MANAGE mas não
 * RISK_MAP_SUBMIT ("Bruno" do cenário); Heitor só tem vínculo com a Prefeitura B. RLS e PENDING no
 * PostgreSQL: `test/tenant-leak/risk-map.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-18T15:00:00.000Z');

const UNITS_A = {
  organizationId: '0192d035-0000-7000-8000-0000000000a0',
  obras: '0192d035-0000-7000-8000-0000000000a1',
  manutencao: '0192d035-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d035-0000-7000-8000-0000000000a3',
  saude: '0192d035-0000-7000-8000-0000000000a4',
  posto: '0192d035-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d035-0000-7000-8000-0000000000b0',
  obras: '0192d035-0000-7000-8000-0000000000b1',
  manutencao: '0192d035-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d035-0000-7000-8000-0000000000b3',
  saude: '0192d035-0000-7000-8000-0000000000b4',
  posto: '0192d035-0000-7000-8000-0000000000b5',
};

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements RiskTransactions, DocumentTransactions {
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

describe('Feature: Visualizar matriz de riscos e emitir o Mapa de Riscos (US-035)', () => {
  let api: TestApi;
  const riskTransactions = new FlakyTransactions();
  const documentTransactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; market: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const matrix = (processId: string, query = '', subject = 'sub-ana', tenant: string = A) =>
    auth(
      request(api.server).get(`/api/v1/processes/${processId}/risk-matrix${query}`),
      subject,
      tenant,
    );
  const emit = (
    processId: string,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/risk-map`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({});
  const finalize = (documentId: string, ifMatch = '"1"', subject = 'sub-ana') =>
    auth(request(api.server).post(`/api/v1/documents/${documentId}/finalize`), subject)
      .set('If-Match', ifMatch)
      .set('Idempotency-Key', randomUUID())
      .send({});
  const reopen = (documentId: string, ifMatch: string) =>
    auth(request(api.server).post(`/api/v1/documents/${documentId}/reopen`))
      .set('If-Match', ifMatch)
      .send({ reopenReason: 'Inclusão de novo risco identificado na revisão do ETP' });
  const validation = (documentId: string) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/validation`));
  const patchRisk = (riskId: string, version: number, body: Record<string, unknown>) =>
    auth(request(api.server).patch(`/api/v1/risks/${riskId}`))
      .set('If-Match', `"${String(version)}"`)
      .send(body);

  const stored = (documentId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .find((document) => document.id === documentId);
  const versionsOf = (documentId: string) => documentRepositoryOf(api).versionsOf(documentId);
  const eventsOf = (documentId: string) =>
    api.outboxRows().filter((row) => row.aggregateId === documentId);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);

  /** Processo pelo PRC-02 (Ana responsável) na etapa "ETP e mapa de riscos", em andamento. */
  async function newProcess(): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição ${words(2)}`,
        object: `Objeto da contratação ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    const stage = workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === 'ESTUDOS_PRELIMINARES' &&
        candidate.workflowVersionId === created.workflowVersionId,
    );
    const process: Process = {
      ...created,
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stage?.id ?? created.currentWorkflowStageId,
    };
    processRepositoryOf(api).replace(process);
    return process;
  }

  async function addRisk(
    processId: string,
    probability: number,
    impact: number,
    title = 'Fornecedores insuficientes',
  ): Promise<RiskDto> {
    const response = await auth(request(api.server).post(`/api/v1/processes/${processId}/risks`))
      .set('Idempotency-Key', randomUUID())
      .send({
        title,
        categoryId: catalog.market,
        phase: 'PLANNING',
        cause: 'Mercado local com poucos fornecedores habilitados',
        consequence: 'Licitação deserta e atraso na contratação',
        probability,
        impact,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return riskSchema.parse(data<RiskDto>(response));
  }

  async function addTreatment(riskId: string): Promise<RiskTreatmentDto> {
    const response = await auth(request(api.server).post(`/api/v1/risks/${riskId}/treatments`))
      .set('Idempotency-Key', randomUUID())
      .send({
        type: 'PREVENTIVE',
        description: 'Ampliar a divulgação do edital em jornais regionais',
        responsibleId: FAKE_USERS.ana.id,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<RiskTreatmentDto>(response);
  }

  async function emitOk(processId: string): Promise<DocumentDto> {
    const response = await emit(processId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return documentSchema.parse(data<DocumentDto>(response));
  }

  /** Seções narrativas obrigatórias do template padrão (US-110) preenchidas por DOC-05. */
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

  /** Processo com R01 (4×4, tratado) e R02 (1×1) e o Mapa de Riscos em DRAFT, pronto para finalizar. */
  async function readyRiskMap() {
    const process = await newProcess();
    const r01 = await addRisk(process.id, 4, 4);
    await addTreatment(r01.id);
    const r02 = await addRisk(process.id, 1, 1, 'Atraso na entrega da documentação');
    const document = await emitOk(process.id);
    await fillNarrative(document.id);
    return { process, r01, r02, document };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: RISK_TRANSACTIONS, value: riskTransactions },
        { token: DOCUMENT_TRANSACTIONS, value: documentTransactions },
        { token: RISK_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary']);
    await runTenantSeeders(api, B, [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary']);
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
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    riskTransactions.down = false;
    documentTransactions.down = false;
  });

  describe('[Sucesso]', () => {
    it('Visualizar a matriz com riscos distribuídos: R01 em 4×4 (HIGH) e R02 em 1×1 (LOW)', async () => {
      const process = await newProcess();
      const r01 = await addRisk(process.id, 4, 4);
      const r02 = await addRisk(process.id, 1, 1, 'Atraso na entrega da documentação');
      const response = await matrix(process.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const grid = riskMatrixSchema.parse(data<RiskMatrixDto>(response));
      expect(grid.scale.max).toBe(5);
      expect(grid.cells).toHaveLength(25);
      const cell = (p: number, i: number) =>
        grid.cells.find((candidate) => candidate.probability === p && candidate.impact === i);
      expect(cell(4, 4)).toEqual({
        probability: 4,
        impact: 4,
        score: 16,
        level: 'HIGH',
        risks: [{ id: r01.id, code: 'R01', title: 'Fornecedores insuficientes' }],
      });
      expect(cell(1, 1)).toMatchObject({
        level: 'LOW',
        risks: [{ id: r02.id, code: 'R02' }],
      });
      expect(grid.cells.filter((candidate) => candidate.risks.length > 0)).toHaveLength(2);
    });

    it('Filtros de RSK-09 (fase, status, categoria) recortam a matriz; filtro inválido = 422', async () => {
      const process = await newProcess();
      const r01 = await addRisk(process.id, 4, 4);
      await addTreatment(r01.id); // R01 → IN_TREATMENT
      await addRisk(process.id, 2, 3, 'Atraso na entrega da documentação');
      const occupied = async (query: string) =>
        riskMatrixSchema
          .parse(data<RiskMatrixDto>(await matrix(process.id, query)))
          .cells.flatMap((cell) => cell.risks.map((item) => item.code));
      expect(await occupied('?status=OPEN')).toEqual(['R02']);
      expect(await occupied('?status=IN_TREATMENT')).toEqual(['R01']);
      expect(await occupied('?phase=SELECTION')).toEqual([]);
      expect(await occupied(`?categoryId=${catalog.market}`)).toEqual(['R01', 'R02']);
      expectProblem(await matrix(process.id, '?phase=OUTRA'), 422, 'VALIDATION_ERROR');
    });

    it('Emitir e finalizar o Mapa de Riscos: FINALIZED, versão com o snapshot, DocumentFinalized e document.finalize', async () => {
      const process = await newProcess();
      const r01 = await addRisk(process.id, 4, 4);
      const treatment = await addTreatment(r01.id);
      await addRisk(process.id, 1, 1, 'Atraso na entrega da documentação');

      const response = await emit(process.id);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const document = documentSchema.parse(data<DocumentDto>(response));
      expect(response.headers.location).toBe(`/api/v1/documents/${document.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(document).toMatchObject({
        processId: process.id,
        title: 'Mapa de Riscos',
        status: 'DRAFT',
        currentVersionId: null,
        documentType: { code: 'RISK_MAP', kind: 'STRUCTURED', requiresApproval: false },
      });
      expect(document.code).toMatch(/^MR \d{4}\/\d{4}$/);
      expect((response.body as { meta: { allowedActions: string[] } }).meta.allowedActions).toEqual(
        expect.arrayContaining(['FINALIZE']),
      );
      // RN-RISK-20: nada congelado na criação.
      expect(versionsOf(document.id)).toEqual([]);
      expect(auditOf(process.id, 'document.create')).toMatchObject([
        { entityId: document.id, metadata: { documentTypeCode: 'RISK_MAP' } },
      ]);
      expect(eventsOf(document.id)).toMatchObject([
        {
          eventType: 'DocumentCreated',
          routingKey: 'document.created.risk_map',
          payload: { documentId: document.id, documentTypeCode: 'RISK_MAP', kind: 'STRUCTURED' },
        },
      ]);
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type === 'DOCUMENT_CREATED',
        ),
      ).toHaveLength(1);

      // RSK-01 passa a apontar o documento; os riscos seguem editáveis em DRAFT.
      const list = await auth(request(api.server).get(`/api/v1/processes/${process.id}/risks`));
      expect((list.body as { meta: Record<string, unknown> }).meta).toMatchObject({
        riskMap: { id: document.id, status: 'DRAFT' },
        canManage: true,
      });

      // DOC-08 sem pendências específicas de risco (R01 tem tratamento).
      await fillNarrative(document.id);
      const check = await validation(document.id);
      expect(check.status, JSON.stringify(check.body)).toBe(200);
      expect(data<{ violations: { code: string }[] }>(check).violations.map((v) => v.code)).toEqual(
        [],
      );

      const finalized = await finalize(document.id);
      expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
      expect(data<DocumentDto>(finalized)).toMatchObject({
        status: 'FINALIZED',
        finalizedById: FAKE_USERS.ana.id,
      });
      expect(stored(document.id)?.status).toBe('FINALIZED');

      const [version] = versionsOf(document.id);
      expect(versionsOf(document.id)).toHaveLength(1);
      expect(version).toMatchObject({ reason: 'FINALIZATION', versionNumber: 1 });
      expect(version?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(version?.content?.header).toMatchObject({
        riskCount: 2,
        treatmentCount: 1,
        scaleMax: 5,
        byLevel: { LOW: 1, MEDIUM: 0, HIGH: 1, EXTREME: 0 },
      });
      expect(version?.content?.collections.risks).toEqual([
        expect.objectContaining({ riskId: r01.id, code: 'R01', score: 16, level: 'Alto' }),
        expect.objectContaining({ code: 'R02', score: 1, level: 'Baixo' }),
      ]);
      expect(version?.content?.collections.treatments).toEqual([
        expect.objectContaining({
          treatmentId: treatment.id,
          riskCode: 'R01',
          type: 'Prevenção',
          status: 'Planejada',
          responsible: 'Ana Souza',
        }),
      ]);
      expect(version?.content?.collections.matrix).toEqual([
        { probability: 4, impact: 4, score: 16, level: 'Alto', risks: 'R01' },
        { probability: 1, impact: 1, score: 1, level: 'Baixo', risks: 'R02' },
      ]);

      expect(eventsOf(document.id).map((row) => row.routingKey)).toEqual([
        'document.created.risk_map',
        'document.version_created.risk_map',
        'document.finalized.risk_map',
      ]);
      expect(eventsOf(document.id).at(-1)).toMatchObject({
        eventType: 'DocumentFinalized',
        payload: {
          documentId: document.id,
          documentVersionId: version?.id,
          typedSummary: { riskCount: 2, treatmentCount: 1 },
        },
      });
      const [audit] = auditOf(process.id, 'document.finalize');
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        entityId: document.id,
        metadata: {
          documentVersionId: version?.id,
          documentTypeCode: 'RISK_MAP',
          typedSummary: { riskCount: 2 },
        },
      });
    });

    it('RN-RISK-23: riscos bloqueados após a finalização e liberados pela reabertura (DOC-12)', async () => {
      const { r02, document } = await readyRiskMap();
      const done = await finalize(document.id);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const finalizedVersion = data<DocumentDto>(done).version;

      const locked = expectProblem(
        await patchRisk(r02.id, r02.version, { title: 'Atraso na entrega dos documentos' }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(locked.detail).toBe(
        'Os riscos estão bloqueados porque o Mapa de Riscos foi concluído. Reabra o documento para editar.',
      );
      // RN-RISK-24: a matriz segue disponível, lendo os riscos atuais.
      expect((await matrix(document.processId)).status).toBe(200);

      const reopened = await reopen(document.id, `"${String(finalizedVersion)}"`);
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
      expect(data<DocumentDto>(reopened).status).toBe('DRAFT');
      expect(eventsOf(document.id).at(-1)).toMatchObject({
        eventType: 'DocumentReopened',
        routingKey: 'document.reopened.risk_map',
        payload: { fromStatus: 'FINALIZED', baseVersionId: versionsOf(document.id)[0]?.id },
      });
      const edited = await patchRisk(r02.id, r02.version, {
        title: 'Atraso na entrega dos documentos',
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    });
  });

  describe('[Validação]', () => {
    it('Finalizar sem nenhum risco registrado: 422 com RISK_LIST_EMPTY e o documento continua DRAFT', async () => {
      const process = await newProcess();
      const only = await addRisk(process.id, 2, 2);
      const document = await emitOk(process.id);
      await fillNarrative(document.id);
      const removed = await auth(request(api.server).delete(`/api/v1/risks/${only.id}`)).set(
        'If-Match',
        '"1"',
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);

      const problem = expectProblem(await finalize(document.id), 422, 'DOCUMENT_INCOMPLETE');
      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'RISK_LIST_EMPTY',
          severity: 'BLOCKING',
          message: 'Registre ao menos um risco antes de emitir o Mapa de Riscos.',
        }),
      ]);
      expect(stored(document.id)).toMatchObject({ status: 'DRAFT', version: 1 });
      expect(versionsOf(document.id)).toEqual([]);
    });

    it('Emitir sem nenhum risco: 422 BUSINESS_RULE_VIOLATION (RISK_LIST_EMPTY) e nada criado (FA-02)', async () => {
      const process = await newProcess();
      const problem = expectProblem(await emit(process.id), 422, 'BUSINESS_RULE_VIOLATION');
      expect(problem.detail).toBe('Registre ao menos um risco antes de emitir o Mapa de Riscos.');
      expect(problem.violations.map((violation) => violation.code)).toEqual(['RISK_LIST_EMPTY']);
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .filter((row) => row.processId === process.id),
      ).toEqual([]);
      // Matriz vazia (FA-02): todas as células sem riscos.
      const grid = riskMatrixSchema.parse(data<RiskMatrixDto>(await matrix(process.id)));
      expect(grid.cells.every((cell) => cell.risks.length === 0)).toBe(true);
    });

    it('Risco de nível Alto sem tratamento: 422 com RISK_TREATMENT_REQUIRED_FOR_LEVEL referenciando R03', async () => {
      const process = await newProcess();
      await addRisk(process.id, 1, 2);
      await addRisk(process.id, 2, 2, 'Especificação técnica incompleta');
      const r03 = await addRisk(process.id, 3, 4, 'Impugnação do edital');
      expect(r03).toMatchObject({ code: 'R03', level: 'HIGH' });
      const document = await emitOk(process.id);
      await fillNarrative(document.id);

      const expected: unknown = expect.objectContaining({
        code: 'RISK_TREATMENT_REQUIRED_FOR_LEVEL',
        severity: 'BLOCKING',
        itemId: r03.id,
        message: 'O risco R03 precisa de ao menos uma ação de tratamento.',
        params: { code: 'R03', level: 'HIGH' },
      });
      const check = data<{ violations: unknown[] }>(await validation(document.id));
      expect(check.violations).toEqual([expected]);
      const problem = expectProblem(await finalize(document.id), 422, 'DOCUMENT_INCOMPLETE');
      expect(problem.violations).toEqual([expected]);
      expect(stored(document.id)?.status).toBe('DRAFT');

      // Tratamento cancelado não conta; um ativo resolve a pendência.
      const canceled = await addTreatment(r03.id);
      const cancel = await auth(request(api.server).patch(`/api/v1/risk-treatments/${canceled.id}`))
        .set('If-Match', '"1"')
        .send({ status: 'CANCELED' });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expectProblem(await finalize(document.id), 422, 'DOCUMENT_INCOMPLETE');
      await addTreatment(r03.id);
      expect((await finalize(document.id)).status).toBe(200);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário com RISK_MANAGE mas sem RISK_MAP_SUBMIT: 403 PERMISSION_DENIED com access.denied', async () => {
      const { process, document } = await readyRiskMap();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
      });
      // A participação concede RISK_MANAGE: Otávio edita riscos…
      const edit = await patchRisk((await addRisk(process.id, 2, 2)).id, 1, {
        title: 'Risco revisado pelo colaborador',
      });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      // …mas não conclui o Mapa de Riscos.
      expectProblem(await finalize(document.id, '"1"', 'sub-otavio'), 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'RISK_MAP_SUBMIT',
      });
      expect(stored(document.id)?.status).toBe('DRAFT');
    });

    it('Somente leitura: vê a matriz (PROCESS_VIEW) e não emite (403 com access.denied RISK_MANAGE)', async () => {
      const process = await newProcess();
      await addRisk(process.id, 3, 3);
      expect((await matrix(process.id, '', 'sub-otavio')).status).toBe(200);
      expectProblem(await emit(process.id, { subject: 'sub-otavio' }), 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'RISK_MANAGE',
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Matriz e emissão de processo de outro tenant: 404 NOT_FOUND, nada revelado nem criado', async () => {
      const process = await newProcess();
      await addRisk(process.id, 4, 4);
      const leaked = expectProblem(await matrix(process.id, '', 'sub-heitor', B), 404, 'NOT_FOUND');
      expect(JSON.stringify(leaked)).not.toContain('R01');
      expectProblem(await emit(process.id, { subject: 'sub-heitor', tenant: B }), 404, 'NOT_FOUND');
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .filter((row) => row.processId === process.id),
      ).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Criar o Mapa de Riscos quando já existe um ativo: 409 DOCUMENT_ALREADY_EXISTS com o existente', async () => {
      const process = await newProcess();
      await addRisk(process.id, 4, 4);
      const key = randomUUID();
      const first = await emit(process.id, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const existing = data<DocumentDto>(first);

      const replay = await emit(process.id, { key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<DocumentDto>(replay).id).toBe(existing.id);

      const problem = expectProblem(await emit(process.id), 409, 'DOCUMENT_ALREADY_EXISTS');
      expect(problem.detail).toBe('Já existe um Mapa de Riscos para este processo.');
      expect((problem as { meta?: unknown }).meta).toMatchObject({
        existingDocumentId: existing.id,
      });
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .filter((row) => row.processId === process.id),
      ).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Finalização concorrente com o mesmo ETag: a segunda recebe 412 VERSION_CONFLICT', async () => {
      const { document } = await readyRiskMap();
      const [ana, carla] = await Promise.all([finalize(document.id), finalize(document.id)]);
      const statuses = [ana.status, carla.status].sort();
      expect(statuses).toEqual([200, 412]);
      const loser = ana.status === 412 ? ana : carla;
      expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect(versionsOf(document.id)).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao finalizar: 503 DEPENDENCY_UNAVAILABLE com Retry-After; continua DRAFT', async () => {
      const { document } = await readyRiskMap();
      documentTransactions.down = true;
      const response = await finalize(document.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      documentTransactions.down = false;
      expect(stored(document.id)).toMatchObject({ status: 'DRAFT', version: 1 });
      expect(versionsOf(document.id)).toEqual([]);
    });

    it('Banco indisponível ao emitir: 503 e nenhum documento criado', async () => {
      const process = await newProcess();
      await addRisk(process.id, 2, 2);
      riskTransactions.down = true;
      expectProblem(await emit(process.id), 503, 'DEPENDENCY_UNAVAILABLE');
      riskTransactions.down = false;
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .filter((row) => row.processId === process.id),
      ).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200 FINALIZED e o DocumentFinalized gravado para publicação posterior', async () => {
      const { document } = await readyRiskMap();
      const response = await finalize(document.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<DocumentDto>(response).status).toBe('FINALIZED');
      // Sem relay no teste: o evento fica no outbox (PENDING no PostgreSQL — tenant-leak/risk-map).
      expect(eventsOf(document.id).filter((row) => row.eventType === 'DocumentFinalized')).toEqual([
        expect.objectContaining({ routingKey: 'document.finalized.risk_map' }),
      ]);
    });
  });
});

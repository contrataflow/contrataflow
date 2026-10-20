import { randomUUID } from 'node:crypto';

import { dfdMetaSchema, dfdSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { DfdDto, DocumentItemDto, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { documentRepositoryOf, filledSection } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  numberSequencesOf,
  processItemRepositoryOf,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedCustomRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { DFD_CLOCK, DFD_TRANSACTIONS } from '../application/ports.js';
import type { DfdTransactions } from '../application/ports.js';
import { InMemoryDfdRepository } from '../infrastructure/dfd.repositories.js';

/*
 * US-018 — DFD-05 (`POST /dfds/{id}/duplicate`) pelo pipeline HTTP completo (autenticação, tenant,
 * autorização, `Idempotency-Key`, filtro RFC 9457) com a identidade fake, os seeders reais e os
 * adaptadores em memória. Os cenários do Gherkin (8 categorias) mais as regras RN-DFD-72..78.
 * Atomicidade, RLS, FKs compostas e o índice único sob concorrência no PostgreSQL:
 * `test/tenant-leak/dfd-duplicate.spec.ts`.
 *
 * Personas: "Ana" do Gherkin = Ana (REQUISITANTE, DFD_CREATE + PROCESS_CREATE); "Bruno" = Otávio, com
 * um perfil de PROCESS_VIEW + DFD_CREATE (sem PROCESS_CREATE); Lúcia (PLANEJAMENTO) tem DFD_CREATE
 * em todo o tenant mas não a custódia dos processos da Ana.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T15:00:00.000Z');
const TODAY = '2026-10-17';
const SEQUENCE = (year = 2026) => `DOCUMENT:DFD:*:${String(year)}`;

const UNITS_A = {
  organizationId: '0192d014-0000-7000-8000-0000000000a0',
  obras: '0192d014-0000-7000-8000-0000000000a1',
  manutencao: '0192d014-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d014-0000-7000-8000-0000000000a3',
  saude: '0192d014-0000-7000-8000-0000000000a4',
  posto: '0192d014-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d014-0000-7000-8000-0000000000b0',
  obras: '0192d014-0000-7000-8000-0000000000b1',
  manutencao: '0192d014-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d014-0000-7000-8000-0000000000b3',
  saude: '0192d014-0000-7000-8000-0000000000b4',
  posto: '0192d014-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as do módulo) que podem simular o banco fora do ar. */
class FlakyTransactions implements DfdTransactions {
  down = false;
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
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

const fieldErrors = (response: request.Response) =>
  problemDetailsSchema.parse(response.body).errors.map((error) => [error.field, error.code]);

const JUSTIFICATION_TEXT = 'Reposição do estoque da UBS Centro. '.repeat(10);

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Duplicar DFD (US-018)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let units: { cx: string; un: string };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const duplicate = (
    dfdId: string,
    body: Record<string, unknown>,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/dfds/${dfdId}/duplicate`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const toNewProcess = (dfdId: string, options: Parameters<typeof duplicate>[2] = {}) =>
    duplicate(dfdId, { targetType: 'NEW_PROCESS' }, options);
  const toProcess = (
    dfdId: string,
    targetProcessId: string,
    options: Parameters<typeof duplicate>[2] = {},
  ) => duplicate(dfdId, { targetType: 'EXISTING_PROCESS', targetProcessId }, options);
  const getDfd = (dfdId: string, subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/dfds/${dfdId}`), subject, tenant);
  const createDfd = (processId: string, subject = 'sub-ana') =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/dfds`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({});
  const putItems = (documentId: string, items: readonly Record<string, unknown>[]) =>
    auth(request(api.server).put(`/api/v1/documents/${documentId}/items`))
      .set('If-Match', '"1"')
      .send({ items });
  const addProcessItem = (processId: string, body: Record<string, unknown>) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/items`))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', ...body });

  const documentItems = async (documentId: string) => {
    const response = await auth(request(api.server).get(`/api/v1/documents/${documentId}/items`));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<DocumentItemDto[]>(response);
  };

  const dfdStore = () => api.app.get(InMemoryDfdRepository, { strict: false });
  const processItems = () => processItemRepositoryOf(api);
  const dfdsOf = (processId: string) =>
    dfdStore()
      .snapshot()
      .filter((dfd) => dfd.processId === processId);
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const itemsOf = (processId: string) =>
    processItems()
      .all()
      .filter((item) => item.processId === processId && item.deletedAt === null)
      .sort((a, b) => a.sequence - b.sequence);
  const processById = (id: string) =>
    processRepositoryOf(api)
      .allProcesses()
      .find((process) => process.id === id);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (action: string) => api.auditRecords().filter((row) => row.action === action);
  const lastDfdNumber = () => numberSequencesOf(api).valueOf(A, SEQUENCE());
  const allDocuments = () => documentRepositoryOf(api).allDocuments().length;

  /** Processo criado pelo PRC-02 (Ana responsável) na etapa ABERTURA. */
  async function newProcess(fields: Partial<Process> = {}): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição de insumos ${words(2)}`,
        object: `Aquisição de insumos para a UBS Centro ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        priority: 'MEDIUM',
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = processById(data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    const process: Process = { ...created, ...fields };
    processRepositoryOf(api).replace(process);
    return process;
  }

  async function itemOk(processId: string, description: string, unitOfMeasureId: string) {
    const response = await addProcessItem(processId, { description, unitOfMeasureId });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessItemDto>(response);
  }

  /**
   * "DFD 0005/2026" do Background: processo com 2 itens (luvas CX × 120, seringas UN × 5000),
   * seções preenchidas e o cabeçalho com previsão, estimativa e prioridade.
   */
  async function sourceDfd(fields: Partial<Process> = {}) {
    const process = await newProcess(fields);
    const gloves = await itemOk(process.id, 'Luva de procedimento, tamanho M', units.cx);
    const syringes = await itemOk(process.id, 'Seringa descartável 5 ml', units.un);
    const created = await createDfd(process.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dfd = dfdSchema.parse(data<DfdDto>(created));
    const saved = await putItems(dfd.documentId, [
      { processItemId: gloves.id, quantity: '120', notes: 'Caixas com 100 unidades' },
      { processItemId: syringes.id, quantity: '5000' },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const document = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === dfd.documentId);
    if (!document) throw new Error('documento ausente');
    documentRepositoryOf(api).seed({
      ...document,
      draftContent: {
        sections: {
          ...document.draftContent.sections,
          JUSTIFICATION: filledSection(JUSTIFICATION_TEXT),
          EXPECTED_RESULTS: filledSection('Atendimento contínuo da UBS Centro.'),
        },
      },
    });
    const stored = dfdsOf(process.id)[0];
    if (!stored) throw new Error('DFD ausente');
    dfdStore().seed({
      ...stored,
      priority: 'HIGH',
      expectedDate: '2026-12-15',
      estimatedValue: '15000.00',
      wizardStep: 'REVIEW',
      completedSteps: ['IDENTIFICATION', 'JUSTIFICATION', 'PLANNING'],
    });
    return { process, dfd, document, gloves, syringes };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DFD_TRANSACTIONS, value: transactions },
        { token: DFD_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.lucia.id),
      roleId: roles.get('PLANEJAMENTO')?.id ?? '',
    });
    // "Bruno": enxerga os processos e tem DFD_CREATE, mas não PROCESS_CREATE.
    const dfdOnly = seedCustomRole(api, A, 'Elaboração de DFD', [
      'PROCESS_VIEW',
      'DFD_CREATE',
      'DFD_UPDATE',
    ]);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: dfdOnly.id,
    });
    units = {
      cx: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'CX'),
      un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
    };
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
    // Background: o último número de DFD do tenant em 2026 é 4 (o do Background será o 0005).
    numberSequencesOf(api).seed(A, SEQUENCE(), 4);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  describe('[Sucesso]', () => {
    it('Duplicar para novo processo: processo e DFD DRAFT com itens clonados, sourceDocumentId, cabeçalho e seções copiados', async () => {
      const source = await sourceDfd();
      const numberBefore = lastDfdNumber();

      const response = await toNewProcess(source.dfd.id);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = dfdSchema.parse(data<DfdDto>(response));
      const meta = dfdMetaSchema.parse((response.body as { meta: unknown }).meta);
      expect(meta.allowedActions).toContain('UPDATE');
      expect(response.headers.location).toBe(`/api/v1/dfds/${created.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(created.processId).not.toBe(source.process.id);
      expect(created).toMatchObject({
        code: `DFD ${String(numberBefore + 1).padStart(4, '0')}/2026`,
        status: 'DRAFT',
        documentId: created.id,
        // RN-DFD-76: copiados do cabeçalho de origem; setor e responsável do processo destino.
        objectSummary: source.process.object,
        priority: 'HIGH',
        expectedDate: '2026-12-15',
        estimatedValue: '15000.00',
        estimatedValueMasked: false,
        pcaStatus: 'NOT_APPLICABLE',
        requestDate: TODAY,
        requestingDepartmentId: UNITS_A.manutencao,
        responsibleId: FAKE_USERS.ana.id,
        // RN-DFD-77: recomeça o wizard.
        wizardStep: 'IDENTIFICATION',
        completedSteps: [],
        documentVersion: 1,
        version: 1,
      });
      expect(created.code).not.toBe(source.dfd.code);

      // RN-DFD-74: o novo processo nasce pela mecânica da duplicação (US-011).
      const target = processById(created.processId);
      expect(target).toMatchObject({
        status: 'DRAFT',
        duplicatedFromId: source.process.id,
        creationChannel: 'DUPLICATION',
        title: source.process.title,
        currentResponsibleId: FAKE_USERS.ana.id,
      });
      expect(target?.code).not.toBe(source.process.code);
      const clonedItems = itemsOf(created.processId);
      expect(clonedItems.map((item) => [item.sequence, item.description])).toEqual([
        [1, 'Luva de procedimento, tamanho M'],
        [2, 'Seringa descartável 5 ml'],
      ]);

      // Itens do DFD remapeados para os itens do novo processo, com quantidade e observação.
      const rows = await documentItems(created.documentId);
      expect(rows.map((row) => [row.processItemId, row.quantity, row.notes])).toEqual([
        [clonedItems[0]?.id, '120.0000', 'Caixas com 100 unidades'],
        [clonedItems[1]?.id, '5000.0000', null],
      ]);
      expect(rows.map((row) => row.sequence)).toEqual([1, 2]);

      // DEC-017 / RN-DFD-78: origem do documento e seções copiadas como texto.
      const [document] = documentsOf(created.processId);
      expect(document).toMatchObject({
        id: created.documentId,
        status: 'DRAFT',
        sourceDocumentId: source.dfd.documentId,
      });
      expect(document?.draftContent.sections.JUSTIFICATION).toMatchObject({
        state: 'FILLED',
        content: filledSection(JUSTIFICATION_TEXT).content,
        revision: 1,
        updatedById: FAKE_USERS.ana.id,
      });
      expect(document?.draftContent.sections.EXPECTED_RESULTS?.state).toBe('FILLED');
      expect(document?.draftContent.sections.NOTES?.state).toBe('EMPTY');

      // A origem não muda.
      expect(dfdsOf(source.process.id)).toHaveLength(1);
      expect(documentsOf(source.process.id)).toHaveLength(1);
      expect(itemsOf(source.process.id)).toHaveLength(2);
      expect(lastDfdNumber()).toBe(numberBefore + 1);

      // Eventos e auditoria (a timeline do novo processo é projetada no mesmo tx).
      expect(eventsOf(created.processId, 'ProcessCreated')).toHaveLength(1);
      expect(eventsOf(created.processId, 'DocumentCreated')).toMatchObject([
        {
          routingKey: 'document.created.dfd',
          aggregateId: created.id,
          payload: { documentTypeCode: 'DFD', sourceDocumentId: source.dfd.documentId },
        },
      ]);
      expect(eventsOf(created.processId, 'ProcessItemsChanged')).toEqual([]);
      expect(auditOf('document.duplicate')).toMatchObject([
        {
          entityId: created.id,
          processId: created.processId,
          metadata: {
            sourceDocumentId: source.dfd.documentId,
            sourceProcessId: source.process.id,
            targetProcessId: created.processId,
            targetType: 'NEW_PROCESS',
            itemsCloned: 2,
          },
        },
      ]);
      // RN-DFD-22: nasce sob custódia de quem duplicou, sem notificação.
      expect(api.outboxRows().filter((row) => row.eventType.startsWith('Notification'))).toEqual(
        [],
      );
      expect((await getDfd(created.id)).status).toBe(200);
    });

    it('Duplicar para processo existente sem itens (FA-01): os itens do DFD viram ProcessItem e o DFD DRAFT nasce no destino', async () => {
      const source = await sourceDfd();
      const target = await newProcess();
      const processes = processRepositoryOf(api).allProcesses().length;

      const response = await toProcess(source.dfd.id, target.id);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = dfdSchema.parse(data<DfdDto>(response));
      expect(created).toMatchObject({
        processId: target.id,
        status: 'DRAFT',
        requestDate: TODAY,
        responsibleId: FAKE_USERS.ana.id,
        wizardStep: 'IDENTIFICATION',
        completedSteps: [],
      });
      // RN-DFD-75: natureza, descrição, unidade clonados; sequência a partir de 1.
      const cloned = itemsOf(target.id);
      expect(cloned).toMatchObject([
        { sequence: 1, description: 'Luva de procedimento, tamanho M', kind: 'GOOD' },
        { sequence: 2, description: 'Seringa descartável 5 ml', kind: 'GOOD' },
      ]);
      expect(cloned.map((item) => item.unitOfMeasureId)).toEqual([units.cx, units.un]);
      expect(cloned.every((item) => item.lotNumber === null)).toBe(true);
      expect(cloned.map((item) => item.id)).not.toContain(source.gloves.id);
      const rows = await documentItems(created.documentId);
      expect(rows.map((row) => [row.processItemId, row.quantity])).toEqual([
        [cloned[0]?.id, '120.0000'],
        [cloned[1]?.id, '5000.0000'],
      ]);
      expect(documentsOf(target.id)[0]?.sourceDocumentId).toBe(source.dfd.documentId);

      // Eventos: sem ProcessCreated; DocumentCreated e ProcessItemsChanged.
      expect(eventsOf(target.id, 'ProcessCreated')).toHaveLength(1); // só o do próprio `target`
      expect(eventsOf(target.id, 'DocumentCreated')).toHaveLength(1);
      expect(eventsOf(target.id, 'ProcessItemsChanged')).toMatchObject([
        { payload: { added: cloned.map((item) => item.id) } },
      ]);
      expect(
        auditOf('process.items_update').filter((row) => row.processId === target.id),
      ).toHaveLength(1);
      expect(
        auditOf('document.duplicate').filter((row) => row.processId === target.id),
      ).toMatchObject([{ metadata: { targetType: 'EXISTING_PROCESS', itemsCloned: 2 } }]);
      // Nenhum processo novo foi criado.
      expect(processRepositoryOf(api).allProcesses()).toHaveLength(processes);
    });

    it('Processo existente que já tem itens: os clonados entram a partir do próximo número', async () => {
      const source = await sourceDfd();
      const target = await newProcess();
      await itemOk(target.id, 'Álcool em gel 500 ml', units.un);
      await itemOk(target.id, 'Máscara cirúrgica', units.cx);

      const response = await toProcess(source.dfd.id, target.id);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(itemsOf(target.id).map((item) => [item.sequence, item.description])).toEqual([
        [1, 'Álcool em gel 500 ml'],
        [2, 'Máscara cirúrgica'],
        [3, 'Luva de procedimento, tamanho M'],
        [4, 'Seringa descartável 5 ml'],
      ]);
    });

    it('RN-DFD-76: previsão anterior a hoje não é copiada (CHECK) e a estimativa de processo sigiloso não migra (POL-09)', async () => {
      const stale = await sourceDfd();
      const storedStale = dfdsOf(stale.process.id)[0];
      if (!storedStale) throw new Error('DFD ausente');
      dfdStore().seed({ ...storedStale, expectedDate: '2026-10-01' });
      const staleCopy = dfdSchema.parse(data<DfdDto>(await toNewProcess(stale.dfd.id)));
      expect(staleCopy).toMatchObject({ expectedDate: null, estimatedValue: '15000.00' });

      const secret = await sourceDfd({ isBudgetConfidential: true });
      const copy = await toNewProcess(secret.dfd.id);
      expect(copy.status, JSON.stringify(copy.body)).toBe(201);
      expect(dfdSchema.parse(data<DfdDto>(copy))).toMatchObject({
        estimatedValue: null,
        estimatedValueMasked: false,
        expectedDate: '2026-12-15',
      });
    });
  });

  describe('[Validação]', () => {
    it('V-01: processo destino com DFD ativo → 409 DOCUMENT_ALREADY_EXISTS com o código do existente; nada criado', async () => {
      const source = await sourceDfd();
      const target = await newProcess();
      const existing = dfdSchema.parse(data<DfdDto>(await createDfd(target.id)));
      const before = { documents: allDocuments(), number: lastDfdNumber() };

      const conflict = await toProcess(source.dfd.id, target.id);

      const problem = expectProblem(conflict, 409, 'DOCUMENT_ALREADY_EXISTS');
      expect(problem.detail).toBe(`Este processo já possui o ${existing.code ?? ''}.`);
      expect(conflict.body).toMatchObject({ meta: { existingDfdId: existing.id } });
      expect(dfdsOf(target.id)).toHaveLength(1);
      expect(itemsOf(target.id)).toEqual([]);
      expect({ documents: allDocuments(), number: lastDfdNumber() }).toEqual(before);
    });

    it('V-02: etapa do destino sem DFD → 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE; processo suspenso → 409 INVALID_PROCESS_STATUS', async () => {
      const source = await sourceDfd();
      const target = await newProcess();
      const stage = workflowStagesOf(api, A).find(
        (candidate) =>
          candidate.key === 'ESTUDOS_PRELIMINARES' &&
          candidate.workflowVersionId === target.workflowVersionId,
      );
      processRepositoryOf(api).replace({
        ...target,
        status: 'IN_PROGRESS',
        currentWorkflowStageId: stage?.id ?? null,
      });
      const problem = expectProblem(
        await toProcess(source.dfd.id, target.id),
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
      );
      expect(problem.detail).toBe('O DFD não pode ser elaborado na etapa atual do processo.');
      processRepositoryOf(api).replace({ ...target, status: 'SUSPENDED' });
      expectProblem(await toProcess(source.dfd.id, target.id), 409, 'INVALID_PROCESS_STATUS');
      expect(documentsOf(target.id)).toEqual([]);
      expect(itemsOf(target.id)).toEqual([]);
    });

    it('Corpo inválido: processo existente sem targetProcessId, novo processo com targetProcessId, tipo desconhecido → 422', async () => {
      const source = await sourceDfd();
      const missing = await duplicate(source.dfd.id, { targetType: 'EXISTING_PROCESS' });
      expectProblem(missing, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(missing)).toEqual([['targetProcessId', 'REQUIRED']]);
      const extra = await duplicate(source.dfd.id, {
        targetType: 'NEW_PROCESS',
        targetProcessId: newId(),
      });
      expect(fieldErrors(extra)).toEqual([['targetProcessId', 'NOT_ALLOWED']]);
      const unknown = await duplicate(source.dfd.id, { targetType: 'OTHER' });
      expectProblem(unknown, 422, 'VALIDATION_ERROR');
    });

    it('RN-PROC-83: itens que ultrapassam o limite de 1.000 do processo destino → 422 e nada criado', async () => {
      const source = await sourceDfd();
      const target = await newProcess();
      const template = itemsOf(source.process.id)[0];
      if (!template) throw new Error('item ausente');
      for (let sequence = 1; sequence <= 999; sequence += 1) {
        processItems().seed({
          ...template,
          id: newId(),
          processId: target.id,
          sequence,
        });
      }
      const response = await toProcess(source.dfd.id, target.id);
      expectProblem(response, 422, 'VALIDATION_ERROR');
      // O documento já criado nesta transação é desfeito pelo PostgreSQL (test/tenant-leak).
      expect(itemsOf(target.id)).toHaveLength(999);
    });
  });

  describe('[Permissão]', () => {
    it('Sem PROCESS_CREATE para novo processo ("Bruno"): 403 PERMISSION_DENIED e nada criado; para processo existente o DFD_CREATE basta', async () => {
      const source = await sourceDfd();
      const before = {
        documents: allDocuments(),
        number: lastDfdNumber(),
        processes: processRepositoryOf(api).allProcesses().length,
      };
      const duplicated = auditOf('document.duplicate').length;

      const denied = await toNewProcess(source.dfd.id, { subject: 'sub-otavio' });

      expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_CREATE',
      });
      expect({
        documents: allDocuments(),
        number: lastDfdNumber(),
        processes: processRepositoryOf(api).allProcesses().length,
      }).toEqual(before);
      expect(auditOf('document.duplicate')).toHaveLength(duplicated);
    });

    it('Destino sem a custódia de quem duplica (POL-01): 403 NOT_PROCESS_CUSTODIAN; nada criado', async () => {
      const source = await sourceDfd();
      const target = await newProcess();
      const before = allDocuments();
      // Lúcia (PLANEJAMENTO) tem DFD_CREATE no tenant, mas o processo está com a Ana.
      const response = await toProcess(source.dfd.id, target.id, { subject: 'sub-lucia' });
      expectProblem(response, 403, 'NOT_PROCESS_CUSTODIAN');
      expect(allDocuments()).toBe(before);
      expect(itemsOf(target.id)).toEqual([]);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo destino de outro tenant ou inexistente → 422 REFERENCE_NOT_FOUND em targetProcessId, sem ler nem alterar o outro tenant', async () => {
      const source = await sourceDfd();
      const foreign = { ...(await newProcess()), id: newId(), tenantId: B };
      processRepositoryOf(api).replace(foreign);
      const before = allDocuments();

      for (const targetProcessId of [foreign.id, newId()]) {
        const response = await toProcess(source.dfd.id, targetProcessId);
        expectProblem(response, 422, 'VALIDATION_ERROR');
        expect(fieldErrors(response)).toEqual([['targetProcessId', 'REFERENCE_NOT_FOUND']]);
        expect(problemDetailsSchema.parse(response.body).errors[0]?.message).toBe(
          'Selecione um processo válido.',
        );
        expect(JSON.stringify(response.body)).not.toContain(B);
      }
      expect(allDocuments()).toBe(before);
      expect(documentsOf(foreign.id)).toEqual([]);
      expect(itemsOf(foreign.id)).toEqual([]);
    });

    it('DFD de origem de outro tenant ou inexistente → 404 DFD_NOT_FOUND indistinguível', async () => {
      const source = await sourceDfd();
      expectProblem(
        await toNewProcess(source.dfd.id, { subject: 'sub-heitor', tenant: B }),
        404,
        'DFD_NOT_FOUND',
      );
      expectProblem(await toNewProcess(newId()), 404, 'DFD_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 201 com o mesmo DFD, Idempotent-Replayed e um só DFD/processo criado', async () => {
      const source = await sourceDfd();
      const processes = processRepositoryOf(api).allProcesses().length;
      const numberBefore = lastDfdNumber();
      const key = randomUUID();

      const first = await toNewProcess(source.dfd.id, { key });
      const replay = await toNewProcess(source.dfd.id, { key });

      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.headers.location).toBe(first.headers.location);
      expect(data<DfdDto>(replay).id).toBe(data<DfdDto>(first).id);
      expect(processRepositoryOf(api).allProcesses()).toHaveLength(processes + 1);
      expect(lastDfdNumber()).toBe(numberBefore + 1);
      expect(
        auditOf('document.duplicate').filter((row) => row.metadata.idempotencyKey === key),
      ).toHaveLength(1);
      expectProblem(
        await toProcess(source.dfd.id, newId(), { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Duas duplicações simultâneas para o mesmo processo existente: uma 201, a outra 409 DOCUMENT_ALREADY_EXISTS; um só DFD e um só conjunto de itens', async () => {
      const source = await sourceDfd();
      const target = await newProcess();
      const numberBefore = lastDfdNumber();

      const responses = await Promise.all([
        toProcess(source.dfd.id, target.id),
        toProcess(source.dfd.id, target.id),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expectProblem(
        responses.find((response) => response.status === 409) as request.Response,
        409,
        'DOCUMENT_ALREADY_EXISTS',
      );
      expect(dfdsOf(target.id)).toHaveLength(1);
      expect(itemsOf(target.id)).toHaveLength(2);
      expect(lastDfdNumber()).toBe(numberBefore + 1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After; nada persistido nem numerado', async () => {
      const source = await sourceDfd();
      const before = {
        documents: allDocuments(),
        number: lastDfdNumber(),
        processes: processRepositoryOf(api).allProcesses().length,
        events: api.outboxRows().length,
      };
      transactions.down = true;

      const response = await toNewProcess(source.dfd.id);

      const problem = expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(problem.correlationId).toEqual(expect.any(String));
      transactions.down = false;
      expect({
        documents: allDocuments(),
        number: lastDfdNumber(),
        processes: processRepositoryOf(api).allProcesses().length,
        events: api.outboxRows().length,
      }).toEqual(before);
    });

    it('Falha ao gravar o Dfd depois de criar o processo: 503 DEPENDENCY_UNAVAILABLE (a transação real desfaz tudo — test/tenant-leak)', async () => {
      const source = await sourceDfd();
      const duplicated = auditOf('document.duplicate').length;
      const insert = vi
        .spyOn(InMemoryDfdRepository.prototype, 'insert')
        .mockRejectedValueOnce(new DatabaseUnavailableError(new Error('ECONNRESET')));
      const response = await toNewProcess(source.dfd.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(insert).toHaveBeenCalledOnce();
      insert.mockRestore();
      expect(auditOf('document.duplicate')).toHaveLength(duplicated);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 201 e os eventos ficam no outbox (PENDING) para publicar depois', async () => {
      // Sem relay no modo em memória: as linhas ficam como ficariam `PENDING` no PostgreSQL.
      const source = await sourceDfd();
      const response = await toNewProcess(source.dfd.id);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = dfdSchema.parse(data<DfdDto>(response));
      expect(
        api
          .outboxRows()
          .filter((row) => row.processId === created.processId)
          .map((row) => row.eventType),
      ).toEqual(expect.arrayContaining(['ProcessCreated', 'DocumentCreated']));
    });
  });
});

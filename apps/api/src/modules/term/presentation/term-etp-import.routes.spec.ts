import { randomUUID } from 'node:crypto';

import {
  etpSchema,
  problemDetailsSchema,
  richTextFromPlainText,
  termDetailSchema,
  termImportPreviewSchema,
  termImportResultSchema,
  termSchema,
} from '@contrataflow/validation';
import type { ProcessDto, ProcessItemDto, TermImportPreviewDto } from '@contrataflow/validation';
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
import {
  buildDocument,
  documentItemRepositoryOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import { seedPriceResearch } from '../../../../test/support/price-research-fixtures.js';
import {
  CATALOG_CLOCK,
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
import { TERM_CLOCK, TERM_TRANSACTIONS } from '../application/ports.js';
import type { TermTransactions } from '../application/ports.js';
import { InMemoryTermRepository } from '../infrastructure/term.repositories.js';

/*
 * US-037 — Importar dados do ETP para o TR, pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `Idempotency-Key`, `If-Match`, filtro RFC 9457) com a identidade fake e os
 * seeders reais. Background: processo com 8 itens; nos estudos preliminares, Carla ("Lúcia" —
 * PLANEJAMENTO, custódia) cria o ETP (ETP-02), preenche as seções (DOC-05), os itens (DOC-07) e o
 * valor vinculado à pesquisa "PP 0002/2026" (ETP-04 — R$ 125.000,00), salva a versão (DOC-16) e o
 * ETP é finalizado; na etapa do TR, Carla cria o TR (TRM-02). Bruno ("Otávio") é SOMENTE_LEITURA;
 * Fábio é da Prefeitura B. As 8 categorias do Gherkin + FA-02/04/05/06 e V-01/V-03/V-08. A
 * atomicidade com falha induzida no PostgreSQL e a RLS: `test/tenant-leak/term-etp-import.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';
const ANA = 'sub-ana';

const UNITS_A = {
  organizationId: '0192d037-0000-7000-8000-0000000000a0',
  obras: '0192d037-0000-7000-8000-0000000000a1',
  manutencao: '0192d037-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d037-0000-7000-8000-0000000000a3',
  saude: '0192d037-0000-7000-8000-0000000000a4',
  posto: '0192d037-0000-7000-8000-0000000000a5',
};

const ALL_SECTIONS = ['OBJECT', 'JUSTIFICATION', 'SPECIFICATIONS', 'ESTIMATED_VALUE'];
const ALL_FIELDS = ['estimatedTotalValue', 'priceResearchId'];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as do módulo) que podem simular o banco fora do ar. */
class FlakyTransactions implements TermTransactions {
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

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Importar dados do ETP para o TR (US-037)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let clock = NOW;
  let catalog: { contractingType: string; origin: string; un: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = CARLA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const post = (path: string, subject = CARLA, tenant: string = A) =>
    auth(request(api.server).post(`/api/v1${path}`), subject, tenant);

  const preview = (termId: string, subject = CARLA, tenant: string = A) =>
    post(`/terms/${termId}/import-etp/preview`, subject, tenant).send({});
  const apply = (
    termId: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string | null; key?: string; subject?: string; tenant?: string } = {},
  ) => {
    const call = post(`/terms/${termId}/import-etp`, options.subject, options.tenant).set(
      'Idempotency-Key',
      options.key ?? randomUUID(),
    );
    return (options.ifMatch === null ? call : call.set('If-Match', options.ifMatch ?? '"1"')).send(
      body,
    );
  };
  const getTerm = (id: string, subject = CARLA) =>
    auth(request(api.server).get(`/api/v1/terms/${id}`), subject);
  const putSection = (documentId: string, key: string, text: string, revision: number) =>
    auth(request(api.server).put(`/api/v1/documents/${documentId}/sections/${key}`))
      .set('If-Match', `"s${String(revision)}"`)
      .send({ content: richTextFromPlainText(text) });

  const termOf = (id: string) => {
    const found = api.app
      .get(InMemoryTermRepository, { strict: false })
      .snapshot()
      .find((term) => term.id === id);
    if (!found) throw new Error('TR ausente');
    return found;
  };
  const documentOf = (id: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((document) => document.id === id);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const itemsOf = (documentId: string) =>
    documentItemRepositoryOf(api)
      .snapshot()
      .filter((item) => item.documentId === documentId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const typeOf = (code: string, tenantId: string = A) =>
    documentTypeRepositoryOf(api)
      .snapshot()
      .find((type) => type.tenantId === tenantId && type.code === code);
  const stageId = (process: Process, key: string) =>
    workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === key && candidate.workflowVersionId === process.workflowVersionId,
    )?.id ?? null;
  const currentOf = (process: Process) =>
    processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === process.id) ?? process;
  const moveTo = (process: Process, fields: Partial<Process>) => {
    const next = { ...currentOf(process), ...fields };
    processRepositoryOf(api).replace(next);
    return next;
  };
  const sectionText = (documentId: string, key: string) =>
    JSON.stringify(documentOf(documentId).draftContent.sections[key]?.content ?? null);

  /** Pesquisa de preços do processo (documento no status dado) com o total. */
  function seedResearch(
    process: Process,
    options: { status: 'DRAFT' | 'FINALIZED'; total: string; singleton: boolean },
  ) {
    const type = typeOf('PRICE_RESEARCH');
    const id = newId();
    documentRepositoryOf(api).seed(
      buildDocument({
        id,
        tenantId: process.tenantId,
        processId: process.id,
        documentTypeId: type?.id ?? newId(),
        code: options.singleton ? 'PP 0002/2026' : 'PP 0003/2026',
        title: 'Pesquisa de preços — notebooks',
        status: options.status,
        singletonKey: options.singleton ? (type?.id ?? null) : null,
      }),
    );
    seedPriceResearch(api, {
      id,
      tenantId: process.tenantId,
      processId: process.id,
      totalEstimatedValue: options.total,
      completedAt: options.status === 'FINALIZED' ? NOW : null,
      now: NOW,
    });
    return id;
  }

  async function itemOk(processId: string, index: number) {
    const response = await post(`/processes/${processId}/items`, ANA)
      .set('Idempotency-Key', randomUUID())
      .send({
        kind: 'GOOD',
        description: `Notebook modelo ${String(index)}`,
        unitOfMeasureId: catalog.un,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessItemDto>(response);
  }

  /**
   * Background: processo com 8 itens; ETP finalizado (seções, itens, valor "125000.00" vinculado à
   * pesquisa) e o TR em DRAFT do modelo padrão sob custódia de Carla.
   */
  async function background(
    options: { confidential?: boolean; withEtp?: boolean; trResearch?: boolean } = {},
  ) {
    const response = await post('/processes', ANA)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Notebooks ${words(2)}`,
        object: `Aquisição de notebooks para as escolas municipais ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        priority: 'MEDIUM',
        pcaStatus: 'NOT_APPLICABLE',
        confirmDuplicate: true,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const processId = data<ProcessDto>(response).id;
    const items: ProcessItemDto[] = [];
    for (let index = 1; index <= 8; index += 1) items.push(await itemOk(processId, index));
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === processId);
    if (!created) throw new Error('processo ausente');
    let process = moveTo(created, {
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId(created, 'ESTUDOS_PRELIMINARES'),
      currentResponsibleId: FAKE_USERS.lucia.id,
      isBudgetConfidential: options.confidential === true,
    });

    let etpId: string | null = null;
    let researchId: string | null = null;
    if (options.withEtp !== false) {
      const etpResponse = await post(`/processes/${process.id}/etps`)
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
      const etp = etpSchema.parse(data(etpResponse));
      etpId = etp.documentId;
      const texts: Record<string, string> = {
        RECOMMENDED_SOLUTION: 'Notebooks educacionais com 8 GB de memória.',
        NEED_DESCRIPTION: 'As escolas não têm equipamentos para as aulas de informática.',
        PROBLEM: 'Os laboratórios estão defasados há dez anos.',
        OBJECTIVE: 'Equipar os laboratórios de 8 escolas.',
        REQUIREMENTS: 'Processador de 4 núcleos e garantia de 36 meses.',
        ESTIMATES: 'Estimativa a partir da pesquisa de preços.',
      };
      for (const [key, text] of Object.entries(texts)) {
        const revision = documentOf(etp.documentId).draftContent.sections[key]?.revision ?? 0;
        const saved = await putSection(etp.documentId, key, text, revision);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      }
      const itemsSaved = await auth(
        request(api.server).put(`/api/v1/documents/${etp.documentId}/items`),
      )
        .set('If-Match', `"${String(documentOf(etp.documentId).version)}"`)
        .send({
          items: items.map((item, index) => ({
            processItemId: item.id,
            quantity: String(10 + index),
          })),
        });
      expect(itemsSaved.status, JSON.stringify(itemsSaved.body)).toBe(200);
      researchId = seedResearch(process, { status: 'DRAFT', total: '125000.00', singleton: true });
      const linked = await auth(request(api.server).patch(`/api/v1/etps/${etp.id}`))
        .set('If-Match', `"${String(etp.version)}"`)
        .send({ estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId });
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      const version = await post(`/documents/${etp.documentId}/versions`)
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(version.status, JSON.stringify(version.body)).toBe(201);
      documentRepositoryOf(api).seed({ ...documentOf(etp.documentId), status: 'FINALIZED' });
    }

    process = moveTo(process, { currentWorkflowStageId: stageId(process, 'TERMO_REFERENCIA') });
    if (options.trResearch === true) {
      seedResearch(process, { status: 'FINALIZED', total: '98000.00', singleton: false });
    }
    const termResponse = await post(`/processes/${process.id}/terms`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(termResponse.status, JSON.stringify(termResponse.body)).toBe(201);
    const term = termSchema.parse(data(termResponse));
    return { process, term, etpId: etpId ?? '', researchId: researchId ?? '', items };
  }

  async function previewOk(termId: string, subject = CARLA) {
    const response = await preview(termId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return termImportPreviewSchema.parse(data(response));
  }

  const fullBody = (result: TermImportPreviewDto, extra: Record<string, unknown> = {}) => ({
    importToken: result.importToken,
    sections: result.sections.map((section) => section.target),
    fields: result.fields.map((field) => field.target),
    copyItems: true,
    ...extra,
  });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: TERM_TRANSACTIONS, value: transactions },
        { token: TERM_CLOCK, value: () => clock },
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
      'document.templateLibrary',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
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
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    clock = NOW;
  });

  describe('[Sucesso]', () => {
    it('Pré-visualizar e aplicar a importação completa: valor, origem ETP, versão IMPORT, evento, auditoria e timeline', async () => {
      const { process, term, etpId, researchId } = await background();
      const result = await previewOk(term.id);
      expect(result.sections.map((section) => section.target)).toEqual(ALL_SECTIONS);
      expect(result.sections.find((section) => section.target === 'JUSTIFICATION')).toMatchObject({
        mode: 'APPEND',
        preview: expect.stringContaining('Importado do ETP v1 em 20/10/2026') as unknown,
      });
      expect(result.fields).toEqual([
        expect.objectContaining({ target: 'estimatedTotalValue', value: '125000.00' }),
        expect.objectContaining({ target: 'priceResearchId', value: researchId }),
      ]);
      expect(result.items.count).toBe(8);
      expect(result.items.preview.map((item) => item.etpQuantity)).toEqual(
        Array.from({ length: 8 }, (_, index) => `${String(10 + index)}.0000`),
      );
      expect(result.etp).toMatchObject({ id: etpId, versionNumber: 1, inProgress: false });
      expect(new Date(result.expiresAt).getTime() - NOW.getTime()).toBe(15 * 60_000);
      // A prévia não grava nada.
      expect(termOf(term.id).version).toBe(1);

      const response = await apply(term.id, fullBody(result));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const applied = termImportResultSchema.parse(data(response));
      expect(response.headers.etag).toBe('"2"');
      expect(applied).toMatchObject({
        sectionsImported: ALL_SECTIONS,
        fieldsImported: ALL_FIELDS,
        itemsImported: 8,
        term: {
          estimatedTotalValue: '125000.00',
          estimatedValueSource: 'ETP',
          priceResearchId: researchId,
          importedFromEtpId: etpId,
          importedFromEtpVersionId: documentOf(etpId).currentVersionId,
          importedById: FAKE_USERS.lucia.id,
          version: 2,
        },
      });
      const document = documentOf(term.documentId);
      expect(document.currentVersionNumber).toBe(applied.documentVersion.versionNumber);
      expect(sectionText(term.documentId, 'OBJECT')).toContain('Notebooks educacionais');
      expect(sectionText(term.documentId, 'SPECIFICATIONS')).toContain('Processador de 4 núcleos');
      expect(itemsOf(term.documentId)).toHaveLength(8);

      const versions = eventsOf(process.id, 'DocumentVersionCreated').filter(
        (row) => row.aggregateId === term.documentId,
      );
      expect(versions).toHaveLength(1);
      expect(versions[0]?.routingKey).toBe('document.version_created.tr');
      expect(versions[0]?.payload).toMatchObject({ reason: 'IMPORT' });
      const [event] = eventsOf(process.id, 'TermImportedFromEtp');
      expect(event).toMatchObject({
        routingKey: 'term.imported_from_etp',
        payload: { termId: term.id, etpId, itemsImported: 8, sectionsImported: ALL_SECTIONS },
      });
      const [audit] = auditOf(process.id, 'term.import_etp');
      expect(audit).toMatchObject({
        entityId: term.id,
        metadata: expect.objectContaining({
          etpId,
          itemsImported: 8,
          idempotencyKey: expect.any(String) as unknown,
        }) as unknown,
      });
      // Auditoria sem conteúdo: só chaves.
      expect(JSON.stringify(audit)).not.toContain('Notebooks educacionais');
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === process.id)
          .map((row) => row.type),
      ).toContain('TERM_IMPORTED_FROM_ETP');
      expect(auditOf(process.id, 'document.version_create').at(-1)?.metadata).toMatchObject({
        reason: 'IMPORT',
      });
    });

    it('FA-06: reimportação parcial só toca as seções marcadas; a edição manual das demais fica', async () => {
      const { term } = await background();
      const first = await previewOk(term.id);
      expect((await apply(term.id, fullBody(first))).status).toBe(200);
      const revision = documentOf(term.documentId).draftContent.sections.OBJECT?.revision ?? 0;
      expect(
        (await putSection(term.documentId, 'OBJECT', 'Objeto ajustado à mão.', revision)).status,
      ).toBe(200);
      const second = await previewOk(term.id);
      const response = await apply(
        term.id,
        {
          importToken: second.importToken,
          sections: ['SPECIFICATIONS'],
          fields: [],
          copyItems: false,
        },
        { ifMatch: '"2"' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(termImportResultSchema.parse(data(response))).toMatchObject({
        sectionsImported: ['SPECIFICATIONS'],
        fieldsImported: [],
        itemsImported: 0,
      });
      expect(sectionText(term.documentId, 'OBJECT')).toContain('Objeto ajustado à mão.');
    });

    it('RN-TR-24: depois de nova versão do ETP o TRM-03 sinaliza etpChangedSinceImport', async () => {
      const { term, etpId } = await background();
      const result = await previewOk(term.id);
      expect((await apply(term.id, fullBody(result))).status).toBe(200);
      const read = async () => termDetailSchema.parse(data(await getTerm(term.id)));
      expect((await read()).etpChangedSinceImport).toBe(false);
      documentRepositoryOf(api).seed({
        ...documentOf(etpId),
        currentVersionId: newId(),
        currentVersionNumber: 2,
      });
      expect((await read()).etpChangedSinceImport).toBe(true);
    });

    it('FA-02: ETP ainda em elaboração — prévia normal com o aviso', async () => {
      const { term, etpId } = await background();
      documentRepositoryOf(api).seed({ ...documentOf(etpId), status: 'DRAFT' });
      const result = await previewOk(term.id);
      expect(result.etp.inProgress).toBe(true);
    });
  });

  describe('[Validação]', () => {
    it('Processo sem ETP: 422 ETP_REQUIRED_FOR_IMPORT', async () => {
      const { term } = await background({ withEtp: false });
      const problem = expectProblem(await preview(term.id), 422, 'ETP_REQUIRED_FOR_IMPORT');
      expect(problem.detail).toBe('Este processo não tem um ETP para importar.');
    });

    it('Substituir a origem do valor sem confirmação: 422 CONDITIONAL_REQUIRED e o valor não muda', async () => {
      const { term } = await background({ trResearch: true });
      expect(term).toMatchObject({
        estimatedValueSource: 'PRICE_RESEARCH',
        estimatedTotalValue: '98000.00',
      });
      const result = await previewOk(term.id);
      expect(result.replacesPriceResearchValue).toBe(true);
      const problem = expectProblem(
        await apply(term.id, { ...fullBody(result), fields: ['estimatedTotalValue'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'confirmReplaceValueSource',
          code: 'CONDITIONAL_REQUIRED',
        }),
      ]);
      expect(termOf(term.id)).toMatchObject({
        estimatedTotalValue: '98000.00',
        estimatedValueSource: 'PRICE_RESEARCH',
        version: 1,
      });
      const confirmed = await apply(term.id, {
        ...fullBody(result),
        confirmReplaceValueSource: true,
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect(termOf(term.id)).toMatchObject({
        estimatedTotalValue: '125000.00',
        estimatedValueSource: 'ETP',
      });
    });

    it('V-01/V-03/V-08: nenhuma seleção, token inválido e If-Match ausente', async () => {
      const { term } = await background();
      const result = await previewOk(term.id);
      const none = expectProblem(
        await apply(term.id, { ...fullBody(result), sections: [], fields: [], copyItems: false }),
        422,
        'VALIDATION_ERROR',
      );
      expect(none.errors).toEqual([
        expect.objectContaining({
          field: 'sections',
          code: 'REQUIRED',
          message: 'Selecione ao menos uma seção, campo ou os itens.',
        }),
      ]);
      const forged = expectProblem(
        await apply(term.id, { ...fullBody(result), importToken: `${result.importToken}x` }),
        422,
        'VALIDATION_ERROR',
      );
      expect(forged.errors).toEqual([
        expect.objectContaining({ field: 'importToken', message: 'Gere a prévia novamente.' }),
      ]);
      expectProblem(
        await apply(term.id, fullBody(result), { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
      expectProblem(
        await apply(term.id, { ...fullBody(result), sections: ['SANCTIONS'] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(termOf(term.id).version).toBe(1);
    });

    it('Token de outro TR: 422 VALIDATION_ERROR em importToken', async () => {
      const first = await background();
      const second = await background();
      const result = await previewOk(first.term.id);
      const problem = expectProblem(
        await apply(second.term.id, fullBody(result)),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors[0]?.field).toBe('importToken');
    });

    it('V-06: TR fora de DRAFT/RETURNED: 409 DOCUMENT_NOT_EDITABLE', async () => {
      const { term } = await background();
      documentRepositoryOf(api).seed({ ...documentOf(term.documentId), status: 'FINALIZED' });
      const problem = expectProblem(await preview(term.id), 409, 'DOCUMENT_NOT_EDITABLE');
      expect(problem.detail).toBe('O TR não pode ser editado no status atual.');
    });

    it('FA-04: item já especificado só é sobrescrito com overwriteExisting', async () => {
      const { term } = await background();
      const first = await previewOk(term.id);
      expect((await apply(term.id, { ...fullBody(first), sections: [], fields: [] })).status).toBe(
        200,
      );
      const [row] = itemsOf(term.documentId);
      if (row === undefined) throw new Error('linha ausente');
      documentItemRepositoryOf(api).markSpecified(row.id);
      await documentItemRepositoryOf(api).replace({} as TenantTx, term.documentId, [
        ...itemsOf(term.documentId).filter((item) => item.id !== row.id),
        { ...row, quantity: '1.0000' },
      ]);
      const second = await previewOk(term.id);
      expect(second.items.preview.filter((item) => item.specified)).toHaveLength(1);
      const kept = await apply(
        term.id,
        { importToken: second.importToken, sections: [], fields: [], copyItems: true },
        { ifMatch: '"2"' },
      );
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(termImportResultSchema.parse(data(kept)).itemsImported).toBe(7);
      expect(itemsOf(term.documentId).find((item) => item.id === row.id)?.quantity).toBe('1.0000');
      const third = await previewOk(term.id);
      const overwritten = await apply(
        term.id,
        {
          importToken: third.importToken,
          sections: [],
          fields: [],
          copyItems: true,
          overwriteExisting: true,
        },
        { ifMatch: '"3"' },
      );
      expect(overwritten.status, JSON.stringify(overwritten.body)).toBe(200);
      expect(itemsOf(term.documentId).find((item) => item.id === row.id)?.quantity).toBe(
        row.quantity,
      );
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem TERM_UPDATE: 403 PERMISSION_DENIED com access.denied', async () => {
      const { process, term } = await background();
      const result = await previewOk(term.id);
      expectProblem(await preview(term.id, BRUNO), 403, 'PERMISSION_DENIED');
      expectProblem(
        await apply(term.id, fullBody(result), { subject: BRUNO }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'TERM_UPDATE',
      });
      expect(termOf(term.id).version).toBe(1);
      expect(auditOf(process.id, 'term.import_etp')).toEqual([]);
    });

    it('FA-05: orçamento sigiloso — o CONSULTANT não vê nem importa o valor estimado', async () => {
      const { process, term } = await background({ confidential: true });
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'CONSULTANT',
      });
      const result = await previewOk(term.id, BRUNO);
      expect(result.fields.find((field) => field.target === 'estimatedTotalValue')).toMatchObject({
        value: null,
        valueMasked: true,
      });
      expect(JSON.stringify(result)).not.toContain('125000');
      const response = await apply(term.id, fullBody(result), { subject: BRUNO });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const applied = termImportResultSchema.parse(data(response));
      expect(applied.fieldsImported).toEqual(['priceResearchId']);
      expect(applied.term.estimatedTotalValue).toBeNull();
      expect(termOf(term.id)).toMatchObject({
        estimatedTotalValue: null,
        estimatedValueSource: null,
      });
      // A custodiante importa o valor; a auditoria do processo sigiloso o mascara.
      const custodian = await previewOk(term.id);
      expect((await apply(term.id, fullBody(custodian), { ifMatch: '"2"' })).status).toBe(200);
      expect(termOf(term.id).estimatedTotalValue).toBe('125000.00');
      expect(JSON.stringify(auditOf(process.id, 'term.import_etp'))).not.toContain('125000');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('TR de outro tenant: 404 NOT_FOUND sem revelar dados', async () => {
      const { term } = await background();
      const result = await previewOk(term.id);
      const fromB = expectProblem(await preview(term.id, 'sub-fabio', B), 404, 'NOT_FOUND');
      expect(JSON.stringify(fromB)).not.toContain(term.code ?? 'TR ');
      expectProblem(
        await apply(term.id, fullBody(result), { subject: 'sub-fabio', tenant: B }),
        404,
        'NOT_FOUND',
      );
      expectProblem(await preview(newId()), 404, 'NOT_FOUND');
      expect(termOf(term.id).version).toBe(1);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 200, Idempotent-Replayed e nenhum item duplicado', async () => {
      const { process, term } = await background();
      const result = await previewOk(term.id);
      const key = randomUUID();
      const first = await apply(term.id, fullBody(result), { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await apply(term.id, fullBody(result), { key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(itemsOf(term.documentId)).toHaveLength(8);
      expect(eventsOf(process.id, 'TermImportedFromEtp')).toHaveLength(1);
      expect(termOf(term.id).version).toBe(2);
    });
  });

  describe('[Concorrência]', () => {
    it('ETP muda entre a prévia e a aplicação: 410 IMPORT_PREVIEW_EXPIRED', async () => {
      const { term, etpId } = await background();
      const result = await previewOk(term.id);
      const etp = documentOf(etpId);
      documentRepositoryOf(api).seed({
        ...etp,
        currentVersionId: newId(),
        currentVersionNumber: 2,
        version: etp.version + 1,
      });
      const problem = expectProblem(
        await apply(term.id, fullBody(result)),
        410,
        'IMPORT_PREVIEW_EXPIRED',
      );
      expect(problem.detail).toBe('O ETP ou o TR foram alterados. Atualizando a prévia…');
      expect(termOf(term.id).version).toBe(1);
    });

    it('Seção do TR editada depois da prévia (autosave): 410; prévia vencida (16 min): 410', async () => {
      const { term } = await background();
      const result = await previewOk(term.id);
      const revision = documentOf(term.documentId).draftContent.sections.DEADLINES?.revision ?? 0;
      expect(
        (await putSection(term.documentId, 'DEADLINES', 'Prazo de 30 dias.', revision)).status,
      ).toBe(200);
      expectProblem(await apply(term.id, fullBody(result)), 410, 'IMPORT_PREVIEW_EXPIRED');
      const fresh = await previewOk(term.id);
      clock = new Date(NOW.getTime() + 16 * 60_000);
      expectProblem(await apply(term.id, fullBody(fresh)), 410, 'IMPORT_PREVIEW_EXPIRED');
      expect(termOf(term.id).version).toBe(1);
    });

    it('Edição concorrente do TR invalida o If-Match: 412 VERSION_CONFLICT', async () => {
      const { term } = await background();
      const result = await previewOk(term.id);
      const patched = await auth(request(api.server).patch(`/api/v1/terms/${term.id}`))
        .set('If-Match', '"1"')
        .send({ objectDefinition: 'Aquisição de notebooks educacionais' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      const problem = expectProblem(
        await apply(term.id, fullBody(result), { ifMatch: '"1"' }),
        412,
        'VERSION_CONFLICT',
      );
      expect(problem.detail).toBe('O TR foi alterado por outra pessoa. Recarregue para continuar.');
    });

    it('Duas aplicações simultâneas com o mesmo token: uma 200 e a outra recusada', async () => {
      const { process, term } = await background();
      const result = await previewOk(term.id);
      const responses = await Promise.all([
        apply(term.id, fullBody(result)),
        apply(term.id, fullBody(result)),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
      expect(eventsOf(process.id, 'TermImportedFromEtp')).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na aplicação: 503 DEPENDENCY_UNAVAILABLE e nada alterado', async () => {
      const { process, term } = await background();
      const result = await previewOk(term.id);
      const before = documentOf(term.documentId);
      transactions.down = true;
      const response = await apply(term.id, fullBody(result));
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(termOf(term.id)).toMatchObject({ version: 1, estimatedTotalValue: null });
      expect(documentOf(term.documentId)).toEqual(before);
      expect(itemsOf(term.documentId)).toHaveLength(0);
      expect(auditOf(process.id, 'term.import_etp')).toEqual([]);
      expect(eventsOf(process.id, 'TermImportedFromEtp')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 200 e o TermImportedFromEtp fica no outbox (mesmo tx) uma única vez', async () => {
      const { process, term } = await background();
      const result = await previewOk(term.id);
      expect((await apply(term.id, fullBody(result))).status).toBe(200);
      const events = eventsOf(process.id, 'TermImportedFromEtp');
      expect(events).toHaveLength(1);
      expect(events[0]?.aggregateId).toBe(term.id);
    });
  });
});

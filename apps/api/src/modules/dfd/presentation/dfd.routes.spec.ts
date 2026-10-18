import { randomUUID } from 'node:crypto';

import {
  dfdMetaSchema,
  dfdSchema,
  dfdSummarySchema,
  documentItemSchema,
  documentValidationSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  DfdDto,
  DocumentItemDto,
  DocumentValidationDto,
  ProcessDto,
  ProcessItemDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  documentItemRepositoryOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  filledSection,
  templateRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  numberSequencesOf,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  seedScanningAttachment,
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { DFD_CLOCK, DFD_TRANSACTIONS } from '../application/ports.js';
import type { DfdTransactions } from '../application/ports.js';
import { InMemoryDfdRepository } from '../infrastructure/dfd.repositories.js';

/*
 * US-014 — DFD em wizard a partir de template pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade fake, os
 * seeders reais (catálogo, perfis, tipos de documento, biblioteca de templates e o workflow padrão)
 * e o processo criado pelo PRC-02 (Ana responsável, etapa ABERTURA). As 8 categorias do Gherkin:
 * DFD-01/02/03, DOC-06/07 (itens), DOC-08 (checklist) e DOC-20 (prévia). Ana (REQUISITANTE) é a
 * "Cláudia"; Otávio recebe SOMENTE_LEITURA ("Tatiane"); Otávio também é o consultor participante ("Bruno") nos processos em que é incluído;
 * Lúcia recebe PLANEJAMENTO (DFD_CREATE, escopo TENANT) sem custódia ("Patrícia"). Atomicidade com
 * numeração, índice único sob concorrência, RLS e FKs compostas no PostgreSQL:
 * `test/tenant-leak/dfds.spec.ts`.
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

const blockingOf = (validation: DocumentValidationDto) =>
  validation.violations
    .filter((item) => item.severity === 'BLOCKING')
    .map((item) => [item.code, item.field ?? item.sectionKey]);

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Elaborar DFD em wizard a partir de template (US-014)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let units: { cx: string; un: string; pct: string; kg: string };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const createDfd = (
    processId: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/dfds`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const listDfds = (processId: string, subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/dfds`), subject, tenant);
  const getDfd = (dfdId: string, subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/dfds/${dfdId}`), subject, tenant);
  const getItems = (documentId: string, subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/items`), subject, tenant);
  const putItems = (
    documentId: string,
    items: readonly Record<string, unknown>[],
    ifMatch: string | null = '"1"',
    subject = 'sub-ana',
  ) => {
    const call = auth(request(api.server).put(`/api/v1/documents/${documentId}/items`), subject);
    return (ifMatch === null ? call : call.set('If-Match', ifMatch)).send({ items });
  };
  const validation = async (documentId: string, subject = 'sub-ana') => {
    const response = await auth(
      request(api.server).get(`/api/v1/documents/${documentId}/validation`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return documentValidationSchema.parse(data(response));
  };
  const preview = (documentId: string, subject = 'sub-ana') =>
    auth(request(api.server).post(`/api/v1/documents/${documentId}/preview`), subject);
  const addProcessItem = (processId: string, body: Record<string, unknown>, subject = 'sub-ana') =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/items`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', ...body });

  const dfdStore = () => api.app.get(InMemoryDfdRepository, { strict: false });
  const dfdsOf = (processId: string) =>
    dfdStore()
      .snapshot()
      .filter((dfd) => dfd.processId === processId);
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const timelineOf = (processId: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId);
  const lastDfdNumber = () => numberSequencesOf(api).valueOf(A, SEQUENCE());

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
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    const process: Process = { ...created, ...fields };
    processRepositoryOf(api).replace(process);
    return process;
  }

  async function createOk(processId: string, options: { key?: string } = {}) {
    const response = await createDfd(processId, {}, options);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return dfdSchema.parse(data<DfdDto>(response));
  }

  async function itemOk(processId: string, description: string, unitOfMeasureId: string) {
    const response = await addProcessItem(processId, { description, unitOfMeasureId });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessItemDto>(response);
  }

  /** Processo do Background: itens 1 (luvas, CX) e 2 (seringas, UN). */
  async function background() {
    const process = await newProcess();
    const gloves = await itemOk(process.id, 'Luva de procedimento, tamanho M', units.cx);
    const syringes = await itemOk(process.id, 'Seringa descartável 5 ml', units.un);
    return { process, gloves, syringes };
  }

  /** Rascunho do DFD com seções e cabeçalho do cenário (o autosave é da US-015). */
  function fillDraft(
    dfd: DfdDto,
    sections: Partial<Record<'JUSTIFICATION' | 'EXPECTED_RESULTS', string>>,
    header: Partial<ReturnType<InMemoryDfdRepository['snapshot']>[number]> = {},
  ) {
    const document = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === dfd.documentId);
    if (!document) throw new Error('documento ausente');
    const next = { ...document.draftContent.sections };
    for (const [key, text] of Object.entries(sections)) next[key] = filledSection(text);
    documentRepositoryOf(api).seed({ ...document, draftContent: { sections: next } });
    const stored = dfdStore()
      .snapshot()
      .find((candidate) => candidate.id === dfd.id);
    if (!stored) throw new Error('DFD ausente');
    dfdStore().seed({ ...stored, ...header });
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
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.lucia.id),
      roleId: roles.get('PLANEJAMENTO')?.id ?? '',
    });
    units = {
      cx: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'CX'),
      un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
      pct: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'PCT'),
      kg: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'KG'),
    };
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
    // Background: o último número de DFD do tenant em 2026 é 4.
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
    it('Criar o DFD a partir do template padrão: DFD 0005/2026, valores do processo, 201 + Location/ETag, timeline, auditoria e evento', async () => {
      const process = await newProcess();
      const response = await createDfd(process.id);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const dfd = dfdSchema.parse(data(response));
      expect(
        dfdMetaSchema.parse((response.body as { meta: unknown }).meta).allowedActions,
      ).toContain('UPDATE');
      const meta = dfdMetaSchema.parse((response.body as { meta: unknown }).meta);
      // A versão fixada do template (seções, orientação e base legal) vem no `meta` (RN-DFD-07).
      expect(meta.template?.sections.map((section) => [section.key, section.requirement])).toEqual([
        ['JUSTIFICATION', 'REQUIRED'],
        ['EXPECTED_RESULTS', 'REQUIRED'],
        ['NOTES', 'OPTIONAL'],
      ]);
      expect(meta.template?.sections[0]).toMatchObject({
        title: 'Justificativa da necessidade',
        minChars: 50,
        legalBasis: 'Lei 14.133/2021, art. 12, VII; Decreto 10.947/2022, art. 8º, I',
      });
      expect(response.headers.location).toBe(`/api/v1/dfds/${dfd.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(dfd).toMatchObject({
        code: 'DFD 0005/2026',
        status: 'DRAFT',
        processId: process.id,
        documentId: dfd.id,
        title: `DFD — ${process.title}`,
        requestDate: TODAY,
        requestingDepartmentId: UNITS_A.manutencao,
        responsibleId: FAKE_USERS.ana.id,
        objectSummary: process.object,
        priority: 'MEDIUM',
        pcaStatus: 'NOT_APPLICABLE',
        expectedDate: null,
        estimatedValue: null,
        estimatedValueMasked: false,
        wizardStep: 'IDENTIFICATION',
        completedSteps: [],
        documentVersion: 1,
        version: 1,
      });

      // Versão 1 publicada do "DFD — Modelo padrão" com as três seções inicializadas (revisão 1).
      const { templates, versions } = templateRepositoryOf(api).snapshot();
      const dfdType = documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === 'DFD');
      const template = templates.find((item) => item.id === dfdType?.defaultTemplateId);
      const published = versions.find((item) => item.id === template?.currentPublishedVersionId);
      expect(published).toMatchObject({ versionNumber: 1, status: 'PUBLISHED' });
      expect(dfd.templateVersionId).toBe(published?.id);
      const [document] = documentsOf(process.id);
      expect(Object.keys(document?.draftContent.sections ?? {})).toEqual([
        'JUSTIFICATION',
        'EXPECTED_RESULTS',
        'NOTES',
      ]);
      expect(document?.draftContent.sections.JUSTIFICATION).toMatchObject({
        state: 'EMPTY',
        revision: 1,
      });
      expect(document).toMatchObject({
        responsibleId: FAKE_USERS.ana.id,
        singletonKey: dfdType?.id,
      });

      expect(timelineOf(process.id).map((row) => row.type)).toContain('DOCUMENT_CREATED');
      expect(auditOf(process.id, 'document.create')).toMatchObject([
        { entityId: dfd.id, metadata: { documentTypeCode: 'DFD', code: 'DFD 0005/2026' } },
      ]);
      expect(eventsOf(process.id, 'DocumentCreated')).toMatchObject([
        {
          routingKey: 'document.created.dfd',
          aggregateId: dfd.id,
          payload: {
            documentId: dfd.id,
            documentTypeCode: 'DFD',
            kind: 'STRUCTURED',
            code: 'DFD 0005/2026',
            templateVersionId: published?.id,
          },
        },
      ]);
      // RN-DFD-22: a criação não notifica.
      expect(api.outboxRows().filter((row) => row.eventType.startsWith('Notification'))).toEqual(
        [],
      );

      // DFD-03 e DFD-01: o wizard abre no passo indicado por `wizardStep`.
      const fetched = await getDfd(dfd.id);
      expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
      expect(fetched.headers.etag).toBe('"1"');
      expect(dfdSchema.parse(data(fetched))).toEqual(dfd);
      const listed = await listDfds(process.id);
      expect(listed.status).toBe(200);
      expect(z.array(dfdSummarySchema).parse(data(listed))).toEqual([
        {
          id: dfd.id,
          documentId: dfd.id,
          code: 'DFD 0005/2026',
          status: 'DRAFT',
          requestDate: TODAY,
          priority: 'MEDIUM',
          version: 1,
        },
      ]);
    });

    it('Informar itens e quantidades: 120.0000 e 5000.0000, document.items_update, novo ETag e checklist sem DFD_ITEMS_REQUIRED', async () => {
      const { process, gloves, syringes } = await background();
      const dfd = await createOk(process.id);
      expect(blockingOf(await validation(dfd.documentId))).toContainEqual([
        'DFD_ITEMS_REQUIRED',
        'items',
      ]);

      const saved = await putItems(dfd.documentId, [
        { processItemId: gloves.id, quantity: '120' },
        { processItemId: syringes.id, quantity: '5000' },
      ]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.headers.etag).toBe('"2"');
      const items = z.array(documentItemSchema).parse(data(saved));
      expect(items.map((item) => [item.sequence, item.quantity, item.unit.allowsDecimal])).toEqual([
        [1, '120.0000', false],
        [2, '5000.0000', false],
      ]);
      expect(auditOf(process.id, 'document.items_update')).toMatchObject([
        {
          entityId: dfd.documentId,
          metadata: { itemsCount: 2, documentCode: dfd.code },
          changes: [
            { path: `items.${gloves.id}.quantity`, old: null, new: '120.0000' },
            { path: `items.${syringes.id}.quantity`, old: null, new: '5000.0000' },
          ],
        },
      ]);
      // DOC-07 não emite evento de domínio.
      expect(api.outboxRows().filter((row) => row.aggregateId === dfd.documentId)).toHaveLength(1);

      const listed = await getItems(dfd.documentId);
      expect(listed.status).toBe(200);
      expect(listed.headers.etag).toBe('"2"');
      expect(data<DocumentItemDto[]>(listed)).toEqual(items);
      expect(blockingOf(await validation(dfd.documentId))).not.toContainEqual([
        'DFD_ITEMS_REQUIRED',
        'items',
      ]);

      // FA-10: desmarcar remove a linha; o item do processo permanece.
      const removed = await putItems(
        dfd.documentId,
        [{ processItemId: syringes.id, quantity: '5000' }],
        '"2"',
      );
      expect(data<DocumentItemDto[]>(removed).map((item) => item.processItemId)).toEqual([
        syringes.id,
      ]);
      expect(auditOf(process.id, 'document.items_update').at(-1)?.changes).toEqual([
        { path: `items.${gloves.id}.quantity`, old: '120.0000', new: null },
      ]);
      const processItems = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/items`),
      );
      expect(data<ProcessItemDto[]>(processItems)).toHaveLength(2);
      // O item referenciado pelo DFD aparece em uso no PRC-13 (US-006).
      expect(
        data<ProcessItemDto[]>(processItems).find((item) => item.id === syringes.id)?.references,
      ).toMatchObject([{ documentId: dfd.documentId, typeCode: 'DFD', editable: true }]);
      // ITEM_IN_USE (US-006): o item referenciado pelo DFD não pode ser excluído do processo.
      const removal = await auth(
        request(api.server).delete(`/api/v1/process-items/${syringes.id}`),
      ).set('If-Match', `"${String(syringes.version)}"`);
      expectProblem(removal, 409, 'ITEM_IN_USE');
    });

    it('Criar item do processo durante o Planejamento: item 3, ProcessItemsChanged e DFD com 40.0000', async () => {
      const { process, gloves } = await background();
      const dfd = await createOk(process.id);
      const cotton = await itemOk(process.id, 'Algodão hidrófilo 500 g', units.pct);
      expect(cotton.sequence).toBe(3);
      expect(eventsOf(process.id, 'ProcessItemsChanged').at(-1)?.payload).toMatchObject({
        added: [cotton.id],
        itemsCount: 3,
      });
      const saved = await putItems(dfd.documentId, [
        { processItemId: gloves.id, quantity: '120' },
        { processItemId: cotton.id, quantity: '40' },
      ]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(
        data<DocumentItemDto[]>(saved).map((item) => [item.description, item.quantity]),
      ).toContainEqual(['Algodão hidrófilo 500 g', '40.0000']);
    });

    it('Revisar sem pendências e pré-visualizar o PDF: checklist vazio, 202 com renditionId e document.render_request', async () => {
      const { process, gloves, syringes } = await background();
      const dfd = await createOk(process.id);
      await putItems(dfd.documentId, [
        { processItemId: gloves.id, quantity: '120' },
        { processItemId: syringes.id, quantity: '5000' },
      ]);
      fillDraft(
        dfd,
        { JUSTIFICATION: 'x'.repeat(380), EXPECTED_RESULTS: 'Atendimento contínuo da UBS Centro.' },
        { expectedDate: '2026-12-15', pcaStatus: 'PLANNED', pcaYear: 2026 },
      );
      const checklist = await validation(dfd.documentId);
      expect(checklist).toMatchObject({
        isComplete: true,
        summary: { blocking: 0, warnings: 0 },
        violations: [],
      });

      const requested = await preview(dfd.documentId);
      expect(requested.status, JSON.stringify(requested.body)).toBe(202);
      const rendition = data<{ id: string; status: string; kind: string }>(requested);
      expect(rendition).toMatchObject({ kind: 'PREVIEW', status: 'PENDING' });
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'document.render_request',
        entityId: rendition.id,
        processId: process.id,
        metadata: { kind: 'PREVIEW' },
      });
    });
  });

  describe('[Validação]', () => {
    it('Revisão aponta as 3 pendências obrigatórias: SECTION_REQUIRED (JUSTIFICATION), DFD_ITEMS_REQUIRED e FIELD_REQUIRED (expectedDate)', async () => {
      const { process } = await background();
      const dfd = await createOk(process.id);
      fillDraft(dfd, { EXPECTED_RESULTS: 'Atendimento contínuo da UBS Centro.' });
      const checklist = await validation(dfd.documentId);
      expect(checklist.isComplete).toBe(false);
      expect(checklist.summary.blocking).toBe(3);
      expect(blockingOf(checklist).sort()).toEqual(
        [
          ['SECTION_REQUIRED', 'JUSTIFICATION'],
          ['DFD_ITEMS_REQUIRED', 'items'],
          ['FIELD_REQUIRED', 'expectedDate'],
        ].sort(),
      );
      // RN-DFD-07: a justificativa curta bloqueia pelo minChars do template semeado.
      fillDraft(dfd, { JUSTIFICATION: 'Faltam luvas.' });
      expect((await validation(dfd.documentId)).violations).toContainEqual(
        expect.objectContaining({
          code: 'SECTION_TOO_SHORT',
          sectionKey: 'JUSTIFICATION',
          params: expect.objectContaining({ minChars: 50 }) as unknown,
        }),
      );
      // Previsão no passado e PCA previsto sem exercício (RN-DFD-11/13).
      fillDraft(
        dfd,
        {},
        {
          expectedDate: '2026-10-01',
          requestDate: '2026-09-30',
          pcaStatus: 'PLANNED',
          pcaYear: null,
        },
      );
      expect(blockingOf(await validation(dfd.documentId))).toEqual(
        expect.arrayContaining([
          ['DFD_EXPECTED_DATE_PAST', 'expectedDate'],
          ['DFD_PCA_INCOMPLETE', 'pcaYear'],
        ]),
      );
    });

    it('Quantidade inválida para a unidade: 2.5 em UN → 422 em items[1].quantity; demais regras de V-09/V-10', async () => {
      const { process, gloves, syringes } = await background();
      const dfd = await createOk(process.id);
      const fractional = await putItems(dfd.documentId, [
        { processItemId: gloves.id, quantity: '120' },
        { processItemId: syringes.id, quantity: '2.5' },
      ]);
      const problem = expectProblem(fractional, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'items[1].quantity',
          code: 'INVALID_DECIMAL',
          message: 'Esta unidade aceita apenas números inteiros.',
        },
      ]);
      const kilos = await itemOk(process.id, 'Sabão em pó', units.kg);
      expect(
        fieldErrors(
          await putItems(dfd.documentId, [
            { processItemId: gloves.id, quantity: '0' },
            { processItemId: gloves.id, quantity: '1' },
            { processItemId: kilos.id, quantity: '1.12345' },
            { processItemId: newId(), quantity: '1' },
          ]),
        ),
      ).toEqual([
        ['items[0].quantity', 'OUT_OF_RANGE'],
        ['items[1].processItemId', 'DUPLICATE_IN_LIST'],
        ['items[2].quantity', 'INVALID_DECIMAL'],
        ['items[3].processItemId', 'REFERENCE_NOT_FOUND'],
      ]);
      // Unidade que admite decimais aceita frações (FA-11).
      const ok = await putItems(dfd.documentId, [{ processItemId: kilos.id, quantity: '2.5' }]);
      expect(data<DocumentItemDto[]>(ok)[0]).toMatchObject({
        quantity: '2.5000',
        unit: { allowsDecimal: true },
      });
      expect(
        documentItemRepositoryOf(api)
          .snapshot()
          .filter((row) => row.documentId === dfd.documentId),
      ).toHaveLength(1);
      // V-11: sem If-Match → 428.
      expectProblem(await putItems(dfd.documentId, [], null), 428, 'PRECONDITION_REQUIRED');
    });

    it('V-01: template inexistente, de outro tipo ou inativo → 422 em templateId; nada criado', async () => {
      const process = await newProcess();
      const unknown = await createDfd(process.id, { templateId: newId() });
      expectProblem(unknown, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(unknown)).toEqual([['templateId', 'REFERENCE_NOT_FOUND']]);
      expect(problemDetailsSchema.parse(unknown.body).errors[0]?.message).toBe(
        'Selecione um modelo de DFD válido.',
      );
      const etpType = documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === 'ETP');
      const other = await createDfd(process.id, { templateId: etpType?.defaultTemplateId });
      expect(fieldErrors(other)).toEqual([['templateId', 'REFERENCE_NOT_FOUND']]);
      expect(fieldErrors(await createDfd(process.id, { templateId: 'x' }))).toEqual([
        ['templateId', 'INVALID_FORMAT'],
      ]);
      expect(dfdsOf(process.id)).toEqual([]);
      expect(documentsOf(process.id)).toEqual([]);
    });

    it('FA-09/V-04: etapa sem DFD → 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE; processo suspenso → 409 INVALID_PROCESS_STATUS', async () => {
      const process = await newProcess();
      const stage = workflowStagesOf(api, A).find(
        (candidate) =>
          candidate.key === 'ESTUDOS_PRELIMINARES' &&
          candidate.workflowVersionId === process.workflowVersionId,
      );
      processRepositoryOf(api).replace({
        ...process,
        status: 'IN_PROGRESS',
        currentWorkflowStageId: stage?.id ?? null,
      });
      const problem = expectProblem(
        await createDfd(process.id),
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
      );
      expect(problem.detail).toBe('O DFD não pode ser elaborado na etapa atual do processo.');
      processRepositoryOf(api).replace({ ...process, status: 'SUSPENDED' });
      expectProblem(await createDfd(process.id), 409, 'INVALID_PROCESS_STATUS');
      expect(dfdsOf(process.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem DFD_CREATE (SOMENTE_LEITURA): sem "Elaborar DFD" no painel e POST 403 PERMISSION_DENIED com access.denied DFD_CREATE', async () => {
      const process = await newProcess({ isBudgetConfidential: false });
      const panel = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/documents`),
        'sub-otavio',
      );
      expect(panel.status, JSON.stringify(panel.body)).toBe(200);
      const dfdType = documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === 'DFD');
      expect(
        (panel.body as { meta: { creatableTypeIds: string[] } }).meta.creatableTypeIds,
      ).not.toContain(dfdType?.id);
      const ownPanel = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/documents`),
      );
      expect(
        (ownPanel.body as { meta: { creatableTypeIds: string[] } }).meta.creatableTypeIds,
      ).toContain(dfdType?.id);

      const denied = await createDfd(process.id, {}, { subject: 'sub-otavio' });
      expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'DFD_CREATE',
      });
      expect(dfdsOf(process.id)).toEqual([]);

      // FA-05: quem só vê o processo lê o DFD em modo leitura (sem ações de edição).
      const dfd = await createOk(process.id);
      const readOnly = await getDfd(dfd.id, 'sub-otavio');
      expect(readOnly.status, JSON.stringify(readOnly.body)).toBe(200);
      expect((readOnly.body as { meta: { allowedActions: string[] } }).meta.allowedActions).toEqual(
        [],
      );
      expectProblem(
        await putItems(dfd.documentId, [], '"1"', 'sub-otavio'),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('DFD_CREATE sem custódia (POL-01): 403 NOT_PROCESS_CUSTODIAN', async () => {
      const process = await newProcess();
      const problem = expectProblem(
        await createDfd(process.id, {}, { subject: 'sub-lucia' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(problem.detail).toBe('Somente quem está com o processo pode realizar esta ação.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-01',
      });
    });

    it('Consultor participante: altera quantidades, não cria item do processo nem o DFD', async () => {
      const { process, gloves } = await background();
      const dfd = await createOk(process.id);
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'CONSULTANT',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      const view = await getDfd(dfd.id, 'sub-otavio');
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      expect((view.body as { meta: { allowedActions: string[] } }).meta.allowedActions).toContain(
        'UPDATE',
      );
      const saved = await putItems(
        dfd.documentId,
        [{ processItemId: gloves.id, quantity: '60' }],
        '"1"',
        'sub-otavio',
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expectProblem(
        await addProcessItem(
          process.id,
          { description: 'Máscara cirúrgica', unitOfMeasureId: units.cx },
          'sub-otavio',
        ),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await createDfd(process.id, {}, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('FA-06: orçamento sigiloso mascara a estimativa para quem não atende POL-09', async () => {
      const process = await newProcess();
      const dfd = await createOk(process.id);
      fillDraft(dfd, {}, { estimatedValue: '15000.00' });
      processRepositoryOf(api).replace({
        ...(processRepositoryOf(api)
          .allProcesses()
          .find((candidate) => candidate.id === process.id) ?? process),
        isBudgetConfidential: true,
      });
      expect(dfdSchema.parse(data(await getDfd(dfd.id)))).toMatchObject({
        estimatedValue: '15000.00',
        estimatedValueMasked: false,
      });
      expect(dfdSchema.parse(data(await getDfd(dfd.id, 'sub-otavio')))).toMatchObject({
        estimatedValue: null,
        estimatedValueMasked: true,
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('DFD de outro tenant → 404 DFD_NOT_FOUND; item de outro tenant no DOC-07 → 422 REFERENCE_NOT_FOUND sem revelar', async () => {
      const { process, gloves } = await background();
      const dfd = await createOk(process.id);
      const stored = dfdsOf(process.id)[0];
      if (!stored) throw new Error('DFD ausente');
      const foreign = { ...stored, id: newId(), tenantId: B, processId: newId() };
      dfdStore().seed({ ...foreign, documentId: foreign.id });

      const notFound = expectProblem(await getDfd(foreign.id), 404, 'DFD_NOT_FOUND');
      expect(notFound.detail).toBe('DFD não encontrado.');
      expect(JSON.stringify(notFound)).not.toContain(B);
      expectProblem(await getDfd(newId()), 404, 'DFD_NOT_FOUND');
      // O DFD de A visto por quem só tem vínculo em B: o tenant da requisição não o enxerga.
      expectProblem(await getDfd(dfd.id, 'sub-heitor', B), 404, 'DFD_NOT_FOUND');
      expectProblem(await getItems(dfd.documentId, 'sub-heitor', B), 404, 'NOT_FOUND');
      expectProblem(await listDfds(process.id, 'sub-heitor', B), 404, 'NOT_FOUND');

      const foreignItem = await putItems(dfd.documentId, [
        { processItemId: gloves.id, quantity: '1' },
        { processItemId: newId(), quantity: '1' },
      ]);
      expectProblem(foreignItem, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(foreignItem)).toEqual([['items[1].processItemId', 'REFERENCE_NOT_FOUND']]);
      expect(problemDetailsSchema.parse(foreignItem.body).errors[0]?.message).toBe(
        'Selecione itens deste processo, sem repetição.',
      );
    });

    it('Item de outro processo do mesmo tenant também é REFERENCE_NOT_FOUND', async () => {
      const { process } = await background();
      const dfd = await createOk(process.id);
      const other = await background();
      expect(
        fieldErrors(
          await putItems(dfd.documentId, [{ processItemId: other.gloves.id, quantity: '1' }]),
        ),
      ).toEqual([['items[0].processItemId', 'REFERENCE_NOT_FOUND']]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Processo que já possui o DFD: 409 DOCUMENT_ALREADY_EXISTS com o código para "Abrir DFD"', async () => {
      const process = await newProcess();
      const dfd = await createOk(process.id);
      const conflict = await createDfd(process.id);
      const problem = expectProblem(conflict, 409, 'DOCUMENT_ALREADY_EXISTS');
      expect(problem.detail).toBe(`Este processo já possui o ${dfd.code ?? ''}.`);
      expect(conflict.body).toMatchObject({
        meta: { existingDfdId: dfd.id, existingDocumentId: dfd.documentId, code: dfd.code },
      });
      expect(dfdsOf(process.id)).toHaveLength(1);
    });

    it('Duplo clique com a mesma chave: 201 com o mesmo DFD, Idempotent-Replayed e um só número consumido', async () => {
      const process = await newProcess();
      const before = lastDfdNumber();
      const key = randomUUID();
      const first = await createDfd(process.id, {}, { key });
      const replay = await createDfd(process.id, {}, { key });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.headers.location).toBe(first.headers.location);
      expect(data<DfdDto>(replay).id).toBe(data<DfdDto>(first).id);
      expect(dfdsOf(process.id)).toHaveLength(1);
      expect(lastDfdNumber()).toBe(before + 1);
      expectProblem(
        await createDfd(process.id, { templateId: newId() }, { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Criações simultâneas no mesmo processo: uma 201, outra 409, e o próximo DFD recebe o número seguinte sem lacuna', async () => {
      const process = await newProcess();
      const before = lastDfdNumber();
      const responses = await Promise.all([createDfd(process.id), createDfd(process.id)]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const winner = responses.find((response) => response.status === 201);
      const loser = responses.find((response) => response.status === 409);
      expect(data<DfdDto>(winner as request.Response).code).toBe(
        `DFD ${String(before + 1).padStart(4, '0')}/2026`,
      );
      expectProblem(loser as request.Response, 409, 'DOCUMENT_ALREADY_EXISTS');
      const next = await createOk((await newProcess()).id);
      expect(next.code).toBe(`DFD ${String(before + 2).padStart(4, '0')}/2026`);
    });

    it('Itens alterados por duas pessoas: o segundo If-Match antigo recebe 412 e, recarregado, preserva a alteração do primeiro', async () => {
      const { process, gloves, syringes } = await background();
      const dfd = await createOk(process.id);
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'CONSULTANT',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      const first = await putItems(
        dfd.documentId,
        [{ processItemId: gloves.id, quantity: '120' }],
        '"1"',
        'sub-otavio',
      );
      expect(first.status).toBe(200);
      const stale = await putItems(dfd.documentId, [
        { processItemId: syringes.id, quantity: '5000' },
      ]);
      const problem = expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(stale.body).toMatchObject({ currentVersion: 2 });
      expect(problem.detail).toBe(
        'Esta informação foi atualizada por outra pessoa. Recarregue e tente novamente.',
      );
      // O cliente recarrega (DOC-06), reaplica a sua alteração por processItemId e salva.
      const reloaded = await getItems(dfd.documentId);
      const merged = [
        ...data<DocumentItemDto[]>(reloaded).map(({ processItemId, quantity }) => ({
          processItemId,
          quantity,
        })),
        { processItemId: syringes.id, quantity: '5000' },
      ];
      const retried = await putItems(dfd.documentId, merged, reloaded.headers.etag ?? '');
      expect(retried.status).toBe(200);
      expect(data<DocumentItemDto[]>(retried).map((item) => item.quantity)).toEqual([
        '120.0000',
        '5000.0000',
      ]);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na criação: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido nem numerado', async () => {
      const process = await newProcess();
      const before = lastDfdNumber();
      transactions.down = true;
      const response = await createDfd(process.id);
      const problem = expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(problem.correlationId).toEqual(expect.any(String));
      transactions.down = false;
      expect(dfdsOf(process.id)).toEqual([]);
      expect(documentsOf(process.id)).toEqual([]);
      expect(eventsOf(process.id, 'DocumentCreated')).toEqual([]);
      expect(auditOf(process.id, 'document.create')).toEqual([]);
      expect(timelineOf(process.id).filter((row) => row.type === 'DOCUMENT_CREATED')).toEqual([]);
      expect(lastDfdNumber()).toBe(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Gotenberg indisponível: a prévia fica na fila (202 PENDING) e o DFD continua editável com o checklist disponível', async () => {
      const { process, gloves } = await background();
      const dfd = await createOk(process.id);
      expect((await preview(dfd.documentId)).status).toBe(202);
      const saved = await putItems(dfd.documentId, [{ processItemId: gloves.id, quantity: '1' }]);
      expect(saved.status).toBe(200);
      expect((await validation(dfd.documentId)).documentId).toBe(dfd.documentId);
    });

    it('ClamAV indisponível: anexo "Em verificação" gera só o alerta DFD_ATTACHMENTS_PENDING e a edição segue liberada', async () => {
      const { process, gloves, syringes } = await background();
      const dfd = await createOk(process.id);
      await putItems(dfd.documentId, [
        { processItemId: gloves.id, quantity: '120' },
        { processItemId: syringes.id, quantity: '5000' },
      ]);
      fillDraft(
        dfd,
        { JUSTIFICATION: 'x'.repeat(380), EXPECTED_RESULTS: 'Atendimento contínuo da UBS Centro.' },
        { expectedDate: '2026-12-15' },
      );
      seedScanningAttachment(api, {
        tenantId: A,
        processId: process.id,
        targetType: 'DOCUMENT',
        targetId: dfd.documentId,
        uploadedById: FAKE_USERS.ana.id,
        now: NOW,
      });
      const checklist = await validation(dfd.documentId);
      expect(checklist).toMatchObject({ isComplete: true, summary: { blocking: 0, warnings: 1 } });
      expect(checklist.violations).toEqual([
        expect.objectContaining({
          code: 'DFD_ATTACHMENTS_PENDING',
          severity: 'WARNING',
          field: 'attachments',
          params: { count: 1 },
        }),
      ]);
      expect((await putItems(dfd.documentId, [], '"2"')).status).toBe(200);
    });
  });
});

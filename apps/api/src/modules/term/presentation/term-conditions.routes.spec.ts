import { randomUUID } from 'node:crypto';

import {
  documentItemSchema,
  problemDetailsSchema,
  richTextFromPlainText,
  termSchema,
} from '@contrataflow/validation';
import type { ProcessDto, ProcessItemDto, TermDto } from '@contrataflow/validation';
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
  DOCUMENT_TRANSACTIONS,
  documentItemRepositoryOf,
  documentRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  catalogItemRepositoryOf,
  processItemRepositoryOf,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
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
 * US-038 — Especificar itens e condições contratuais do TR, pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, `If-Match`, filtro RFC 9457) com a identidade fake e
 * os seeders reais. Background: processo com os itens "1 — Cimento CP-II" e "2 — Areia média" na
 * etapa TERMO_REFERENCIA, TR em DRAFT sob custódia de Carla ("Lúcia" — PLANEJAMENTO). Bruno
 * ("Otávio") é SOMENTE_LEITURA. Itens pelo DOC-06/07 (genéricos, com especificação e critérios de
 * aceitação) e condições pelo TRM-04. As 8 categorias do Gherkin + FA-01/02/03/04 e V-04/V-09/V-10.
 * Atomicidade com falha induzida, unicidade e RLS no PostgreSQL: `test/tenant-leak/term-items.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';
const ANA = 'sub-ana';

const UNITS_A = {
  organizationId: '0192d038-0000-7000-8000-0000000000a0',
  obras: '0192d038-0000-7000-8000-0000000000a1',
  manutencao: '0192d038-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d038-0000-7000-8000-0000000000a3',
  saude: '0192d038-0000-7000-8000-0000000000a4',
  posto: '0192d038-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as dos módulos) que podem simular o banco fora do ar. */
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

const SPEC = richTextFromPlainText('Cimento Portland CP-II-E-32, saco de 50 kg.');
const CRITERIA = richTextFromPlainText('Laudo de conformidade com a NBR 16697.');

describe('Feature: Especificar itens e condições contratuais do TR (US-038)', () => {
  let api: TestApi;
  const terms = new FlakyTransactions();
  const documents = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; un: string; kg: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = CARLA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const post = (path: string, subject = CARLA) =>
    auth(request(api.server).post(`/api/v1${path}`), subject);
  const patchTerm = (
    id: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string; subject?: string } = {},
  ) =>
    auth(request(api.server).patch(`/api/v1/terms/${id}`), options.subject)
      .set('If-Match', options.ifMatch ?? '"1"')
      .send(body);
  const putItems = (
    documentId: string,
    items: readonly Record<string, unknown>[],
    options: { ifMatch?: string; subject?: string } = {},
  ) =>
    auth(request(api.server).put(`/api/v1/documents/${documentId}/items`), options.subject)
      .set('If-Match', options.ifMatch ?? `"${String(documentOf(documentId).version)}"`)
      .send({ items });
  const getItems = (documentId: string, subject = CARLA) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/items`), subject);

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
  const rowsOf = (documentId: string) =>
    documentItemRepositoryOf(api)
      .snapshot()
      .filter((item) => item.documentId === documentId);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const stageId = (process: Process, key: string) =>
    workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === key && candidate.workflowVersionId === process.workflowVersionId,
    )?.id ?? null;
  const moveTo = (process: Process, fields: Partial<Process>) => {
    const current =
      processRepositoryOf(api)
        .allProcesses()
        .find((candidate) => candidate.id === process.id) ?? process;
    const next = { ...current, ...fields };
    processRepositoryOf(api).replace(next);
    return next;
  };

  async function itemOk(processId: string, description: string, unitOfMeasureId: string) {
    const response = await post(`/processes/${processId}/items`, ANA)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description, unitOfMeasureId });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessItemDto>(response);
  }

  /** Background: processo com "1 — Cimento CP-II" e "2 — Areia média"; TR em DRAFT de Carla. */
  async function background() {
    const response = await post('/processes', ANA)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Materiais de construção ${words(2)}`,
        object: `Aquisição de materiais de construção para as obras ${words(2)}`,
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
    const cement = await itemOk(processId, 'Cimento CP-II', catalog.un);
    const sand = await itemOk(processId, 'Areia média', catalog.kg);
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === processId);
    if (!created) throw new Error('processo ausente');
    const process = moveTo(created, {
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId(created, 'TERMO_REFERENCIA'),
      currentResponsibleId: FAKE_USERS.lucia.id,
    });
    const termResponse = await post(`/processes/${process.id}/terms`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(termResponse.status, JSON.stringify(termResponse.body)).toBe(201);
    return { process, term: termSchema.parse(data(termResponse)), cement, sand };
  }

  const twoItems = (cement: ProcessItemDto, sand: ProcessItemDto) => [
    {
      processItemId: cement.id,
      quantity: '100',
      specification: SPEC,
      acceptanceCriteria: CRITERIA,
      sortOrder: 0,
    },
    { processItemId: sand.id, quantity: '50', specification: SPEC, sortOrder: 1 },
  ];

  const CONDITIONS = () => ({
    contractDurationMonths: 12,
    executionDeadline: 30,
    executionDeadlineType: 'CALENDAR',
    paymentTermDays: 30,
    contractGuaranteePercent: '5',
    selectionCriterionId: catalogItemId(api, A, 'JUDGMENT_CRITERION', 'MENOR_PRECO'),
    awardType: 'BY_ITEM',
  });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: TERM_TRANSACTIONS, value: terms },
        { token: DOCUMENT_TRANSACTIONS, value: documents },
        { token: TERM_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, B, ['catalog.items']);
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
      kg: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'KG'),
    };
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    terms.down = false;
    documents.down = false;
  });

  describe('[Sucesso]', () => {
    it('Incluir itens com quantidade, especificação e critérios de aceitação (DOC-07 → DOC-06)', async () => {
      const { process, term, cement, sand } = await background();
      const response = await putItems(term.documentId, twoItems(cement, sand));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(`"${String(documentOf(term.documentId).version)}"`);
      const saved = z.array(documentItemSchema).parse(data(response));
      expect(saved.map((item) => [item.sequence, item.quantity])).toEqual([
        [1, '100.0000'],
        [2, '50.0000'],
      ]);
      expect(saved[0]).toMatchObject({ specification: SPEC, acceptanceCriteria: CRITERIA });
      expect(saved[1]).toMatchObject({ specification: SPEC, acceptanceCriteria: null });

      const listed = await getItems(term.documentId);
      expect(listed.status).toBe(200);
      expect(z.array(documentItemSchema).parse(data(listed))).toEqual(saved);

      // RN-TR-33: ajuste de rascunho — sem versão nova do documento.
      expect(documentOf(term.documentId).currentVersionId).toBeNull();
      const [audit] = auditOf(process.id, 'document.items_update');
      expect(audit?.metadata).toMatchObject({ documentTypeCode: 'TR', itemsCount: 2 });
      // Texto só como hash + tamanho (story · "Auditoria").
      const changes = (audit?.changes ?? []) as { path: string; new: unknown }[];
      const specChange = changes.find(
        (change) => change.path === `items.${cement.id}.specification`,
      );
      expect(specChange?.new).toEqual({
        sha256: expect.any(String) as unknown,
        bytes: expect.any(Number) as unknown,
      });
      expect(JSON.stringify(audit)).not.toContain('Portland');
    });

    it('Definir as condições contratuais (TRM-04) audita document.draft_update sem versão nova', async () => {
      const { process, term } = await background();
      const response = await patchTerm(term.id, {
        ...CONDITIONS(),
        deliveryLocation: 'Almoxarifado central, Rua das Obras, 100',
        productWarrantyMonths: 12,
        allowsSubcontracting: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      const saved = termSchema.parse(data<TermDto>(response));
      expect(saved).toMatchObject({
        contractDurationMonths: 12,
        executionDeadline: 30,
        executionDeadlineType: 'CALENDAR',
        paymentTermDays: 30,
        productWarrantyMonths: 12,
        contractGuaranteePercent: '5',
        allowsSubcontracting: true,
        selectionCriterionId: CONDITIONS().selectionCriterionId,
        awardType: 'BY_ITEM',
        deliveryLocation: 'Almoxarifado central, Rua das Obras, 100',
        version: 2,
      });
      expect(termOf(term.id)).toMatchObject({ contractGuaranteePercent: '5', version: 2 });
      expect(documentOf(term.documentId).currentVersionId).toBeNull();
      const [audit] = auditOf(process.id, 'document.draft_update');
      expect(audit?.changes).toEqual(
        expect.arrayContaining([
          { path: 'contractDurationMonths', old: null, new: 12 },
          { path: 'contractGuaranteePercent', old: null, new: '5' },
          { path: 'awardType', old: null, new: 'BY_ITEM' },
        ]),
      );
      // Local de entrega só como hash + tamanho.
      expect(JSON.stringify(audit)).not.toContain('Almoxarifado');
    });

    it('Limpar uma condição com null e reenviar os mesmos valores não grava nada novo', async () => {
      const { process, term } = await background();
      expect((await patchTerm(term.id, CONDITIONS())).status).toBe(200);
      const same = await patchTerm(
        term.id,
        { ...CONDITIONS(), contractGuaranteePercent: '5.00' },
        {
          ifMatch: '"2"',
        },
      );
      expect(same.status).toBe(200);
      expect(termOf(term.id).version).toBe(2);
      const cleared = await patchTerm(
        term.id,
        { executionDeadline: null, executionDeadlineType: null, contractGuaranteePercent: null },
        { ifMatch: '"2"' },
      );
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(termOf(term.id)).toMatchObject({
        executionDeadline: null,
        executionDeadlineType: null,
        contractGuaranteePercent: null,
        contractDurationMonths: 12,
        version: 3,
      });
      expect(auditOf(process.id, 'document.draft_update')).toHaveLength(2);
    });

    it('FA-01/FA-03: remover e reordenar itens não afeta o item do processo', async () => {
      const { term, cement, sand } = await background();
      expect((await putItems(term.documentId, twoItems(cement, sand))).status).toBe(200);
      const reordered = await putItems(term.documentId, [
        { processItemId: sand.id, quantity: '50', sortOrder: 0 },
        { processItemId: cement.id, quantity: '100', sortOrder: 1 },
      ]);
      expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
      expect(
        z
          .array(documentItemSchema)
          .parse(data(reordered))
          .map((item) => item.sequence),
      ).toEqual([2, 1]);
      // Ausentes no corpo, especificação e critérios se mantêm.
      expect(rowsOf(term.documentId).find((row) => row.processItemId === cement.id)).toMatchObject({
        specification: SPEC,
        acceptanceCriteria: CRITERIA,
        sortOrder: 1,
      });

      const removed = await putItems(term.documentId, [
        { processItemId: sand.id, quantity: '50', sortOrder: 0, specification: null },
      ]);
      expect(removed.status).toBe(200);
      expect(rowsOf(term.documentId).map((row) => row.processItemId)).toEqual([sand.id]);
      expect(rowsOf(term.documentId)[0]?.specification).toBeNull();
      expect(
        processItemRepositoryOf(api)
          .all()
          .find((item) => item.id === cement.id)?.deletedAt,
      ).toBeNull();
    });
  });

  describe('[Validação]', () => {
    it('Quantidade inválida: 422 VALIDATION_ERROR no campo quantity e nada gravado', async () => {
      const { term, cement } = await background();
      const response = await putItems(term.documentId, [
        { processItemId: cement.id, quantity: '0' },
      ]);
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'items[0].quantity', code: 'OUT_OF_RANGE' }),
      ]);
      expect(rowsOf(term.documentId)).toEqual([]);
    });

    it('Prazo de execução sem o tipo de contagem: 422 CONDITIONAL_REQUIRED em executionDeadlineType', async () => {
      const { term } = await background();
      const response = await patchTerm(term.id, { executionDeadline: 30 });
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'executionDeadlineType',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Informe o tipo de contagem do prazo.',
        }),
      ]);
      const reverse = await patchTerm(term.id, { executionDeadlineType: 'BUSINESS' });
      expect(expectProblem(reverse, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'executionDeadline', code: 'CONDITIONAL_REQUIRED' }),
      ]);
      expect(termOf(term.id).version).toBe(1);
    });

    it('Garantia contratual acima do limite legal: 422 OUT_OF_RANGE em contractGuaranteePercent', async () => {
      const { term } = await background();
      const response = await patchTerm(term.id, { contractGuaranteePercent: '15' });
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'contractGuaranteePercent',
          code: 'OUT_OF_RANGE',
          message: 'A garantia contratual não pode superar 10% (arts. 96–98).',
        }),
      ]);
      expect(termOf(term.id).contractGuaranteePercent).toBeNull();
    });

    it.each([
      ['contractDurationMonths', 0, 'A vigência deve estar entre 1 e 120 meses.'],
      ['contractDurationMonths', 121, 'A vigência deve estar entre 1 e 120 meses.'],
      ['paymentTermDays', 0, 'O prazo de pagamento deve estar entre 1 e 90 dias.'],
      ['paymentTermDays', 91, 'O prazo de pagamento deve estar entre 1 e 90 dias.'],
      ['productWarrantyMonths', 121, 'A garantia do objeto deve estar entre 0 e 120 meses.'],
      ['productWarrantyMonths', -1, 'A garantia do objeto deve estar entre 0 e 120 meses.'],
    ])('Limite legal: %s = %s → 422 OUT_OF_RANGE', async (field, value, message) => {
      const { term } = await background();
      const response = await patchTerm(term.id, { [field]: value });
      expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field, code: 'OUT_OF_RANGE', message }),
      ]);
    });

    it('Limites inclusivos aceitos: vigência 120, pagamento 90, garantia do objeto 0 e garantia contratual 10', async () => {
      const { term } = await background();
      const response = await patchTerm(term.id, {
        contractDurationMonths: 120,
        paymentTermDays: 90,
        productWarrantyMonths: 0,
        contractGuaranteePercent: '10.0000',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(termOf(term.id)).toMatchObject({ contractGuaranteePercent: '10' });
    });

    it('V-09: critério de julgamento inexistente, de outro catálogo ou inativo', async () => {
      const { term } = await background();
      const missing = await patchTerm(term.id, { selectionCriterionId: newId() });
      expect(expectProblem(missing, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'selectionCriterionId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      const otherCatalog = await patchTerm(term.id, { selectionCriterionId: catalog.un });
      expect(expectProblem(otherCatalog, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'selectionCriterionId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      const base = catalogItemRepositoryOf(api)
        .snapshot()
        .find((item) => item.tenantId === A && item.code === 'MAIOR_LANCE');
      if (!base) throw new Error('critério ausente');
      const inactive = { ...base, id: newId(), code: `INATIVO_${words(1)}`, isActive: false };
      catalogItemRepositoryOf(api).seed(inactive);
      const response = await patchTerm(term.id, { selectionCriterionId: inactive.id });
      expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({
          field: 'selectionCriterionId',
          code: 'REFERENCE_INACTIVE',
          message: 'Selecione um critério de julgamento válido.',
        }),
      ]);
    });

    it('V-04: rich text fora do schema → 422 RICH_TEXT_INVALID; acima de 50.000 caracteres → TOO_LONG', async () => {
      const { term, cement } = await background();
      const invalid = await putItems(term.documentId, [
        {
          processItemId: cement.id,
          quantity: '1',
          specification: { type: 'doc', content: [{ type: 'iframe' }] },
        },
      ]);
      expectProblem(invalid, 422, 'RICH_TEXT_INVALID');
      const long = await putItems(term.documentId, [
        {
          processItemId: cement.id,
          quantity: '1',
          acceptanceCriteria: richTextFromPlainText('a'.repeat(50_001)),
        },
      ]);
      expect(expectProblem(long, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'items[0].acceptanceCriteria', code: 'TOO_LONG' }),
      ]);
      expect(rowsOf(term.documentId)).toEqual([]);
    });

    it('Observações do item no TR vão até 5.000 caracteres', async () => {
      const { term, cement } = await background();
      const ok = await putItems(term.documentId, [
        { processItemId: cement.id, quantity: '1', notes: 'x'.repeat(5000) },
      ]);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const tooLong = await putItems(term.documentId, [
        { processItemId: cement.id, quantity: '1', notes: 'x'.repeat(5001) },
      ]);
      expect(expectProblem(tooLong, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'items[0].notes', code: 'TOO_LONG' }),
      ]);
    });

    it('V-10: TR fora de DRAFT/RETURNED → 409 DOCUMENT_NOT_EDITABLE (itens e condições)', async () => {
      const { term, cement } = await background();
      documentRepositoryOf(api).seed({ ...documentOf(term.documentId), status: 'FINALIZED' });
      expectProblem(await patchTerm(term.id, CONDITIONS()), 409, 'DOCUMENT_NOT_EDITABLE');
      expectProblem(
        await putItems(term.documentId, [{ processItemId: cement.id, quantity: '1' }]),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
    });

    it('FA-02: item incluído no TR não pode ser excluído do processo (409 ITEM_IN_USE)', async () => {
      const { term, cement, sand } = await background();
      expect((await putItems(term.documentId, twoItems(cement, sand))).status).toBe(200);
      const removal = await auth(
        request(api.server).delete(`/api/v1/process-items/${cement.id}`),
      ).set('If-Match', `"${String(cement.version)}"`);
      expectProblem(removal, 409, 'ITEM_IN_USE');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem TERM_UPDATE: PATCH e PUT dos itens → 403 PERMISSION_DENIED com access.denied', async () => {
      const { term, cement } = await background();
      const response = await patchTerm(term.id, CONDITIONS(), { subject: BRUNO });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'TERM_UPDATE',
      });
      const items = await putItems(term.documentId, [{ processItemId: cement.id, quantity: '1' }], {
        subject: BRUNO,
      });
      expectProblem(items, 403, 'PERMISSION_DENIED');
      expect(termOf(term.id).version).toBe(1);
      expect(rowsOf(term.documentId)).toEqual([]);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Item de outro tenant: 422 REFERENCE_NOT_FOUND em processItemId sem revelar dados', async () => {
      const { term } = await background();
      const foreign = newId();
      processItemRepositoryOf(api).seed({
        id: foreign,
        tenantId: B,
        processId: newId(),
        sequence: 1,
        lotNumber: null,
        lotName: null,
        kind: 'GOOD',
        description: 'Segredo da Prefeitura B',
        unitOfMeasureId: catalogItemId(api, B, 'UNIT_OF_MEASURE', 'UN'),
        catalogSystem: null,
        catalogCode: null,
        notes: null,
        referenceQuantity: null,
        referenceQuantitySourceDocumentId: null,
        referenceUnitPrice: null,
        referenceUnitPriceSourceDocumentId: null,
        createdAt: NOW,
        updatedAt: NOW,
        createdById: null,
        updatedById: null,
        version: 1,
      });
      const response = await putItems(term.documentId, [{ processItemId: foreign, quantity: '1' }]);
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'items[0].processItemId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(JSON.stringify(response.body)).not.toContain('Segredo');
    });

    it('Critério de julgamento de outro tenant: 422 REFERENCE_NOT_FOUND', async () => {
      const { term } = await background();
      const response = await patchTerm(term.id, {
        selectionCriterionId: catalogItemId(api, B, 'JUDGMENT_CRITERION', 'MENOR_PRECO'),
      });
      expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'selectionCriterionId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
    });

    it('TR de outro tenant: 404 NOT_FOUND no TRM-04; DOC-06 nada revela', async () => {
      const { term } = await background();
      const patch = await auth(
        request(api.server).patch(`/api/v1/terms/${term.id}`),
        'sub-fabio',
        B,
      )
        .set('If-Match', '"1"')
        .send(CONDITIONS());
      expectProblem(patch, 404, 'NOT_FOUND');
      const items = await auth(
        request(api.server).get(`/api/v1/documents/${term.documentId}/items`),
        'sub-fabio',
        B,
      );
      // Fábio é CONSULTOR_EXTERNO na Prefeitura B, sem PROCESS_VIEW: a rota nega antes de buscar.
      expectProblem(items, 403, 'PERMISSION_DENIED');
      expect(JSON.stringify(items.body)).not.toContain('Cimento');
      expect(termOf(term.id).version).toBe(1);
    });
  });

  describe('[Duplicidade]', () => {
    it('Item repetido na lista: 422 DUPLICATE_IN_LIST', async () => {
      const { term, cement } = await background();
      const response = await putItems(term.documentId, [
        { processItemId: cement.id, quantity: '1' },
        { processItemId: cement.id, quantity: '2' },
      ]);
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'items[1].processItemId',
          code: 'DUPLICATE_IN_LIST',
          message: 'Este item já está na lista.',
        }),
      ]);
    });
  });

  describe('[Concorrência]', () => {
    it('Edição simultânea das condições: If-Match "1" depois da versão 2 → 412 VERSION_CONFLICT', async () => {
      const { term } = await background();
      expect((await patchTerm(term.id, { contractDurationMonths: 6 })).status).toBe(200);
      const stale = await patchTerm(term.id, CONDITIONS(), { ifMatch: '"1"' });
      const body = expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(body).toMatchObject({ currentVersion: 2 });
      expect(termOf(term.id).contractDurationMonths).toBe(6);
    });

    it('Duas gravações simultâneas com o mesmo If-Match: uma 200, outra 412', async () => {
      const { term } = await background();
      const [first, second] = await Promise.all([
        patchTerm(term.id, { contractDurationMonths: 6 }),
        patchTerm(term.id, { contractDurationMonths: 24 }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 412]);
      expect(termOf(term.id).version).toBe(2);
    });

    it('Itens com If-Match do documento divergente → 412 VERSION_CONFLICT', async () => {
      const { term, cement, sand } = await background();
      const version = documentOf(term.documentId).version;
      expect((await putItems(term.documentId, twoItems(cement, sand))).status).toBe(200);
      const stale = await putItems(term.documentId, [{ processItemId: cement.id, quantity: '7' }], {
        ifMatch: `"${String(version)}"`,
      });
      expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(rowsOf(term.documentId)).toHaveLength(2);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao salvar os itens: 503 DEPENDENCY_UNAVAILABLE e nada alterado', async () => {
      const { term, cement, sand } = await background();
      expect((await putItems(term.documentId, twoItems(cement, sand))).status).toBe(200);
      const before = rowsOf(term.documentId);
      documents.down = true;
      const response = await putItems(term.documentId, [
        { processItemId: cement.id, quantity: '9' },
      ]);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      documents.down = false;
      expect(rowsOf(term.documentId)).toEqual(before);
    });

    it('Banco indisponível ao salvar as condições: 503 DEPENDENCY_UNAVAILABLE', async () => {
      const { term } = await background();
      terms.down = true;
      expectProblem(await patchTerm(term.id, CONDITIONS()), 503, 'DEPENDENCY_UNAVAILABLE');
      terms.down = false;
      expect(termOf(term.id).version).toBe(1);
    });
  });
});

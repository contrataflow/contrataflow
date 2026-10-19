import { randomUUID } from 'node:crypto';

import {
  priceItemSchema,
  priceResearchRecalculationSchema,
  priceResearchSchema,
  priceSourceSchema,
  problemDetailsSchema,
  quotationSchema,
} from '@contrataflow/validation';
import type { ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { InMemoryObjectStorage } from '#shared/storage/in-memory-object-storage.js';
import { OBJECT_STORAGE } from '#shared/storage/storage.service.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { documentRepositoryOf } from '../../../../test/support/document-fixtures.js';
import { buildSupplier, seedSuppliers } from '../../../../test/support/price-source-fixtures.js';
import type { Supplier } from '../../../../test/support/price-source-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  setProcessItemReferenceQuantity,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { PRICE_RESEARCH_CLOCK, PRICE_RESEARCH_TRANSACTIONS } from '../application/ports.js';
import type { PriceResearchTransactions } from '../application/ports.js';

/*
 * US-029 — Calcular estatísticas e valor estimado por item (PRS-04/05/07/20), pelo pipeline HTTP
 * completo (autenticação, tenant, vínculo, autorização, `If-Match`, filtro RFC 9457) com a
 * identidade fake e os seeders reais. Background: processo com 2 itens na etapa PESQUISA_PRECOS, a
 * pesquisa em DRAFT (AUTO_CV, limiar 25, 2 casas, HALF_UP) e três fontes com cotações. Fábio
 * (COMPRAS, responsável) é o "Marcos"; Ana (REQUISITANTE — só PROCESS_VIEW) é o "Bruno". As 8
 * categorias do Gherkin + FA-01..FA-06. RLS, CHECK do método manual e outbox PENDING no
 * PostgreSQL: `test/tenant-leak/price-calculation.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-06T15:00:00.000Z');
const TODAY = '2026-10-06';
const MARCOS = 'sub-fabio';
const BRUNO = 'sub-ana';

const UNITS_A = {
  organizationId: '0192d026-0000-7000-8000-0000000000a0',
  obras: '0192d026-0000-7000-8000-0000000000a1',
  manutencao: '0192d026-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d026-0000-7000-8000-0000000000a3',
  saude: '0192d026-0000-7000-8000-0000000000a4',
  posto: '0192d026-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d026-0000-7000-8000-0000000000b0',
  obras: '0192d026-0000-7000-8000-0000000000b1',
  manutencao: '0192d026-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d026-0000-7000-8000-0000000000b3',
  saude: '0192d026-0000-7000-8000-0000000000b4',
  posto: '0192d026-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as do módulo) que podem simular o banco fora do ar. */
class FlakyTransactions implements PriceResearchTransactions {
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

const supplierOf = buildSupplier;

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Calcular estatísticas e valor estimado por item (US-029)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  let units: { sc: string; m3: string };
  let catalog: { contractingType: string; origin: string };
  let types: Record<string, string>;
  let supplierA: Supplier;
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = MARCOS, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const withIfMatch = (call: request.Test, ifMatch: string | null) =>
    ifMatch === null ? call : call.set('If-Match', ifMatch);
  const createSource = (
    researchId: string,
    body: Record<string, unknown>,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/price-research/${researchId}/sources`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const putGrid = (
    sourceId: string,
    items: readonly Record<string, unknown>[],
    ifMatch: string | null,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) => {
    const call = withIfMatch(
      auth(
        request(api.server).put(`/api/v1/price-sources/${sourceId}/quotations`),
        options.subject,
        options.tenant,
      ),
      ifMatch,
    );
    return (options.key === undefined ? call : call.set('Idempotency-Key', options.key)).send({
      items,
    });
  };
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
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

  async function newProcess(): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana')
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição de materiais de construção ${words(2)}`,
        object: `Aquisição de materiais para a reforma da escola ${words(2)}`,
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
    return created;
  }

  async function itemOk(processId: string, body: Record<string, unknown>, quantity: string) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/items`),
      'sub-ana',
    )
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const item = data<ProcessItemDto>(response);
    setProcessItemReferenceQuantity(api, item.id, `${quantity}.0000`);
    return item;
  }

  /** Background: processo "0012/2026" com 2 itens e a pesquisa de preços em DRAFT. */
  async function background() {
    const created = await newProcess();
    await itemOk(
      created.id,
      { description: 'Cimento CP II 50 kg', unitOfMeasureId: units.sc },
      '100',
    );
    await itemOk(created.id, { description: 'Areia média', unitOfMeasureId: units.m3 }, '12');
    const process = moveTo(created, {
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId(created, 'PESQUISA_PRECOS'),
      currentResponsibleId: FAKE_USERS.fabio.id,
    });
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${process.id}/price-research`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({ referenceDate: TODAY });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const research = priceResearchSchema.parse(data(response));
    const itemsResponse = await auth(
      request(api.server).get(`/api/v1/price-research/${research.id}/items`),
    );
    const [first, second] = z.array(priceItemSchema).parse(data(itemsResponse));
    if (!first || !second) throw new Error('itens ausentes');
    return { process, research, first, second };
  }

  const directBody = (overrides: Record<string, unknown> = {}) => ({
    sourceTypeId: types.PESQUISA_DIRETA_FORNECEDOR,
    description: 'Orçamento Construtora XYZ',
    supplierId: supplierA.id,
    quoteDate: '2026-09-30',
    supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
    ...overrides,
  });

  async function sourceOk(researchId: string, body: Record<string, unknown> = directBody()) {
    const response = await createSource(researchId, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return priceSourceSchema.parse(data(response));
  }

  async function gridOk(
    sourceId: string,
    items: readonly Record<string, unknown>[],
    ifMatch: string,
  ) {
    const response = await putGrid(sourceId, items, ifMatch);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      quotations: z.array(quotationSchema).parse(data(response)),
      etag: response.headers.etag,
    };
  }

  async function itemsOf(researchId: string) {
    const response = await auth(
      request(api.server).get(`/api/v1/price-research/${researchId}/items`),
    );
    return z.array(priceItemSchema).parse(data(response));
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PRICE_RESEARCH_TRANSACTIONS, value: transactions },
        { token: PRICE_RESEARCH_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: OBJECT_STORAGE, value: storage },
      ],
    });
    const seeders = [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    units = {
      sc: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
      m3: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'M3'),
    };
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
    types = Object.fromEntries(
      [
        'PESQUISA_DIRETA_FORNECEDOR',
        'SITIO_ELETRONICO',
        'CONTRATACAO_SIMILAR',
        'TABELA_REFERENCIA',
        'OUTRA',
      ].map((code) => [code, catalogItemId(api, A, 'PRICE_SOURCE_TYPE', code)]),
    );
    supplierA = supplierOf(A);
    seedSuppliers(api, supplierA);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    storage.failing = null;
  });

  const JUSTIFICATION = 'Valor de ata vigente do consórcio regional de saúde';

  const patchItem = (
    itemId: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    subject = MARCOS,
    tenant: string = A,
  ) =>
    withIfMatch(
      auth(request(api.server).patch(`/api/v1/price-items/${itemId}`), subject, tenant),
      ifMatch,
    ).send(body);
  const patchResearch = (
    researchId: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    subject = MARCOS,
  ) =>
    withIfMatch(
      auth(request(api.server).patch(`/api/v1/price-research/${researchId}`), subject),
      ifMatch,
    ).send(body);
  const recalculate = (researchId: string, subject = MARCOS, tenant: string = A) =>
    auth(
      request(api.server).post(`/api/v1/price-research/${researchId}/recalculate`),
      subject,
      tenant,
    ).send({});
  const excludeQuotation = (quotationId: string, ifMatch: string) =>
    withIfMatch(
      auth(request(api.server).post(`/api/v1/quotations/${quotationId}/exclude`)),
      ifMatch,
    ).send({ exclusionReason: 'INCONSISTENT', exclusionJustification: JUSTIFICATION });

  const itemOf = async (researchId: string, itemId: string) => {
    const found = (await itemsOf(researchId)).find((candidate) => candidate.id === itemId);
    if (!found) throw new Error('item ausente');
    return found;
  };
  const researchOf = async (researchId: string) => {
    const response = await auth(request(api.server).get(`/api/v1/price-research/${researchId}`));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return priceResearchSchema.parse(data(response));
  };

  /**
   * Background da story: "Item 1" com 100, 110 e 90 e "Item 2" com 100, 200 e 90 — uma fonte por
   * coluna — e os parâmetros AUTO_CV, limiar 25, 2 casas e HALF_UP.
   */
  async function withQuotations() {
    const context = await background();
    const header = await researchOf(context.research.id);
    const params = await patchResearch(
      context.research.id,
      {
        defaultMethod: 'AUTO_CV',
        cvThresholdPercent: '25',
        unitPriceDecimals: 2,
        roundingMode: 'HALF_UP',
      },
      `"${String(header.version)}"`,
    );
    expect(params.status, JSON.stringify(params.body)).toBe(200);
    const columns = [
      ['100.00', '100.00'],
      ['110.00', '200.00'],
      ['90.00', '90.00'],
    ];
    const quotations = [];
    for (const [index, [first, second]] of columns.entries()) {
      const source = await sourceOk(
        context.research.id,
        directBody({ description: `Orçamento ${String(index + 1)} ${words(1)}` }),
      );
      const grid = await gridOk(
        source.id,
        [
          { priceItemId: context.first.id, unitPrice: first },
          { priceItemId: context.second.id, unitPrice: second },
        ],
        '"1"',
      );
      quotations.push(...grid.quotations);
    }
    return { ...context, quotations };
  }

  describe('[Sucesso]', () => {
    it('CV baixo e método automático escolhendo a média: estatísticas, recomendado, total, auditoria e evento', async () => {
      const { process, research, first } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      const response = await patchItem(first.id, { quantity: '50' }, `"${String(before.version)}"`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const item = priceItemSchema.parse(data(response));
      expect(item).toMatchObject({
        quantity: '50.0000',
        validQuotationsCount: 3,
        meanPrice: '100.0000',
        medianPrice: '100.0000',
        lowestPrice: '90.0000',
        highestPrice: '110.0000',
        stdDeviation: '10.0000',
        coefficientOfVariation: '10.0000',
        effectiveMethod: 'MEAN',
        recommendedUnitPrice: '100.0000',
        totalPrice: '5000.00',
        version: before.version + 1,
      });
      expect(response.headers.etag).toBe(`"${String(before.version + 1)}"`);
      // PRS-05 reflete o mesmo cálculo (a tela invalida a consulta de itens).
      expect(await itemOf(research.id, first.id)).toMatchObject({
        recommendedUnitPrice: '100.0000',
        totalPrice: '5000.00',
      });
      const recalculated = auditOf(process.id, 'price_research.recalculate');
      expect(recalculated.at(-1)).toMatchObject({
        entityType: 'PriceResearch',
        metadata: { trigger: 'ITEM_UPDATE', itemsCount: 2 },
      });
      expect(JSON.stringify(recalculated)).not.toContain('5000');
      const events = eventsOf(process.id, 'PriceResearchRecalculated');
      expect(events.at(-1)?.payload).toEqual({
        priceResearchId: research.id,
        itemsCount: 2,
        itemsWithAlertsCount: expect.any(Number) as number,
      });
      // Valor estimado = soma dos totais (item 2: mediana 100 × 12).
      expect((await researchOf(research.id)).totalEstimatedValue).toBe('6200.00');
    });

    it('CV acima do limiar troca automaticamente para a mediana', async () => {
      const { research, second } = await withQuotations();
      const item = await itemOf(research.id, second.id);
      expect(Number(item.coefficientOfVariation)).toBeGreaterThan(25);
      expect(item).toMatchObject({
        meanPrice: '130.0000',
        medianPrice: '100.0000',
        effectiveMethod: 'MEDIAN',
        recommendedUnitPrice: '100.0000',
        totalPrice: '1200.00',
      });
    });

    it('FA-01/FA-02: valor manual com justificativa e depois volta ao método padrão', async () => {
      const { process, research, first } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      const manual = await patchItem(
        first.id,
        { methodOverride: 'MANUAL', manualUnitPrice: '95.50', manualJustification: JUSTIFICATION },
        `"${String(before.version)}"`,
      );
      expect(manual.status, JSON.stringify(manual.body)).toBe(200);
      expect(priceItemSchema.parse(data(manual))).toMatchObject({
        methodOverride: 'MANUAL',
        effectiveMethod: 'MANUAL',
        manualUnitPrice: '95.5000',
        manualJustification: JUSTIFICATION,
        recommendedUnitPrice: '95.5000',
        totalPrice: '9550.00',
      });
      const changes = auditOf(process.id, 'price_research.method_change');
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        entityType: 'PriceItem',
        entityId: first.id,
        changes: [{ path: 'methodOverride', old: null, new: 'MANUAL' }],
        metadata: { priceItemId: first.id },
      });
      expect(JSON.stringify(changes)).not.toContain(JUSTIFICATION);

      const cleared = await patchItem(
        first.id,
        { methodOverride: null },
        manual.headers.etag ?? '',
      );
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(priceItemSchema.parse(data(cleared))).toMatchObject({
        methodOverride: null,
        manualUnitPrice: null,
        manualJustification: null,
        effectiveMethod: 'MEAN',
        recommendedUnitPrice: '100.0000',
      });
    });

    it('FA-03: parâmetros da pesquisa recalculam todos os itens, exceto o preço manual', async () => {
      const { process, research, first, second } = await withQuotations();
      const item = await itemOf(research.id, first.id);
      await patchItem(
        first.id,
        { methodOverride: 'MANUAL', manualUnitPrice: '95.55', manualJustification: JUSTIFICATION },
        `"${String(item.version)}"`,
      );
      const header = await researchOf(research.id);
      const response = await patchResearch(
        research.id,
        { defaultMethod: 'LOWEST', unitPriceDecimals: 4, roundingMode: 'HALF_EVEN' },
        `"${String(header.version)}"`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const updated = priceResearchSchema.parse(data(response));
      expect(updated.parameters).toMatchObject({
        defaultMethod: 'LOWEST',
        unitPriceDecimals: 4,
        roundingMode: 'HALF_EVEN',
      });
      expect(updated.version).toBe(header.version + 1);
      expect(await itemOf(research.id, second.id)).toMatchObject({
        effectiveMethod: 'LOWEST',
        recommendedUnitPrice: '90.0000',
      });
      expect(await itemOf(research.id, first.id)).toMatchObject({
        effectiveMethod: 'MANUAL',
        recommendedUnitPrice: '95.5500',
      });
      expect(auditOf(process.id, 'price_research.method_change').at(-1)).toMatchObject({
        entityType: 'PriceResearch',
        changes: expect.arrayContaining([
          { path: 'parameters.defaultMethod', old: 'AUTO_CV', new: 'LOWEST' },
        ]) as unknown[],
      });
      expect(auditOf(process.id, 'price_research.recalculate').at(-1)).toMatchObject({
        metadata: { trigger: 'PARAMETERS' },
      });
    });

    it('FA-04: "Recalcular agora" (PRS-20) responde os contadores, audita e emite o evento', async () => {
      const { process, research } = await withQuotations();
      const events = eventsOf(process.id, 'PriceResearchRecalculated').length;
      const header = await researchOf(research.id);
      const response = await recalculate(research.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(priceResearchRecalculationSchema.parse(data(response))).toEqual({
        itemsCount: 2,
        itemsWithAlertsCount: header.itemsWithAlertsCount,
        lastCalculatedAt: NOW.toISOString(),
      });
      expect(response.headers.etag).toBe(`"${String(header.version + 1)}"`);
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(events + 1);
      expect(auditOf(process.id, 'price_research.recalculate').at(-1)).toMatchObject({
        metadata: { trigger: 'MANUAL', itemsCount: 2 },
      });
    });

    it('FA-05/FA-06 e US-027: excluir cotações recalcula até "sem cotações válidas"', async () => {
      const { research, first, quotations } = await withQuotations();
      const ofFirst = quotations.filter((quotation) => quotation.priceItemId === first.id);
      for (const quotation of ofFirst.slice(0, 2)) {
        expect((await excludeQuotation(quotation.id, '"1"')).status).toBe(200);
      }
      // FA-06: uma cotação válida (90,00) — média = mediana = menor = maior; sem desvio nem CV.
      expect(await itemOf(research.id, first.id)).toMatchObject({
        validQuotationsCount: 1,
        meanPrice: '90.0000',
        medianPrice: '90.0000',
        lowestPrice: '90.0000',
        highestPrice: '90.0000',
        stdDeviation: null,
        coefficientOfVariation: null,
        effectiveMethod: 'MEAN',
        recommendedUnitPrice: '90.0000',
      });
      const last = ofFirst[2];
      if (!last) throw new Error('cotação ausente');
      expect((await excludeQuotation(last.id, '"1"')).status).toBe(200);
      // FA-05: sem cotação válida, tudo nulo e o alerta NO_VALID_QUOTES.
      const empty = await itemOf(research.id, first.id);
      expect(empty).toMatchObject({
        validQuotationsCount: 0,
        meanPrice: null,
        recommendedUnitPrice: null,
        totalPrice: null,
      });
      expect(empty.alerts.map((alert) => alert.code)).toContain('NO_VALID_QUOTES');
    });
  });

  describe('[Validação]', () => {
    it('Método manual sem justificativa: 422 CONDITIONAL_REQUIRED e o método efetivo anterior é mantido', async () => {
      const { process, research, first } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      const response = await patchItem(
        first.id,
        { methodOverride: 'MANUAL', manualUnitPrice: '95.00' },
        `"${String(before.version)}"`,
      );
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['manualJustification', 'CONDITIONAL_REQUIRED']]);
      expect(problemDetailsSchema.parse(response.body).errors[0]?.message).toBe(
        'Informe o valor manual e a justificativa (mín. 20 caracteres).',
      );
      expect(await itemOf(research.id, first.id)).toMatchObject({
        effectiveMethod: before.effectiveMethod,
        methodOverride: null,
        version: before.version,
      });
      expect(auditOf(process.id, 'price_research.method_change')).toEqual([]);
    });

    it('V-02..V-06: valor inválido, enum, campo calculado, quantidade e If-Match', async () => {
      const { research, first } = await withQuotations();
      const { version } = await itemOf(research.id, first.id);
      const ifMatch = `"${String(version)}"`;
      const invalid = await patchItem(
        first.id,
        { methodOverride: 'MANUAL', manualUnitPrice: '10.123', manualJustification: JUSTIFICATION },
        ifMatch,
      );
      expect(fieldErrors(invalid)).toEqual([['manualUnitPrice', 'INVALID_DECIMAL']]);
      expect(problemDetailsSchema.parse(invalid.body).errors[0]?.message).toBe(
        'Informe um valor válido, com até 2 casas decimais.',
      );
      expect(
        fieldErrors(await patchItem(first.id, { methodOverride: 'AVERAGE' }, ifMatch)),
      ).toEqual([['methodOverride', 'INVALID_ENUM']]);
      const calculated = await patchItem(first.id, { recommendedUnitPrice: '1.00' }, ifMatch);
      expect(fieldErrors(calculated)).toEqual([['recommendedUnitPrice', 'NOT_ALLOWED']]);
      expect(fieldErrors(await patchItem(first.id, { quantity: '0' }, ifMatch))).toEqual([
        ['quantity', 'OUT_OF_RANGE'],
      ]);
      expectProblem(
        await patchItem(first.id, { quantity: '5' }, null),
        428,
        'PRECONDITION_REQUIRED',
      );
      expect(
        fieldErrors(
          await patchResearch(research.id, { cvThresholdPercent: '0' }, `"${String(version)}"`),
        ),
      ).toEqual([['cvThresholdPercent', 'OUT_OF_RANGE']]);
      expect((await itemOf(research.id, first.id)).version).toBe(version);
    });

    it('Documento não editável: 409 DOCUMENT_NOT_EDITABLE no PRS-07 e no PRS-20', async () => {
      const { research, first } = await withQuotations();
      const { version } = await itemOf(research.id, first.id);
      const store = documentRepositoryOf(api);
      const document = store
        .allDocuments()
        .find((candidate) => candidate.id === research.documentId);
      if (!document) throw new Error('documento ausente');
      store.seed({ ...document, status: 'IN_REVIEW' });
      expectProblem(
        await patchItem(first.id, { methodOverride: 'MEAN' }, `"${String(version)}"`),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expectProblem(await recalculate(research.id), 409, 'DOCUMENT_NOT_EDITABLE');
      store.seed(document);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário só com PROCESS_VIEW: 403 PERMISSION_DENIED e nenhuma estatística é alterada', async () => {
      const { process, research, first } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      const response = await patchItem(
        first.id,
        { methodOverride: 'LOWEST' },
        `"${String(before.version)}"`,
        BRUNO,
      );
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PRICE_RESEARCH_UPDATE',
      });
      expectProblem(await recalculate(research.id, BRUNO), 403, 'PERMISSION_DENIED');
      expect(await itemOf(research.id, first.id)).toEqual(before);
      expect(auditOf(process.id, 'price_research.method_change')).toEqual([]);
    });

    it('POL-09: sem permissão de ver o orçamento sigiloso, os valores vêm mascarados', async () => {
      const { process, research, first } = await withQuotations();
      moveTo(process, { isBudgetConfidential: true });
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      const response = await auth(
        request(api.server).get(`/api/v1/price-research/${research.id}/items`),
        'sub-otavio',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const item = z
        .array(priceItemSchema)
        .parse(data(response))
        .find((candidate) => candidate.id === first.id);
      expect(item).toMatchObject({
        validQuotationsCount: 3,
        effectiveMethod: 'MEAN',
        meanPrice: null,
        coefficientOfVariation: null,
        recommendedUnitPrice: null,
        totalPrice: null,
        valuesMasked: true,
      });
      expectProblem(await recalculate(research.id, 'sub-otavio'), 403, 'PERMISSION_DENIED');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Item de outro tenant: 404 NOT_FOUND e nada do outro tenant é lido ou alterado', async () => {
      const { process, research, first } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      // Fábio também tem vínculo na Prefeitura B, onde o item não existe.
      expectProblem(
        await patchItem(
          first.id,
          { methodOverride: 'LOWEST' },
          `"${String(before.version)}"`,
          MARCOS,
          B,
        ),
        404,
        'NOT_FOUND',
      );
      expectProblem(await recalculate(research.id, MARCOS, B), 404, 'NOT_FOUND');
      expectProblem(
        await patchItem(newId(), { methodOverride: 'LOWEST' }, '"1"'),
        404,
        'NOT_FOUND',
      );
      expect(await itemOf(research.id, first.id)).toEqual(before);
      expect(auditOf(process.id, 'price_research.method_change')).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenviar o mesmo método sem mudança real não duplica o histórico', async () => {
      const { process, research, first } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      const set = await patchItem(
        first.id,
        { methodOverride: 'MEAN' },
        `"${String(before.version)}"`,
      );
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      const events = eventsOf(process.id, 'PriceResearchRecalculated').length;
      const again = await patchItem(first.id, { methodOverride: 'MEAN' }, set.headers.etag ?? '');
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.headers.etag).toBe(set.headers.etag);
      expect(auditOf(process.id, 'price_research.method_change')).toHaveLength(1);
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(events);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas edições simultâneas do mesmo item: uma 200 com a versão nova e a outra 412 com currentVersion', async () => {
      const { research, first } = await withQuotations();
      const { version } = await itemOf(research.id, first.id);
      const ifMatch = `"${String(version)}"`;
      const [a, b] = await Promise.all([
        patchItem(first.id, { methodOverride: 'LOWEST' }, ifMatch),
        patchItem(first.id, { methodOverride: 'MEDIAN' }, ifMatch),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 412]);
      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      expect(priceItemSchema.parse(data(winner)).version).toBe(version + 1);
      expect(expectProblem(loser, 412, 'VERSION_CONFLICT')).toMatchObject({
        currentVersion: version + 1,
      });
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante o recálculo: 503 DEPENDENCY_UNAVAILABLE e as estatísticas anteriores ficam', async () => {
      const { research, first, quotations } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      const quotation = quotations.find((candidate) => candidate.priceItemId === first.id);
      if (!quotation) throw new Error('cotação ausente');
      transactions.down = true;
      expectProblem(await excludeQuotation(quotation.id, '"1"'), 503, 'DEPENDENCY_UNAVAILABLE');
      expectProblem(await recalculate(research.id), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(await itemOf(research.id, first.id)).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: estatísticas persistidas, 200, e o evento fica no outbox', async () => {
      const { process, research, first } = await withQuotations();
      const before = await itemOf(research.id, first.id);
      const events = eventsOf(process.id, 'PriceResearchRecalculated').length;
      const response = await patchItem(first.id, { quantity: '60' }, `"${String(before.version)}"`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(priceItemSchema.parse(data(response)).totalPrice).toBe('6000.00');
      // Sem relay no teste (modo em memória), a linha fica gravada no outbox — o status PENDING no
      // banco é conferido em `test/tenant-leak/price-calculation.spec.ts`.
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(events + 1);
    });
  });
});

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
import type { TenantTx } from '#shared/database/prisma.js';
import { InMemoryObjectStorage } from '#shared/storage/in-memory-object-storage.js';
import { OBJECT_STORAGE } from '#shared/storage/storage.service.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
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
 * US-030 — Sinalizar outliers e alertas de conformidade (PRS-03/05, com o recálculo de US-029
 * disparado pelos PRS-04/13/14/16/20), pelo pipeline HTTP completo com a identidade fake e os
 * seeders reais. Background: processo com 2 itens na etapa PESQUISA_PRECOS e a pesquisa em DRAFT com
 * os limiares 70/130 e mínimo 3 do snapshot. Fábio (COMPRAS, responsável) é o "Marcos"; Ana (REQUISITANTE, sem as
 * concessões do processo no cenário de permissão) é o "Bruno". As 8 categorias do Gherkin + FA-01/03/04/05 e V-01/V-02.
 * Colunas, RLS e outbox PENDING no PostgreSQL: `test/tenant-leak/price-alerts.spec.ts`.
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

describe('Feature: Sinalizar outliers e alertas de conformidade (US-030)', () => {
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

  const getSources = async (researchId: string) => {
    const response = await auth(
      request(api.server).get(`/api/v1/price-research/${researchId}/sources?pageSize=100`),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(priceSourceSchema).parse(data(response));
  };
  const quotationsOf = async (researchId: string, itemId: string) =>
    (await getSources(researchId))
      .flatMap((source) => source.quotations)
      .filter((quotation) => quotation.priceItemId === itemId);
  const patchQuotation = (quotationId: string, body: Record<string, unknown>, ifMatch: string) =>
    withIfMatch(auth(request(api.server).patch(`/api/v1/quotations/${quotationId}`)), ifMatch).send(
      body,
    );
  const alertCodes = (item: { readonly alerts: readonly { readonly code: string }[] }) =>
    item.alerts.map((alert) => alert.code);
  const loggedEvents = (event: string) =>
    // `spyOn` de um método já espionado (no `beforeAll`) devolve o mesmo espião.
    vi
      .spyOn(Logger.prototype, 'log')
      .mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === event);

  /**
   * Background da US-030: limiares 70/130 e mínimo 3 (snapshot padrão); uma fonte por coluna de
   * preços do "Item 1" (`first`) — o "Item 2" fica sem cotação. `body` muda o tipo/data da fonte.
   */
  async function withItemPrices(
    prices: readonly string[],
    body: (index: number) => Record<string, unknown> = () => ({}),
  ) {
    const context = await background();
    const header = await researchOf(context.research.id);
    expect(header.parameters).toMatchObject({
      outlierLowerPercent: '70.0000',
      outlierUpperPercent: '130.0000',
      minQuotations: 3,
    });
    const quotations = [];
    for (const [index, price] of prices.entries()) {
      const source = await sourceOk(
        context.research.id,
        directBody({ description: `Orçamento ${String(index + 1)} ${words(1)}`, ...body(index) }),
      );
      const grid = await gridOk(
        source.id,
        [{ priceItemId: context.first.id, unitPrice: price }],
        '"1"',
      );
      quotations.push(...grid.quotations);
    }
    return { ...context, quotations };
  }

  describe('[Sucesso]', () => {
    it('Cotação muito abaixo da mediana das demais é sinalizada como LOW, o item ganha HAS_OUTLIERS e nada é excluído', async () => {
      const { process, research, first } = await withItemPrices(['100.00', '100.00', '40.00']);
      const quotations = await quotationsOf(research.id, first.id);
      expect(quotations.find((quotation) => quotation.unitPrice === '40.0000')?.outlierFlag).toBe(
        'LOW',
      );
      // DEC-020: nenhuma cotação é excluída automaticamente (asserção explícita da DoD).
      expect(quotations.map((quotation) => quotation.status)).toEqual(['VALID', 'VALID', 'VALID']);
      expect(quotations.every((quotation) => quotation.exclusionReason === null)).toBe(true);

      const item = await itemOf(research.id, first.id);
      expect(alertCodes(item)).toContain('HAS_OUTLIERS');
      expect(item.validQuotationsCount).toBe(3);
      expect((await researchOf(research.id)).itemsWithAlertsCount).toBe(2);

      // Auditoria e evento reaproveitados de US-029, com `alertsChanged`; logs sem preços.
      expect(auditOf(process.id, 'price_research.recalculate').at(-1)).toMatchObject({
        metadata: { alertsChanged: true, itemsWithAlertsCount: 2 },
      });
      expect(eventsOf(process.id, 'PriceResearchRecalculated').at(-1)?.payload).toEqual({
        priceResearchId: research.id,
        itemsCount: 2,
        itemsWithAlertsCount: 2,
      });
      const changes = loggedEvents('price_research.alerts_changed').filter(
        (entry) => entry.priceItemId === first.id,
      );
      expect(changes.at(-1)).toMatchObject({
        priceResearchId: research.id,
        alertsAfter: expect.arrayContaining(['HAS_OUTLIERS']) as unknown,
      });
      expect(JSON.stringify(changes)).not.toMatch(/40\.0000|100\.0000/);
    });

    it('Item sem cotações válidas recebe NO_VALID_QUOTES e recommendedUnitPrice permanece nulo', async () => {
      const { research, second } = await withItemPrices(['100.00']);
      const item = await itemOf(research.id, second.id);
      expect(alertCodes(item)).toEqual(['NO_VALID_QUOTES']);
      expect(item.recommendedUnitPrice).toBeNull();
    });

    it('FA-03/FA-04: exatamente o mínimo não gera BELOW_MINIMUM_QUOTES; HIGH_CV, HAS_OUTLIERS e EXPIRED_QUOTES coexistem', async () => {
      // A 3ª fonte é um orçamento de fornecedor com mais de 180 dias (pesquisa direta — RN-PRICE-49).
      const { research, first } = await withItemPrices(['100.00', '100.00', '300.00'], (index) =>
        index === 2 ? { quoteDate: '2026-03-01' } : {},
      );
      const item = await itemOf(research.id, first.id);
      expect(item.validQuotationsCount).toBe(3);
      expect(alertCodes(item)).toEqual(['HIGH_CV', 'HAS_OUTLIERS', 'EXPIRED_QUOTES']);
      const expired = (await quotationsOf(research.id, first.id)).find(
        (quotation) => quotation.unitPrice === '300.0000',
      );
      expect(expired).toMatchObject({ isExpired: true, outlierFlag: 'HIGH', status: 'VALID' });
    });

    it('FA-01: excluir a cotação destoante (US-027) reavalia o destaque das restantes e remove HAS_OUTLIERS', async () => {
      const { research, first } = await withItemPrices(['100.00', '100.00', '105.00', '40.00']);
      const before = await quotationsOf(research.id, first.id);
      const outlier = before.find((quotation) => quotation.unitPrice === '40.0000');
      if (!outlier) throw new Error('cotação ausente');
      expect(outlier.outlierFlag).toBe('LOW');
      expect(alertCodes(await itemOf(research.id, first.id))).toContain('HAS_OUTLIERS');

      const excluded = await excludeQuotation(outlier.id, `"${String(outlier.version)}"`);
      expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
      // A resposta já traz o estado recalculado (sem destaque para a desconsiderada).
      expect(quotationSchema.parse(data(excluded))).toMatchObject({
        status: 'EXCLUDED',
        outlierFlag: 'NONE',
      });
      const after = await quotationsOf(research.id, first.id);
      expect(
        after.filter((quotation) => quotation.status === 'VALID').map((q) => q.outlierFlag),
      ).toEqual(['NONE', 'NONE', 'NONE']);
      expect(alertCodes(await itemOf(research.id, first.id))).not.toContain('HAS_OUTLIERS');
    });

    it('EXPIRED_QUOTES aparece ao avançar a data-base além do prazo da fonte (PRS-04)', async () => {
      const context = await background();
      const header = await researchOf(context.research.id);
      const earlier = await patchResearch(
        context.research.id,
        { referenceDate: '2026-06-01' },
        `"${String(header.version)}"`,
      );
      expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
      const source = await sourceOk(context.research.id, directBody({ quoteDate: '2026-03-01' }));
      await gridOk(source.id, [{ priceItemId: context.first.id, unitPrice: '100.00' }], '"1"');
      expect(alertCodes(await itemOf(context.research.id, context.first.id))).toEqual([
        'BELOW_MINIMUM_QUOTES',
      ]);
      const current = await researchOf(context.research.id);
      const later = await patchResearch(
        context.research.id,
        { referenceDate: TODAY },
        `"${String(current.version)}"`,
      );
      expect(later.status, JSON.stringify(later.body)).toBe(200);
      expect(alertCodes(await itemOf(context.research.id, context.first.id))).toEqual([
        'BELOW_MINIMUM_QUOTES',
        'EXPIRED_QUOTES',
      ]);
      const [quotation] = await quotationsOf(context.research.id, context.first.id);
      expect(quotation?.isExpired).toBe(true);
    });

    it('Limiares do snapshot editados (PRS-04) reavaliam o destaque de todas as cotações', async () => {
      const { research, first } = await withItemPrices(['100.00', '100.00', '60.00']);
      expect(
        (await quotationsOf(research.id, first.id)).find((q) => q.unitPrice === '60.0000')
          ?.outlierFlag,
      ).toBe('LOW');
      const header = await researchOf(research.id);
      const response = await patchResearch(
        research.id,
        { outlierLowerPercent: '50', outlierUpperPercent: '200' },
        `"${String(header.version)}"`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const after = await quotationsOf(research.id, first.id);
      expect(after.map((q) => q.outlierFlag)).toEqual(['NONE', 'NONE', 'NONE']);
      expect(alertCodes(await itemOf(research.id, first.id))).not.toContain('HAS_OUTLIERS');
    });
  });

  describe('[Validação]', () => {
    it('V-01: outlierFlag/isExpired no PATCH da cotação e alerts no PATCH do item → 422 NOT_ALLOWED no campo', async () => {
      const { research, first, quotations } = await withItemPrices(['100.00', '100.00', '40.00']);
      const [quotation] = quotations;
      if (!quotation) throw new Error('cotação ausente');
      const response = await patchQuotation(
        quotation.id,
        { outlierFlag: 'NONE' },
        `"${String(quotation.version)}"`,
      );
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['outlierFlag', 'NOT_ALLOWED']]);
      expect(problemDetailsSchema.parse(response.body).errors[0]?.message).toBe(
        'Este campo é calculado pelo sistema e não pode ser alterado diretamente.',
      );
      const expired = await patchQuotation(
        quotation.id,
        { unitPrice: '101.00', isExpired: true },
        `"${String(quotation.version)}"`,
      );
      expect(fieldErrors(expired)).toEqual([['isExpired', 'NOT_ALLOWED']]);

      const item = await itemOf(research.id, first.id);
      const itemResponse = await patchItem(first.id, { alerts: [] }, `"${String(item.version)}"`);
      expect(fieldErrors(itemResponse)).toEqual([['alerts', 'NOT_ALLOWED']]);
      // Nada mudou: o destaque segue o calculado.
      expect(alertCodes(await itemOf(research.id, first.id))).toContain('HAS_OUTLIERS');
    });

    it('V-02: limite inferior de destaque maior ou igual ao superior → 422 OUT_OF_RANGE nos dois campos', async () => {
      const { research } = await background();
      const header = await researchOf(research.id);
      const response = await patchResearch(
        research.id,
        { outlierLowerPercent: '100', outlierUpperPercent: '100' },
        `"${String(header.version)}"`,
      );
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([
        ['outlierLowerPercent', 'OUT_OF_RANGE'],
        ['outlierUpperPercent', 'OUT_OF_RANGE'],
      ]);
      expect(problemDetailsSchema.parse(response.body).errors[0]?.message).toBe(
        'O limite inferior de destaque deve ser menor que o superior.',
      );
      expect((await researchOf(research.id)).version).toBe(header.version);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem visibilidade do processo não enxerga a pesquisa nem os alertas (404)', async () => {
      const { process, research } = await withItemPrices(['100.00', '100.00', '40.00']);
      // Ana (REQUISITANTE, OWN_DEPARTMENTS) perde as concessões do processo (criadora e unidade
      // solicitante): sem PROCESS_VIEW que o cubra, a pesquisa some como se não existisse.
      const grants = (
        processRepositoryOf(api) as unknown as {
          access: { processId: string; userId: string | null; departmentId: string | null }[];
        }
      ).access;
      for (let index = grants.length - 1; index >= 0; index -= 1) {
        const grant = grants[index];
        if (grant?.processId !== process.id) continue;
        if (grant.userId === FAKE_USERS.ana.id || grant.departmentId !== null) {
          grants.splice(index, 1);
        }
      }
      expectProblem(
        await auth(request(api.server).get(`/api/v1/price-research/${research.id}`), BRUNO),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await auth(request(api.server).get(`/api/v1/price-research/${research.id}/items`), BRUNO),
        404,
        'NOT_FOUND',
      );
    });

    it('FA-05/POL-09: selos de destaque visíveis, valores mascarados para quem não vê o orçamento sigiloso', async () => {
      const { process, research, first } = await withItemPrices(['100.00', '100.00', '40.00']);
      moveTo(process, { isBudgetConfidential: true });
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      const items = await auth(
        request(api.server).get(`/api/v1/price-research/${research.id}/items`),
        'sub-otavio',
      );
      expect(items.status, JSON.stringify(items.body)).toBe(200);
      const item = z
        .array(priceItemSchema)
        .parse(data(items))
        .find((candidate) => candidate.id === first.id);
      expect(item).toMatchObject({ valuesMasked: true, medianPrice: null });
      expect(item?.alerts.map((alert) => alert.code)).toContain('HAS_OUTLIERS');
      const sources = await auth(
        request(api.server).get(`/api/v1/price-research/${research.id}/sources?pageSize=100`),
        'sub-otavio',
      );
      const flags = z
        .array(priceSourceSchema)
        .parse(data(sources))
        .flatMap((source) => source.quotations)
        .filter((quotation) => quotation.priceItemId === first.id);
      expect(flags.every((quotation) => quotation.unitPrice === null)).toBe(true);
      expect(flags.map((quotation) => quotation.outlierFlag)).toContain('LOW');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Itens de uma pesquisa existente só na Prefeitura B: 404 e nenhum dado revelado', async () => {
      const { research } = await withItemPrices(['100.00', '100.00', '40.00']);
      // Fábio também tem vínculo na Prefeitura B, onde a pesquisa não existe.
      const response = await auth(
        request(api.server).get(`/api/v1/price-research/${research.id}/items`),
        MARCOS,
        B,
      );
      expectProblem(response, 404, 'NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(/HAS_OUTLIERS|alerts/);
      expectProblem(
        await auth(request(api.server).get(`/api/v1/price-research/${research.id}`), MARCOS, B),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('[Duplicidade]', () => {
    it('Recalcular duas vezes sem mudança não duplica alertas nem a contagem', async () => {
      const { process, research, first } = await withItemPrices(['100.00', '100.00', '40.00']);
      const before = await itemOf(research.id, first.id);
      expect(alertCodes(before).filter((code) => code === 'HAS_OUTLIERS')).toHaveLength(1);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await recalculate(research.id);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(priceResearchRecalculationSchema.parse(data(response)).itemsWithAlertsCount).toBe(2);
      }
      const after = await itemOf(research.id, first.id);
      expect(alertCodes(after).filter((code) => code === 'HAS_OUTLIERS')).toHaveLength(1);
      // Nada mudou: o item não é regravado e a auditoria marca `alertsChanged: false`.
      expect(after.version).toBe(before.version);
      expect(auditOf(process.id, 'price_research.recalculate').at(-1)).toMatchObject({
        metadata: { trigger: 'MANUAL', alertsChanged: false, itemsWithAlertsCount: 2 },
      });
      expect((await researchOf(research.id)).itemsWithAlertsCount).toBe(2);
    });
  });

  describe('[Concorrência]', () => {
    it('Exclusão concorrente com o recálculo: o resultado final considera só as VALID depois da exclusão', async () => {
      const { research, first } = await withItemPrices(['100.00', '100.00', '105.00', '40.00']);
      const outlier = (await quotationsOf(research.id, first.id)).find(
        (quotation) => quotation.unitPrice === '40.0000',
      );
      if (!outlier) throw new Error('cotação ausente');
      const [recalculated, excluded] = await Promise.all([
        recalculate(research.id),
        excludeQuotation(outlier.id, `"${String(outlier.version)}"`),
      ]);
      expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
      expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
      const item = await itemOf(research.id, first.id);
      expect(item.validQuotationsCount).toBe(3);
      expect(alertCodes(item)).not.toContain('HAS_OUTLIERS');
      const remaining = (await quotationsOf(research.id, first.id)).filter(
        (quotation) => quotation.status === 'VALID',
      );
      expect(remaining.map((quotation) => quotation.outlierFlag)).toEqual(['NONE', 'NONE', 'NONE']);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao editar a cotação: 503 DEPENDENCY_UNAVAILABLE e os alertas anteriores ficam', async () => {
      const { research, first, quotations } = await withItemPrices(['100.00', '100.00', '40.00']);
      const before = await itemOf(research.id, first.id);
      const flags = await quotationsOf(research.id, first.id);
      const outlier = quotations.find((quotation) => quotation.unitPrice === '40.0000');
      if (!outlier) throw new Error('cotação ausente');
      transactions.down = true;
      expectProblem(
        await patchQuotation(outlier.id, { unitPrice: '99.00' }, `"${String(outlier.version)}"`),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(await itemOf(research.id, first.id)).toEqual(before);
      expect(await quotationsOf(research.id, first.id)).toEqual(flags);
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila indisponível: o alerta já está na leitura síncrona e o evento fica no outbox', async () => {
      const { process, research, first, quotations } = await withItemPrices([
        '100.00',
        '100.00',
        '100.00',
      ]);
      expect(alertCodes(await itemOf(research.id, first.id))).toEqual([]);
      const events = eventsOf(process.id, 'PriceResearchRecalculated').length;
      const [quotation] = quotations;
      if (!quotation) throw new Error('cotação ausente');
      const response = await patchQuotation(
        quotation.id,
        { unitPrice: '10.00' },
        `"${String(quotation.version)}"`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(quotationSchema.parse(data(response)).outlierFlag).toBe('LOW');
      expect(alertCodes(await itemOf(research.id, first.id))).toContain('HAS_OUTLIERS');
      // Sem relay no teste (modo em memória), a linha fica gravada no outbox — o status PENDING no
      // banco é conferido em `test/tenant-leak/price-alerts.spec.ts`.
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(events + 1);
    });
  });
});

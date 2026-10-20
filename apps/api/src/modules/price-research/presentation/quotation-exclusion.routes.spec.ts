import { randomUUID } from 'node:crypto';

import {
  priceItemSchema,
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
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { PRICE_RESEARCH_CLOCK, PRICE_RESEARCH_TRANSACTIONS } from '../application/ports.js';
import type { PriceResearchTransactions } from '../application/ports.js';
import { InMemoryPriceSourceRepository } from '../infrastructure/price-source.repositories.js';

/*
 * US-027 — Desconsiderar e restaurar cotação com justificativa (PRS-16/17), pelo pipeline HTTP
 * completo (autenticação, tenant, vínculo, autorização, `If-Match`, filtro RFC 9457) com a
 * identidade fake e os seeders reais. Background: processo "0012/2026" na etapa PESQUISA_PRECOS com
 * 2 itens, a pesquisa em DRAFT e a cotação "Q1" VALID do item 1. Fábio (COMPRAS, responsável) é o
 * "Diego"; Ana (REQUISITANTE — só PROCESS_VIEW) é a "Eva"; Otávio (ADMIN_ORGAO) é o colaborador sem
 * POL-09. As 8 categorias do Gherkin + FA-01..FA-03. RLS, CHECK de exclusão e outbox PENDING no
 * PostgreSQL: `test/tenant-leak/quotation-exclusion.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-06T15:00:00.000Z');
const TODAY = '2026-10-06';
const DIEGO = 'sub-fabio';
const EVA = 'sub-ana';

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

describe('Feature: Desconsiderar e restaurar cotação com justificativa (US-027)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  let units: { sc: string; m3: string };
  let catalog: { contractingType: string; origin: string };
  let types: Record<string, string>;
  let supplierA: Supplier;
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = DIEGO, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const withIfMatch = (call: request.Test, ifMatch: string | null) =>
    ifMatch === null ? call : call.set('If-Match', ifMatch);
  const listSources = (researchId: string, subject = DIEGO, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/price-research/${researchId}/sources`), subject, tenant);
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
  const patchQuotation = (
    quotationId: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    subject = DIEGO,
    tenant: string = A,
  ) =>
    withIfMatch(
      auth(request(api.server).patch(`/api/v1/quotations/${quotationId}`), subject, tenant),
      ifMatch,
    ).send(body);

  const sourcesStore = () => api.app.get(InMemoryPriceSourceRepository, { strict: false });
  const sourcesOf = (researchId: string) =>
    sourcesStore()
      .snapshot()
      .sources.filter((source) => source.priceResearchId === researchId);
  const quotationsOf = (researchId: string) =>
    sourcesStore()
      .snapshot()
      .quotations.filter((quotation) => quotation.priceResearchId === researchId);
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

  async function sourcesOk(researchId: string, subject = DIEGO) {
    const response = await listSources(researchId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(priceSourceSchema).parse(data(response));
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

  const JUSTIFICATION = 'Preço muito acima das demais cotações do mesmo item';
  const excludeBody = (overrides: Record<string, unknown> = {}) => ({
    exclusionReason: 'INCONSISTENT',
    exclusionJustification: JUSTIFICATION,
    ...overrides,
  });

  const excludeQuotation = (
    quotationId: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    subject = DIEGO,
    tenant: string = A,
  ) =>
    withIfMatch(
      auth(request(api.server).post(`/api/v1/quotations/${quotationId}/exclude`), subject, tenant),
      ifMatch,
    ).send(body);
  const restoreQuotation = (
    quotationId: string,
    ifMatch: string | null,
    subject = DIEGO,
    tenant: string = A,
  ) =>
    withIfMatch(
      auth(request(api.server).post(`/api/v1/quotations/${quotationId}/restore`), subject, tenant),
      ifMatch,
    );

  /** Background da story: a cotação "Q1" VALID do item 1 (versão 1) na pesquisa do "0012/2026". */
  async function withQuotation() {
    const context = await background();
    const source = await sourceOk(context.research.id);
    const { quotations } = await gridOk(
      source.id,
      [
        { priceItemId: context.first.id, unitPrice: '150.00' },
        { priceItemId: context.second.id, unitPrice: '80.00' },
      ],
      '"1"',
    );
    const q1 = quotations.find((quotation) => quotation.priceItemId === context.first.id);
    if (!q1) throw new Error('cotação ausente');
    return { ...context, source, q1, q2: quotations.find((quotation) => quotation !== q1) };
  }

  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);

  describe('[Sucesso]', () => {
    it('Desconsiderar e depois restaurar: EXCLUDED com motivo, eventos, auditoria, timeline e recálculo; VALID ao restaurar', async () => {
      const { process, research, first, q1 } = await withQuotation();
      const recalculatedBefore = eventsOf(process.id, 'PriceResearchRecalculated').length;
      const logged = vi.spyOn(Logger.prototype, 'log');
      logged.mockClear();

      const excluded = await excludeQuotation(q1.id, excludeBody(), '"1"');
      expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
      expect(excluded.headers.etag).toBe('"2"');
      expect(quotationSchema.parse(data(excluded))).toMatchObject({
        id: q1.id,
        status: 'EXCLUDED',
        exclusionReason: 'INCONSISTENT',
        exclusionJustification: JUSTIFICATION,
        unitPrice: '150.0000',
        version: 2,
      });
      const stored = quotationsOf(research.id).find((quotation) => quotation.id === q1.id);
      expect(stored).toMatchObject({
        status: 'EXCLUDED',
        excludedById: FAKE_USERS.fabio.id,
        excludedAt: NOW,
      });

      // QuotationExcluded (só ids e motivo) seguido de PriceResearchRecalculated, sem a justificativa.
      const events = api
        .outboxRows()
        .filter((row) => row.processId === process.id)
        .slice(-2);
      expect(events.map((row) => [row.eventType, row.routingKey])).toEqual([
        ['QuotationExcluded', 'price_research.quotation_excluded'],
        ['PriceResearchRecalculated', 'price_research.recalculated'],
      ]);
      expect(events[0]?.payload).toEqual({
        priceResearchId: research.id,
        quotationId: q1.id,
        priceItemId: first.id,
        reason: 'INCONSISTENT',
      });
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(
        recalculatedBefore + 1,
      );
      const audit = auditOf(process.id, 'price_research.quotation_exclude');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'Quotation',
        entityId: q1.id,
        metadata: { reason: 'INCONSISTENT', priceItemId: first.id },
        changes: [
          { path: 'status', old: 'VALID', new: 'EXCLUDED' },
          {
            path: 'exclusionJustification',
            old: null,
            new: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string, length: 51 },
          },
        ],
      });
      expect(JSON.stringify([audit, events, logged.mock.calls])).not.toContain(JUSTIFICATION);
      expect(timelineOf(process.id, 'QUOTATION_EXCLUDED')).toEqual([
        expect.objectContaining({
          params: { itemSequence: 1, sourceLabel: 'Construtora XYZ Ltda.', reason: 'INCONSISTENT' },
        }),
      ]);
      // RN-PRICE-31/34: fora do cálculo, mas listada com motivo e justificativa; item sem válida.
      const [listed] = await sourcesOk(research.id);
      expect(listed?.quotations.find((quotation) => quotation.id === q1.id)).toMatchObject({
        status: 'EXCLUDED',
        exclusionReason: 'INCONSISTENT',
        exclusionJustification: JUSTIFICATION,
      });
      expect(listed?.version).toBe(3);
      const [item] = await itemsOf(research.id);
      expect(item).toMatchObject({ validQuotationsCount: 0, quotationsCount: 1 });
      expect(item?.alerts).toContainEqual({ code: 'NO_VALID_QUOTES' });

      const restored = await restoreQuotation(q1.id, '"2"');
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.headers.etag).toBe('"3"');
      expect(quotationSchema.parse(data(restored))).toMatchObject({
        status: 'VALID',
        exclusionReason: null,
        exclusionJustification: null,
        version: 3,
      });
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)).toMatchObject({
        status: 'VALID',
        exclusionReason: null,
        exclusionJustification: null,
        excludedById: null,
        excludedAt: null,
      });
      const after = api
        .outboxRows()
        .filter((row) => row.processId === process.id)
        .slice(-2);
      expect(after.map((row) => row.eventType)).toEqual([
        'QuotationRestored',
        'PriceResearchRecalculated',
      ]);
      expect(after[0]?.payload).toEqual({
        priceResearchId: research.id,
        quotationId: q1.id,
        priceItemId: first.id,
      });
      expect(auditOf(process.id, 'price_research.quotation_restore')).toMatchObject([
        { entityId: q1.id, metadata: { priceItemId: first.id } },
      ]);
      expect(timelineOf(process.id, 'QUOTATION_RESTORED')).toHaveLength(1);
      expect((await itemsOf(research.id))[0]?.validQuotationsCount).toBe(1);
      expect(JSON.stringify(logged.mock.calls)).toContain('price_research.quotation_restored');
    });

    it('SCR-009: meta.allowedActions traz EXCLUDE_QUOTATION a quem tem a permissão e pode editar', async () => {
      const { research } = await withQuotation();
      const meta = async (subject: string) => {
        const response = await auth(
          request(api.server).get(`/api/v1/price-research/${research.id}`),
          subject,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return (response.body as { meta: { allowedActions: string[] } }).meta.allowedActions;
      };
      expect(await meta(DIEGO)).toEqual([
        'UPDATE',
        'ADD_ITEMS',
        'REMOVE_ITEMS',
        'EXCLUDE_QUOTATION',
        // US-032: o perfil de planejamento também conclui a pesquisa.
        'COMPLETE',
      ]);
      expect(await meta(EVA)).toEqual([]);
    });

    it('FA-01: desconsiderar a última cotação válida do item não é bloqueado e sinaliza NO_VALID_QUOTES', async () => {
      const { research, second, q2 } = await withQuotation();
      if (!q2) throw new Error('cotação ausente');
      const response = await excludeQuotation(
        q2.id,
        excludeBody({ exclusionReason: 'EXCESSIVE' }),
        '"1"',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const items = await itemsOf(research.id);
      const item = items.find((candidate) => candidate.id === second.id);
      expect(item?.validQuotationsCount).toBe(0);
      expect(item?.alerts).toContainEqual({ code: 'NO_VALID_QUOTES' });
    });

    it('Cotação desconsiderada não muda pela grade nem pela edição (409 INVALID_STATE) e a versão da fonte invalida a grade antiga', async () => {
      const { research, first, source, q1 } = await withQuotation();
      expect((await excludeQuotation(q1.id, excludeBody(), '"1"')).status).toBe(200);
      expectProblem(await patchQuotation(q1.id, { unitPrice: '1' }, '"2"'), 409, 'INVALID_STATE');
      // A grade carregada antes (If-Match da fonte = 2) já não vale: a fonte subiu para a versão 3.
      expectProblem(
        await putGrid(source.id, [{ priceItemId: first.id, unitPrice: '9' }], '"2"'),
        412,
        'VERSION_CONFLICT',
      );
      expect(sourcesOf(research.id).map((candidate) => candidate.version)).toEqual([3]);
    });
  });

  describe('[Validação]', () => {
    it('Justificativa muito curta: 422 VALIDATION_ERROR TOO_SHORT em exclusionJustification; nada muda', async () => {
      const { process, research, q1 } = await withQuotation();
      const response = await excludeQuotation(
        q1.id,
        excludeBody({ exclusionJustification: 'Preço alto' }),
        '"1"',
      );
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['exclusionJustification', 'TOO_SHORT']]);
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)).toMatchObject({
        status: 'VALID',
        version: 1,
      });
      expect(auditOf(process.id, 'price_research.quotation_exclude')).toEqual([]);
    });

    it('Motivo ausente ou fora do enum: 422 no campo exclusionReason; justificativa de espaços conta como curta', async () => {
      const { q1 } = await withQuotation();
      const missing = await excludeQuotation(
        q1.id,
        { exclusionJustification: JUSTIFICATION },
        '"1"',
      );
      expectProblem(missing, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(missing)).toEqual([['exclusionReason', 'REQUIRED']]);
      const unknown = await excludeQuotation(
        q1.id,
        excludeBody({ exclusionReason: 'OUTRO_MOTIVO' }),
        '"1"',
      );
      expectProblem(unknown, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(unknown).map(([field]) => field)).toEqual(['exclusionReason']);
      const blank = await excludeQuotation(
        q1.id,
        excludeBody({ exclusionJustification: ' '.repeat(30) }),
        '"1"',
      );
      expect(fieldErrors(blank)).toEqual([['exclusionJustification', expect.any(String)]]);
    });

    it('If-Match ausente: 428; divergente: 412 VERSION_CONFLICT com a versão atual', async () => {
      const { q1 } = await withQuotation();
      expectProblem(
        await excludeQuotation(q1.id, excludeBody(), null),
        428,
        'PRECONDITION_REQUIRED',
      );
      const stale = await excludeQuotation(q1.id, excludeBody(), '"7"');
      expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(problemDetailsSchema.parse(stale.body)).toMatchObject({ currentVersion: 1 });
      expectProblem(await restoreQuotation(q1.id, null), 428, 'PRECONDITION_REQUIRED');
    });

    it('FA-03: pesquisa em revisão → 409 DOCUMENT_NOT_EDITABLE nas duas rotas', async () => {
      const { research, q1 } = await withQuotation();
      expect((await excludeQuotation(q1.id, excludeBody(), '"1"')).status).toBe(200);
      const document = documentRepositoryOf(api)
        .allDocuments()
        .find((candidate) => candidate.id === research.documentId);
      if (!document) throw new Error('documento ausente');
      documentRepositoryOf(api).seed({ ...document, status: 'IN_REVIEW' });
      const problem = expectProblem(
        await restoreQuotation(q1.id, '"2"'),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(problem.detail).toBe('Esta pesquisa de preços não pode mais ser editada.');
      expectProblem(
        await excludeQuotation(q1.id, excludeBody(), '"2"'),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)?.status).toBe(
        'EXCLUDED',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Usuário só com PROCESS_VIEW: 403 PERMISSION_DENIED com access.denied (PRICE_RESEARCH_EXCLUDE_QUOTATION) e nada muda', async () => {
      const { process, research, q1 } = await withQuotation();
      const response = await excludeQuotation(q1.id, excludeBody(), '"1"', EVA);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PRICE_RESEARCH_EXCLUDE_QUOTATION',
      });
      expectProblem(await restoreQuotation(q1.id, '"1"', EVA), 403, 'PERMISSION_DENIED');
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)?.status).toBe(
        'VALID',
      );
      expect(auditOf(process.id, 'price_research.quotation_exclude')).toEqual([]);
      expect(eventsOf(process.id, 'QuotationExcluded')).toEqual([]);
    });

    it('POL-09: em processo sigiloso, quem não vê o orçamento não desconsidera (403, reasonCode POL-09)', async () => {
      const { process, q1 } = await withQuotation();
      moveTo(process, { isBudgetConfidential: true });
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      expectProblem(
        await excludeQuotation(q1.id, excludeBody(), '"1"', 'sub-otavio'),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: expect.stringMatching(/POL-09|PRICE_RESEARCH_EXCLUDE_QUOTATION/) as string,
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Cotação de outro tenant: 404 NOT_FOUND em PRS-16 e PRS-17 sem alterar nada', async () => {
      const { process, research, q1 } = await withQuotation();
      // Fábio também tem vínculo na Prefeitura B, onde a cotação não existe.
      expectProblem(
        await excludeQuotation(q1.id, excludeBody(), '"1"', DIEGO, B),
        404,
        'NOT_FOUND',
      );
      expectProblem(await restoreQuotation(q1.id, '"1"', DIEGO, B), 404, 'NOT_FOUND');
      expectProblem(await excludeQuotation(newId(), excludeBody(), '"1"'), 404, 'NOT_FOUND');
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)).toMatchObject({
        status: 'VALID',
        version: 1,
      });
      expect(auditOf(process.id, 'price_research.quotation_exclude')).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Desconsiderar a mesma cotação duas vezes: 409 INVALID_STATE; restaurar uma VALID também', async () => {
      const { research, q1 } = await withQuotation();
      expect((await excludeQuotation(q1.id, excludeBody(), '"1"')).status).toBe(200);
      const again = await excludeQuotation(q1.id, excludeBody(), '"2"');
      expectProblem(again, 409, 'INVALID_STATE');
      expect(problemDetailsSchema.parse(again.body).detail).toBe(
        'Esta cotação já está desconsiderada.',
      );
      expect((await restoreQuotation(q1.id, '"2"')).status).toBe(200);
      const restoredAgain = await restoreQuotation(q1.id, '"3"');
      expectProblem(restoredAgain, 409, 'INVALID_STATE');
      expect(problemDetailsSchema.parse(restoredAgain.body).detail).toBe(
        'Esta cotação já está válida.',
      );
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)?.version).toBe(
        3,
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Exclusão e restauração simultâneas com If-Match 1: só uma é aplicada (a outra 412 ou 409)', async () => {
      const { process, research, q1 } = await withQuotation();
      const [exclude, restore] = await Promise.all([
        excludeQuotation(q1.id, excludeBody(), '"1"'),
        restoreQuotation(q1.id, '"1"'),
      ]);
      const statuses = [exclude.status, restore.status].sort();
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      const loser = exclude.status === 200 ? restore : exclude;
      expect([409, 412]).toContain(loser.status);
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)?.version).toBe(
        2,
      );
      expect(
        eventsOf(process.id, 'QuotationExcluded').length +
          eventsOf(process.id, 'QuotationRestored').length,
      ).toBe(1);
    });

    it('Duas desconsiderações simultâneas: uma 200 e a outra 412 VERSION_CONFLICT', async () => {
      const { q1 } = await withQuotation();
      const [a, b] = await Promise.all([
        excludeQuotation(q1.id, excludeBody(), '"1"'),
        excludeQuotation(q1.id, excludeBody({ exclusionReason: 'EXCESSIVE' }), '"1"'),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 412]);
      expectProblem(a.status === 200 ? b : a, 412, 'VERSION_CONFLICT');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao desconsiderar: 503 DEPENDENCY_UNAVAILABLE e a cotação permanece VALID', async () => {
      const { process, research, q1 } = await withQuotation();
      transactions.down = true;
      expectProblem(
        await excludeQuotation(q1.id, excludeBody(), '"1"'),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(quotationsOf(research.id).find((quotation) => quotation.id === q1.id)).toMatchObject({
        status: 'VALID',
        version: 1,
      });
      expect(eventsOf(process.id, 'QuotationExcluded')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200 e QuotationExcluded permanece no outbox até o relay publicar', async () => {
      const { process, q1 } = await withQuotation();
      const response = await excludeQuotation(q1.id, excludeBody(), '"1"');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // Sem relay no teste (modo em memória), a linha fica gravada no outbox — o status PENDING no
      // banco é conferido em `test/tenant-leak/quotation-exclusion.spec.ts`.
      expect(eventsOf(process.id, 'QuotationExcluded')).toHaveLength(1);
    });
  });
});

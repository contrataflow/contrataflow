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
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { PRICE_RESEARCH_CLOCK, PRICE_RESEARCH_TRANSACTIONS } from '../application/ports.js';
import type { PriceResearchTransactions } from '../application/ports.js';
import { InMemoryPriceResearchRepository } from '../infrastructure/price-research.repositories.js';
import { InMemoryPriceSourceRepository } from '../infrastructure/price-source.repositories.js';

/*
 * US-026 — Registrar fontes de pesquisa e cotações, pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade
 * fake e os seeders reais (catálogo com os 8 tipos de fonte, perfis, tipos de documento, templates e
 * o workflow padrão). Background: processo na etapa PESQUISA_PRECOS com 2 itens e a pesquisa em
 * DRAFT. Fábio (COMPRAS, responsável) é o "Diego"; Ana (REQUISITANTE — só PROCESS_VIEW sobre a
 * pesquisa) é a "Eva"; Otávio (ADMIN_ORGAO) é o colaborador sem POL-09. As 8 categorias do Gherkin +
 * FA-01..FA-08. RLS, FKs compostas, unicidade e cascatas no PostgreSQL:
 * `test/tenant-leak/price-sources.spec.ts`.
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

describe('Feature: Registrar fontes de pesquisa e cotações (US-026)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  let units: { sc: string; m3: string };
  let catalog: { contractingType: string; origin: string };
  let types: Record<string, string>;
  let supplierA: Supplier;
  let inactiveSupplier: Supplier;
  let supplierB: Supplier;
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
  const patchSource = (
    sourceId: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    subject = DIEGO,
    tenant: string = A,
  ) =>
    withIfMatch(
      auth(request(api.server).patch(`/api/v1/price-sources/${sourceId}`), subject, tenant),
      ifMatch,
    ).send(body);
  const deleteSource = (
    sourceId: string,
    ifMatch: string | null,
    subject = DIEGO,
    tenant: string = A,
  ) =>
    withIfMatch(
      auth(request(api.server).delete(`/api/v1/price-sources/${sourceId}`), subject, tenant),
      ifMatch,
    );
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
  const deleteQuotation = (
    quotationId: string,
    ifMatch: string | null,
    subject = DIEGO,
    tenant: string = A,
  ) =>
    withIfMatch(
      auth(request(api.server).delete(`/api/v1/quotations/${quotationId}`), subject, tenant),
      ifMatch,
    );

  const sourcesStore = () => api.app.get(InMemoryPriceSourceRepository, { strict: false });
  const sourcesOf = (researchId: string) =>
    sourcesStore()
      .snapshot()
      .sources.filter((source) => source.priceResearchId === researchId);
  const quotationsOf = (researchId: string) =>
    sourcesStore()
      .snapshot()
      .quotations.filter((quotation) => quotation.priceResearchId === researchId);
  const researchOf = (researchId: string) =>
    api.app
      .get(InMemoryPriceResearchRepository, { strict: false })
      .snapshot()
      .researches.find((research) => research.id === researchId);
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
        confirmDuplicate: true,
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
    inactiveSupplier = supplierOf(A, { legalName: 'Inativa Ltda.', isActive: false });
    supplierB = supplierOf(B, { legalName: 'Fornecedor X' });
    seedSuppliers(api, supplierA, inactiveSupplier, supplierB);
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

  describe('[Sucesso]', () => {
    it('Registrar fonte de pesquisa direta e lançar preços: 2 cotações VALID, PriceResearchRecalculated e source_create', async () => {
      const { process, research, first, second } = await background();
      const response = await createSource(research.id, directBody());
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const source = priceSourceSchema.parse(data(response));
      expect(source).toMatchObject({
        priceResearchId: research.id,
        description: 'Orçamento Construtora XYZ',
        supplierId: supplierA.id,
        supplier: { id: supplierA.id, legalName: 'Construtora XYZ Ltda.' },
        quoteDate: '2026-09-30',
        sourceType: {
          code: 'PESQUISA_DIRETA_FORNECEDOR',
          requiredFields: ['supplierId', 'quoteDate', 'attachment', 'supplierChoiceJustification'],
          maxAgeDays: 180,
        },
        quotations: [],
        version: 1,
      });
      expect(auditOf(process.id, 'price_research.source_create').at(-1)).toMatchObject({
        entityType: 'PriceSource',
        entityId: source.id,
        metadata: { sourceTypeId: types.PESQUISA_DIRETA_FORNECEDOR },
      });

      const before = eventsOf(process.id, 'PriceResearchRecalculated').length;
      const grid = await gridOk(
        source.id,
        [
          { priceItemId: first.id, unitPrice: '150.00', brandModel: 'Votoran' },
          { priceItemId: second.id, unitPrice: '80.00' },
        ],
        '"1"',
      );
      expect(grid.etag).toBe('"2"');
      expect(
        grid.quotations.map((q) => [q.priceItemId, q.unitPrice, q.status, q.isExpired]),
      ).toEqual([
        [first.id, '150.0000', 'VALID', false],
        [second.id, '80.0000', 'VALID', false],
      ]);
      const events = eventsOf(process.id, 'PriceResearchRecalculated');
      expect(events.length).toBe(before + 1);
      // Só contagens e o id — nenhum preço (comparar substrings curtas colide com o UUIDv7).
      expect(events.at(-1)?.payload).toEqual({
        priceResearchId: research.id,
        itemsCount: 2,
        itemsWithAlertsCount: 2,
      });
      expect(auditOf(process.id, 'price_research.quotation_create')).toHaveLength(2);
      expect(auditOf(process.id, 'price_research.quotation_create')[0]?.metadata).toMatchObject({
        priceSourceId: source.id,
      });

      const [listed] = await sourcesOk(research.id);
      expect(listed?.quotations).toHaveLength(2);
      expect(listed?.version).toBe(2);
      const items = await itemsOf(research.id);
      expect(items.map((item) => [item.validQuotationsCount, item.quotationsCount])).toEqual([
        [1, 1],
        [1, 1],
      ]);
      expect(researchOf(research.id)?.lastCalculatedAt).toEqual(NOW);
    });

    it('Registrar fonte de sítio eletrônico com data e hora de acesso', async () => {
      const { research } = await background();
      const source = await sourceOk(research.id, {
        sourceTypeId: types.SITIO_ELETRONICO,
        description: 'Painel de Preços',
        url: 'https://paineldeprecos.planejamento.gov.br',
        accessedAt: '2026-09-12T14:32:00Z',
      });
      expect(new Date(source.accessedAt ?? '').toISOString()).toBe('2026-09-12T14:32:00.000Z');
      expect(source).toMatchObject({
        url: 'https://paineldeprecos.planejamento.gov.br',
        supplier: null,
      });
    });

    it('FA-01/FA-03/FA-04/FA-02: editar a fonte (trocar o tipo reavalia os obrigatórios), editar e remover cotação, remover a fonte em cascata', async () => {
      const { process, research, first, second } = await background();
      const source = await sourceOk(research.id);
      const { quotations } = await gridOk(
        source.id,
        [
          { priceItemId: first.id, unitPrice: '150.00' },
          { priceItemId: second.id, unitPrice: '80.00' },
        ],
        '"1"',
      );

      // FA-01: o novo tipo exige órgão e documento de referência.
      const missing = await patchSource(
        source.id,
        { sourceTypeId: types.CONTRATACAO_SIMILAR },
        '"2"',
      );
      expectProblem(missing, 422, 'QUOTATION_REQUIRED_FIELDS');
      expect(fieldErrors(missing)).toEqual([
        ['referenceOrganization', 'CONDITIONAL_REQUIRED'],
        ['referenceDocument', 'CONDITIONAL_REQUIRED'],
      ]);
      const edited = await patchSource(
        source.id,
        {
          sourceTypeId: types.CONTRATACAO_SIMILAR,
          referenceOrganization: 'Prefeitura de Palhoça',
          referenceDocument: 'Contrato 45/2025',
          quoteDate: '2025-08-01',
          notes: 'Contrato vigente.',
        },
        '"2"',
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.headers.etag).toBe('"3"');
      const updated = priceSourceSchema.parse(data(edited));
      // RN-PRICE-26: 01/08/2025 antecede 06/10/2026 − 365 dias → as duas cotações expiram.
      expect(updated.quotations.map((q) => q.isExpired)).toEqual([true, true]);
      const audit = auditOf(process.id, 'price_research.source_update').at(-1);
      const changes = (audit?.changes ?? []) as unknown as readonly { readonly path: string }[];
      expect(changes.map((change) => change.path)).toEqual([
        'sourceTypeId',
        'quoteDate',
        'referenceOrganization',
        'referenceDocument',
        'notes',
      ]);
      expect(JSON.stringify(audit?.changes)).not.toContain('Palhoça');

      // FA-03: edição unitária da cotação (versão 2: a reavaliação da validade a regravou).
      const [q1, q2] = quotations;
      const one = await patchQuotation(
        q1?.id ?? '',
        { unitPrice: '149.90', brandModel: 'CP II' },
        '"2"',
      );
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(one.headers.etag).toBe('"3"');
      expect(quotationSchema.parse(data(one))).toMatchObject({
        unitPrice: '149.9000',
        brandModel: 'CP II',
      });
      expect(auditOf(process.id, 'price_research.quotation_update')).toHaveLength(1);
      // A fonte ganhou versão nova: a grade com a versão antiga recebe 412.
      expectProblem(await putGrid(source.id, [], '"3"'), 412, 'VERSION_CONFLICT');

      // FA-04: remoção unitária.
      expectProblem(await deleteQuotation(q2?.id ?? '', '"1"'), 412, 'VERSION_CONFLICT');
      expect((await deleteQuotation(q2?.id ?? '', '"2"')).status).toBe(204);
      expect(auditOf(process.id, 'price_research.quotation_delete').at(-1)?.metadata).toMatchObject(
        {
          priceItemId: second.id,
          priceSourceId: source.id,
        },
      );
      const items = await itemsOf(research.id);
      expect(items.map((item) => item.validQuotationsCount)).toEqual([1, 0]);

      // FA-02: remover a fonte leva as cotações em cascata.
      const [current] = await sourcesOk(research.id);
      expectProblem(await deleteSource(source.id, '"1"'), 412, 'VERSION_CONFLICT');
      const removed = await deleteSource(source.id, `"${String(current?.version ?? 0)}"`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      expect(sourcesOf(research.id)).toEqual([]);
      expect(quotationsOf(research.id)).toEqual([]);
      expect(auditOf(process.id, 'price_research.source_delete').at(-1)?.metadata).toMatchObject({
        quotationsRemoved: 1,
      });
      expect((await itemsOf(research.id)).map((item) => item.validQuotationsCount)).toEqual([0, 0]);
    });

    it('Linha vazia não altera a cotação; data-base nova reavalia a validade (FA-07 da US-024); remover o item leva as cotações', async () => {
      const { research, first, second } = await background();
      const source = await sourceOk(research.id, directBody({ quoteDate: '2026-04-09' }));
      await gridOk(
        source.id,
        [
          { priceItemId: first.id, unitPrice: '150.00' },
          { priceItemId: second.id, unitPrice: '80.00' },
        ],
        '"1"',
      );
      const blank = await gridOk(
        source.id,
        [
          { priceItemId: first.id, unitPrice: '' },
          { priceItemId: second.id, unitPrice: '80.00' },
        ],
        '"2"',
      );
      // Nada mudou: a fonte continua na versão 2.
      expect(blank.etag).toBe('"2"');
      expect(blank.quotations.map((q) => q.unitPrice)).toEqual(['150.0000', '80.0000']);

      const dated = await auth(request(api.server).patch(`/api/v1/price-research/${research.id}`))
        .set('If-Match', `"${String(researchOf(research.id)?.version ?? 0)}"`)
        .send({ referenceDate: TODAY });
      expect(dated.status, JSON.stringify(dated.body)).toBe(200);
      expect(quotationsOf(research.id).every((q) => !q.isExpired)).toBe(true);
      const later = await auth(request(api.server).patch(`/api/v1/price-research/${research.id}`))
        .set('If-Match', `"${String(researchOf(research.id)?.version ?? 0)}"`)
        .send({ referenceDate: '2026-10-05' });
      expect(later.status, JSON.stringify(later.body)).toBe(200);
      // 09/04 continua dentro de 180 dias de 05/10.
      expect(quotationsOf(research.id).every((q) => !q.isExpired)).toBe(true);

      const removeItem = await auth(
        request(api.server).delete(`/api/v1/price-items/${second.id}`),
      ).set('If-Match', `"${String((await itemsOf(research.id))[1]?.version ?? 0)}"`);
      expect(removeItem.status, JSON.stringify(removeItem.body)).toBe(204);
      expect(quotationsOf(research.id).map((q) => q.priceItemId)).toEqual([first.id]);
    });

    it('Fornecedor referenciado por fonte não pode ser excluído (SUPPLIER_IN_USE — RN-PRICE-19)', async () => {
      const { research } = await background();
      const supplier = supplierOf(A, { legalName: 'Usada Ltda.' });
      seedSuppliers(api, supplier);
      await sourceOk(research.id, directBody({ supplierId: supplier.id }));
      const response = await auth(
        request(api.server).delete(`/api/v1/suppliers/${supplier.id}`),
      ).set('If-Match', '"1"');
      expectProblem(response, 409, 'SUPPLIER_IN_USE');
    });
  });

  describe('[Validação]', () => {
    it('Fonte sem campo exigido pelo tipo: 422 QUOTATION_REQUIRED_FIELDS e nenhuma fonte criada', async () => {
      const { research } = await background();
      const response = await createSource(research.id, directBody({ supplierId: undefined }));
      const problem = expectProblem(response, 422, 'QUOTATION_REQUIRED_FIELDS');
      expect(problem.detail).toBe('Para este tipo de fonte, informe: fornecedor.');
      expect(problem.errors).toEqual([
        { field: 'supplierId', code: 'CONDITIONAL_REQUIRED', message: 'Selecione o fornecedor' },
      ]);
      expect(sourcesOf(research.id)).toEqual([]);
    });

    it('Preço unitário zero: 422 VALIDATION_ERROR com INVALID_DECIMAL em unitPrice e nada gravado', async () => {
      const { research, first, second } = await background();
      const source = await sourceOk(research.id);
      const response = await putGrid(
        source.id,
        [
          { priceItemId: first.id, unitPrice: '10.00' },
          { priceItemId: second.id, unitPrice: '0' },
        ],
        '"1"',
      );
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['items[1].unitPrice', 'INVALID_DECIMAL']]);
      expect(quotationsOf(research.id)).toEqual([]);
      // Casas além do snapshot (2) e item de outra pesquisa.
      const other = await putGrid(
        source.id,
        [
          { priceItemId: first.id, unitPrice: '1.234' },
          { priceItemId: newId(), unitPrice: '1' },
        ],
        '"1"',
      );
      expect(fieldErrors(other)).toEqual([
        ['items[0].unitPrice', 'INVALID_DECIMAL'],
        ['items[1].priceItemId', 'REFERENCE_NOT_FOUND'],
      ]);
      const single = await patchQuotation(newId(), { unitPrice: '1' }, '"1"');
      expectProblem(single, 404, 'NOT_FOUND');
    });

    it('V-02/V-03/V-04/V-05: tipo inválido, fornecedor inativo, URL sem https e datas futuras', async () => {
      const { research } = await background();
      const wrongType = await createSource(research.id, directBody({ sourceTypeId: units.sc }));
      expectProblem(wrongType, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(wrongType)).toEqual([['sourceTypeId', 'REFERENCE_NOT_FOUND']]);
      const inactive = await createSource(
        research.id,
        directBody({ supplierId: inactiveSupplier.id }),
      );
      expect(fieldErrors(inactive)).toEqual([['supplierId', 'REFERENCE_INACTIVE']]);
      const http = await createSource(research.id, {
        sourceTypeId: types.SITIO_ELETRONICO,
        description: 'Sítio',
        url: 'http://exemplo.gov.br',
        accessedAt: '2026-09-12T14:32:00Z',
      });
      expectProblem(http, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(http)).toEqual([['url', 'INVALID_FORMAT']]);
      const future = await createSource(research.id, {
        sourceTypeId: types.SITIO_ELETRONICO,
        description: 'Sítio',
        url: 'https://exemplo.gov.br',
        accessedAt: '2026-10-06T15:00:01Z',
        quoteDate: '2026-10-07',
      });
      expect(fieldErrors(future)).toEqual([
        ['quoteDate', 'DATE_IN_PAST'],
        ['accessedAt', 'DATE_IN_PAST'],
      ]);
      expect(sourcesOf(research.id)).toEqual([]);
    });

    it('FA-05: cotação desconsiderada (EXCLUDED) não muda pela grade nem pela edição: 409 INVALID_STATE', async () => {
      const { research, first } = await background();
      const source = await sourceOk(research.id);
      const { quotations } = await gridOk(
        source.id,
        [{ priceItemId: first.id, unitPrice: '10' }],
        '"1"',
      );
      const [quotation] = quotationsOf(research.id);
      if (!quotation) throw new Error('cotação ausente');
      sourcesStore().replaceQuotation({
        ...quotation,
        status: 'EXCLUDED',
        exclusionReason: 'EXCESSIVE',
        exclusionJustification: 'Preço muito acima dos demais orçamentos.',
      });
      const grid = await putGrid(source.id, [{ priceItemId: first.id, unitPrice: '11' }], '"2"');
      const problem = expectProblem(grid, 409, 'INVALID_STATE');
      expect(problem.detail).toBe(
        'Esta cotação foi desconsiderada. Restaure-a para editar o preço.',
      );
      expectProblem(
        await patchQuotation(quotations[0]?.id ?? '', { unitPrice: '11' }, '"1"'),
        409,
        'INVALID_STATE',
      );
      const [listed] = await sourcesOk(research.id);
      expect(listed?.quotations[0]).toMatchObject({
        status: 'EXCLUDED',
        exclusionReason: 'EXCESSIVE',
        unitPrice: '10.0000',
      });
      expect((await itemsOf(research.id))[0]?.validQuotationsCount).toBe(1);
    });

    it('FA-08: pesquisa em revisão ou concluída → 409 DOCUMENT_NOT_EDITABLE', async () => {
      const { research, first } = await background();
      const source = await sourceOk(research.id);
      const document = documentRepositoryOf(api)
        .allDocuments()
        .find((candidate) => candidate.id === research.documentId);
      if (!document) throw new Error('documento ausente');
      documentRepositoryOf(api).seed({ ...document, status: 'IN_REVIEW' });
      const problem = expectProblem(
        await putGrid(source.id, [{ priceItemId: first.id, unitPrice: '10' }], '"1"'),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(problem.detail).toBe('Esta pesquisa de preços não pode mais ser editada.');
      expectProblem(await createSource(research.id, directBody()), 409, 'DOCUMENT_NOT_EDITABLE');
      expect(quotationsOf(research.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem PRICE_RESEARCH_UPDATE: 403 PERMISSION_DENIED com access.denied e nenhuma fonte; a leitura continua', async () => {
      const { process, research } = await background();
      const response = await createSource(research.id, directBody(), { subject: EVA });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PRICE_RESEARCH_UPDATE',
      });
      expect(sourcesOf(research.id)).toEqual([]);
      expect(await sourcesOk(research.id, EVA)).toEqual([]);
      expect(auditOf(process.id, 'price_research.source_create')).toEqual([]);
    });

    it('POL-09: em processo sigiloso, quem não vê o orçamento lê as fontes com o preço mascarado e não edita', async () => {
      const { process, research, first } = await background();
      const source = await sourceOk(research.id);
      await gridOk(source.id, [{ priceItemId: first.id, unitPrice: '150.00' }], '"1"');
      moveTo(process, { isBudgetConfidential: true });
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      const [masked] = await sourcesOk(research.id, 'sub-otavio');
      expect(masked?.quotations[0]).toMatchObject({ unitPrice: null, unitPriceMasked: true });
      expectProblem(
        await putGrid(source.id, [{ priceItemId: first.id, unitPrice: '1' }], '"2"', {
          subject: 'sub-otavio',
        }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-09',
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Referenciar fornecedor de outro tenant: 422 REFERENCE_NOT_FOUND em supplierId', async () => {
      const { research } = await background();
      const response = await createSource(research.id, directBody({ supplierId: supplierB.id }));
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['supplierId', 'REFERENCE_NOT_FOUND']]);
      expect(sourcesOf(research.id)).toEqual([]);
    });

    it('Fonte e cotação de outro tenant: 404 em PRS-09..15 sem alterar nada', async () => {
      const { research, first } = await background();
      const source = await sourceOk(research.id);
      const { quotations } = await gridOk(
        source.id,
        [{ priceItemId: first.id, unitPrice: '10' }],
        '"1"',
      );
      const quotationId = quotations[0]?.id ?? '';
      // Fábio também tem vínculo na Prefeitura B.
      expectProblem(await listSources(research.id, DIEGO, B), 404, 'NOT_FOUND');
      expectProblem(await createSource(research.id, directBody(), { tenant: B }), 404, 'NOT_FOUND');
      expectProblem(
        await patchSource(source.id, { notes: 'x' }, '"2"', DIEGO, B),
        404,
        'NOT_FOUND',
      );
      expectProblem(await deleteSource(source.id, '"2"', DIEGO, B), 404, 'NOT_FOUND');
      expectProblem(
        await putGrid(source.id, [{ priceItemId: first.id, unitPrice: '1' }], '"2"', { tenant: B }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await patchQuotation(quotationId, { unitPrice: '1' }, '"1"', DIEGO, B),
        404,
        'NOT_FOUND',
      );
      expectProblem(await deleteQuotation(quotationId, '"1"', DIEGO, B), 404, 'NOT_FOUND');
      expect(quotationsOf(research.id).map((q) => q.unitPrice)).toEqual(['10.0000']);
      expect(sourcesOf(research.id).map((s) => s.version)).toEqual([2]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da grade com a mesma chave de idempotência: 200 com Idempotent-Replayed e nenhuma cotação duplicada', async () => {
      const { research, first, second } = await background();
      const source = await sourceOk(research.id);
      const items = [
        { priceItemId: first.id, unitPrice: '150.00' },
        { priceItemId: second.id, unitPrice: '80.00' },
      ];
      // A chave "K1" do Gherkin (o contrato exige UUID).
      const k1 = randomUUID();
      const original = await putGrid(source.id, items, '"1"', { key: k1 });
      expect(original.status, JSON.stringify(original.body)).toBe(200);
      const replay = await putGrid(source.id, items, '"1"', { key: k1 });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(original.body);
      expect(quotationsOf(research.id)).toHaveLength(2);
      expect(auditOf(research.processId, 'price_research.quotation_create')).toHaveLength(2);
    });

    it('Reenvio da criação da fonte com a mesma chave: uma só fonte', async () => {
      const { research } = await background();
      const key = randomUUID();
      const first = await createSource(research.id, directBody(), { key });
      const again = await createSource(research.id, directBody(), { key });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(sourcesOf(research.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas gravações simultâneas da grade com If-Match 2: uma 200 (versão 3) e outra 412 VERSION_CONFLICT', async () => {
      const { research, first } = await background();
      const source = await sourceOk(research.id);
      const touched = await patchSource(
        source.id,
        { notes: 'Orçamento recebido por e-mail.' },
        '"1"',
      );
      expect(touched.headers.etag).toBe('"2"');
      const [a, b] = await Promise.all([
        putGrid(source.id, [{ priceItemId: first.id, unitPrice: '150.00' }], '"2"'),
        putGrid(source.id, [{ priceItemId: first.id, unitPrice: '151.00' }], '"2"'),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 412]);
      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      expect(winner.headers.etag).toBe('"3"');
      expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect(problemDetailsSchema.parse(loser.body)).toMatchObject({ currentVersion: 3 });
      expect(quotationsOf(research.id)).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao salvar a grade: 503 DEPENDENCY_UNAVAILABLE e nenhuma cotação persistida', async () => {
      const { research, first, second } = await background();
      const source = await sourceOk(research.id);
      transactions.down = true;
      const response = await putGrid(
        source.id,
        [
          { priceItemId: first.id, unitPrice: '150.00' },
          { priceItemId: second.id, unitPrice: '80.00' },
        ],
        '"1"',
      );
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(quotationsOf(research.id)).toEqual([]);
      expect(sourcesOf(research.id).map((s) => s.version)).toEqual([1]);
    });
  });

  describe('[Falha de integração]', () => {
    const intent = (sourceId: string) =>
      auth(request(api.server).post('/api/v1/attachments'))
        .set('Idempotency-Key', randomUUID())
        .send({
          targetType: 'PRICE_SOURCE',
          targetId: sourceId,
          fileName: 'orcamento-construtora-xyz.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: 120_000,
        });

    it('Upload do anexo da fonte falha: a fonte permanece salva sem o anexo e editável', async () => {
      const { research } = await background();
      const source = await sourceOk(research.id);
      storage.failing = new Error('ECONNREFUSED');
      expectProblem(await intent(source.id), 503, 'DEPENDENCY_UNAVAILABLE');
      storage.failing = null;
      expect(sourcesOf(research.id).map((s) => s.id)).toEqual([source.id]);
      const edited = await patchSource(source.id, { notes: 'Anexo pendente.' }, '"1"');
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    });

    it('Anexo da fonte pelo fluxo genérico (ATT-02 com alvo PRICE_SOURCE); fonte de outro tenant = 404', async () => {
      const { process, research } = await background();
      const source = await sourceOk(research.id);
      const response = await intent(source.id);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(data<{ targetType: string; processId: string }>(response)).toMatchObject({
        targetType: 'PRICE_SOURCE',
        processId: process.id,
      });
      expectProblem(await intent(newId()), 404, 'NOT_FOUND');
    });
  });
});

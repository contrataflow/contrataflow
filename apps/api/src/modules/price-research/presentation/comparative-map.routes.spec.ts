import { randomUUID } from 'node:crypto';

import {
  comparativeMapSchema,
  documentRenditionSchema,
  priceItemSchema,
  priceResearchSchema,
  priceSourceSchema,
  problemDetailsSchema,
  quotationSchema,
} from '@contrataflow/validation';
import type {
  ComparativeMapDto,
  DocumentRenditionDto,
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
import { readXlsx } from '#shared/spreadsheet/xlsx.js';
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
import {
  FakePdfRenderer,
  PDF_RENDERER,
  PdfRendererCircuit,
  RenderFailedError,
  RenderRetryableError,
  runRender,
} from '../../../../test/support/rendition-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import {
  PRICE_RESEARCH_CLOCK,
  PRICE_RESEARCH_REPOSITORY,
  PRICE_RESEARCH_TRANSACTIONS,
  PRICE_SOURCE_REPOSITORY,
} from '../application/ports.js';
import type { PriceResearchTransactions } from '../application/ports.js';
import type { PriceItem } from '../domain/price-research.js';
import type { PriceSource } from '../domain/price-source.js';

/*
 * US-031 — Visualizar e exportar o mapa comparativo (PRS-21/22 e o PDF pelo DOC-20/22 do US-067),
 * pelo pipeline HTTP completo com a identidade fake, os seeders reais e o `document-render` rodando
 * como o worker sobre o Gotenberg falso. Background: processo "0012/2026" com 3 itens na etapa
 * PESQUISA_PRECOS e a pesquisa com 4 fontes. Fábio (COMPRAS, responsável — custódia, POL-09) é o
 * "Marcos"; Otávio (COLLABORATOR do processo, sem PROCESS_VIEW_CONFIDENTIAL_BUDGET nem custódia) é o
 * "Bruno". As 8 categorias do Gherkin + FA-01/03/04/05 e V-01/V-02. Leitura consistente sob
 * recálculo concorrente e RLS no PostgreSQL: `test/tenant-leak/comparative-map.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-06T15:00:00.000Z');
const TODAY = '2026-10-06';
const MARCOS = 'sub-fabio';
const BRUNO = 'sub-otavio';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const UNITS_A = {
  organizationId: '0192d031-0000-7000-8000-0000000000a0',
  obras: '0192d031-0000-7000-8000-0000000000a1',
  manutencao: '0192d031-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d031-0000-7000-8000-0000000000a3',
  saude: '0192d031-0000-7000-8000-0000000000a4',
  posto: '0192d031-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d031-0000-7000-8000-0000000000b0',
  obras: '0192d031-0000-7000-8000-0000000000b1',
  manutencao: '0192d031-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d031-0000-7000-8000-0000000000b3',
  saude: '0192d031-0000-7000-8000-0000000000b4',
  posto: '0192d031-0000-7000-8000-0000000000b5',
};

/** Preços do Background: 3 itens × 4 fontes (o Item 3 fica sem cotação; a fonte 3 sem o Item 2). */
const PRICES: readonly (readonly (string | null)[])[] = [
  ['100.00', '110.00', '105.00', '300.00'],
  ['50.00', '52.00', null, '51.00'],
  [null, null, null, null],
];

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

/** Corpo binário (XLSX) ou JSON (problema). */
function binary(
  response: request.Response,
  callback: (error: Error | null, body: unknown) => void,
) {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const type = response.headers['content-type'] ?? '';
    callback(
      null,
      type.includes('json') ? (JSON.parse(buffer.toString('utf8')) as unknown) : buffer,
    );
  });
}

/** As linhas da planilha como texto, por coluna (vazias = ''). */
function sheet(buffer: Buffer): string[][] {
  return readXlsx(buffer, { maxRows: 10_000, maxColumns: 200 }).map((row) => {
    const width = Math.max(-1, ...row.cells.keys()) + 1;
    return Array.from({ length: width }, (_, index) => row.cells.get(index)?.text ?? '');
  });
}

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Visualizar e exportar o mapa comparativo (US-031)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  const renderer = new FakePdfRenderer();
  let units: { sc: string; m3: string };
  let catalog: { contractingType: string; origin: string };
  let directType: string;
  let supplierA: Supplier;
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = MARCOS, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const getMap = (researchId: string, subject = MARCOS, tenant: string = A) =>
    auth(
      request(api.server).get(`/api/v1/price-research/${researchId}/comparative-map`),
      subject,
      tenant,
    );
  const exportMap = (researchId: string, subject = MARCOS, format: string | null = 'xlsx') =>
    auth(
      request(api.server).get(
        `/api/v1/price-research/${researchId}/comparative-map/export${format === null ? '' : `?format=${format}`}`,
      ),
      subject,
    )
      .buffer(true)
      .parse(binary);
  const requestPdf = (documentId: string, subject = MARCOS) =>
    auth(request(api.server).post(`/api/v1/documents/${documentId}/preview`), subject).send();
  const renditionStatus = (renditionId: string, subject = MARCOS) =>
    auth(request(api.server).get(`/api/v1/document-renditions/${renditionId}`), subject);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const eventsOf = (eventType: string, renditionId: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.eventType === eventType &&
          (row.payload as { renditionId?: string }).renditionId === renditionId,
      );
  const loggedEvents = (level: 'log' | 'warn' | 'error', event: string) =>
    vi
      .spyOn(Logger.prototype, level)
      .mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === event);
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

  async function itemOk(processId: string, description: string, unit: string, quantity: string) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/items`),
      'sub-ana',
    )
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description, unitOfMeasureId: unit });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const item = data<ProcessItemDto>(response);
    setProcessItemReferenceQuantity(api, item.id, `${quantity}.0000`);
    return item;
  }

  /** Background: "0012/2026" com 3 itens, a pesquisa "PR-01" e 4 fontes com os `PRICES`. */
  async function background(prices: readonly (readonly (string | null)[])[] = PRICES) {
    const created = await newProcess();
    await itemOk(created.id, 'Cimento CP II 50 kg', units.sc, '100');
    await itemOk(created.id, 'Areia média', units.m3, '12');
    await itemOk(created.id, 'Brita nº 1', units.m3, '8');
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
    const items = z
      .array(priceItemSchema)
      .parse(
        data(await auth(request(api.server).get(`/api/v1/price-research/${research.id}/items`))),
      );
    const sources = [];
    for (let column = 0; column < 4; column += 1) {
      const created = await auth(
        request(api.server).post(`/api/v1/price-research/${research.id}/sources`),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          sourceTypeId: directType,
          description: `Orçamento ${String(column + 1)}`,
          supplierId: supplierA.id,
          quoteDate: '2026-09-30',
          supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const source = priceSourceSchema.parse(data(created));
      const lines = items.flatMap((item, row) => {
        const price = prices[row]?.[column] ?? null;
        return price === null ? [] : [{ priceItemId: item.id, unitPrice: price }];
      });
      if (lines.length > 0) {
        const grid = await auth(
          request(api.server).put(`/api/v1/price-sources/${source.id}/quotations`),
        )
          .set('If-Match', '"1"')
          .send({ items: lines });
        expect(grid.status, JSON.stringify(grid.body)).toBe(200);
        z.array(quotationSchema).parse(data(grid));
      }
      sources.push(source);
    }
    return { process, research, items, sources };
  }

  async function mapOf(researchId: string, subject = MARCOS): Promise<ComparativeMapDto> {
    const response = await getMap(researchId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return comparativeMapSchema.parse(data(response));
  }

  /** "Bruno": Otávio colaborador do processo sigiloso, sem POL-09. */
  function confidentialForBruno(process: Process) {
    moveTo(process, { isBudgetConfidential: true });
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.otavio.id,
      role: 'COLLABORATOR',
      expiresAt: new Date('2026-12-31T23:59:59Z'),
    });
  }

  /** O PDF da pesquisa (DOC-20 → `document-render`), devolvendo a rendition final. */
  async function renderPdf(documentId: string, subject = MARCOS) {
    const requested = await requestPdf(documentId, subject);
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const pending = documentRenditionSchema.parse(data(requested));
    await runRender(api, pending.id);
    const ready = await renditionStatus(pending.id, subject);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    return documentRenditionSchema.parse(data<DocumentRenditionDto>(ready));
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
        { token: PDF_RENDERER, value: renderer },
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
    directType = catalogItemId(api, A, 'PRICE_SOURCE_TYPE', 'PESQUISA_DIRETA_FORNECEDOR');
    supplierA = buildSupplier(A);
    seedSuppliers(api, supplierA);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    renderer.failing = null;
    api.app.get(PdfRendererCircuit).recordSuccess();
  });

  describe('[Sucesso]', () => {
    it('Visualizar o mapa comparativo completo: 3 itens em linha, 4 fontes em coluna, preços, selos, estatísticas e alertas', async () => {
      const { research, items, sources } = await background();
      const map = await mapOf(research.id);
      expect(map.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
      expect(map.sources.map((source) => source.id)).toEqual(sources.map((source) => source.id));
      expect(map.masked).toBe(false);
      // Cada célula cotada: preço unitário e selo de destaque quando houver (RN-PRICE-53).
      expect(map.cells).toHaveLength(7);
      const cell = (row: number, column: number) =>
        map.cells.find(
          (candidate) =>
            candidate.priceItemId === items[row]?.id &&
            candidate.priceSourceId === sources[column]?.id,
        );
      expect(cell(0, 0)).toMatchObject({
        unitPrice: '100.0000',
        status: 'VALID',
        outlierFlag: 'NONE',
      });
      expect(cell(0, 3)).toMatchObject({ unitPrice: '300.0000', outlierFlag: 'HIGH' });
      expect(cell(1, 2)).toBeUndefined();
      expect(map.cells.some((candidate) => candidate.priceItemId === items[2]?.id)).toBe(false);
      // Cada linha: estatísticas e alertas do item (US-029/US-030).
      const [first, second, third] = map.items;
      expect(first).toMatchObject({
        sequence: 1,
        description: 'Cimento CP II 50 kg',
        validQuotationsCount: 4,
        lowestPrice: '100.0000',
        highestPrice: '300.0000',
        valuesMasked: false,
      });
      expect(first?.recommendedUnitPrice).not.toBeNull();
      expect(first?.alerts.map((alert) => alert.code)).toContain('HAS_OUTLIERS');
      expect(second).toMatchObject({ validQuotationsCount: 3, lowestPrice: '50.0000' });
      expect(third).toMatchObject({ validQuotationsCount: 0, recommendedUnitPrice: null });
      expect(third?.alerts.map((alert) => alert.code)).toEqual(['NO_VALID_QUOTES']);
      // RN-PRICE-57: referência de "calculado há".
      expect(map.lastCalculatedAt).toBe(NOW.toISOString());
      expect(map.referenceDate).toBe(TODAY);
      // Somente leitura: sem auditoria.
      expect(api.auditRecords().filter((row) => row.action === 'price_research.export')).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ entityId: research.id })]),
      );
    });

    it('Exportar o mapa em XLSX: 200 com o arquivo da mesma matriz e auditoria price_research.export', async () => {
      const { process, research, items } = await background();
      const map = await mapOf(research.id);
      const response = await exportMap(research.id);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain(XLSX);
      expect(response.headers['content-disposition']).toMatch(
        /^attachment; filename="mapa-comparativo-pp-\d{4}-\d{4}\.xlsx"$/,
      );
      const rows = sheet(response.body as Buffer);
      expect(rows[0]?.slice(0, 8)).toEqual([
        'Item',
        'Descrição',
        'Unidade',
        'Quantidade',
        'Orçamento 1',
        'Orçamento 2',
        'Orçamento 3',
        'Orçamento 4',
      ]);
      // A mesma matriz exibida em tela.
      map.items.forEach((item, index) => {
        const row = rows[index + 1] ?? [];
        expect(row[0]).toBe(String(item.sequence));
        expect(row[1]).toBe(item.description);
        map.sources.forEach((source, column) => {
          const cell = map.cells.find(
            (candidate) =>
              candidate.priceItemId === item.id && candidate.priceSourceId === source.id,
          );
          expect(row[4 + column] ?? '').toBe(cell?.unitPrice ?? '');
        });
      });
      expect(rows[1]?.at(-1)).toBe('Orçamento 4: Acima da mediana');
      expect(rows[3]?.join('|')).toContain('Sem cotações válidas');
      expect(items).toHaveLength(3);

      const [audit] = auditOf(process.id, 'price_research.export');
      expect(audit).toMatchObject({
        entityType: 'PriceResearch',
        entityId: research.id,
        result: 'SUCCESS',
        metadata: { format: 'xlsx', itemsCount: 3, sourcesCount: 4, masked: false },
      });
      // Logs sem preços (a planilha nunca é logada).
      const exported = loggedEvents('log', 'price_research.map_exported').at(-1);
      expect(exported).toMatchObject({
        priceResearchId: research.id,
        format: 'xlsx',
        itemsCount: 3,
        sourcesCount: 4,
      });
      expect(JSON.stringify(exported)).not.toMatch(/100\.00|300\.00/);
    });

    it('PDF (fluxo 4): a prévia do documento traz a seção PRICE_SUMMARY com a mesma matriz', async () => {
      const { research } = await background();
      const rendition = await renderPdf(research.documentId);
      expect(rendition).toMatchObject({ status: 'READY', masked: false });
      const html = renderer.lastHtml();
      expect(html).toContain('Mapa comparativo de preços');
      expect(html).toContain('<th>F1</th><th>F2</th><th>F3</th><th>F4</th>');
      expect(html).toContain('<td>Orçamento 1</td>');
      expect(html).toContain('300,00<br><span class="cf-badge">Acima da mediana</span>');
      expect(html).toContain('Sem cotações válidas');
      // A seção computada nunca sai como "não preenchida".
      const section = html.slice(html.indexOf('Mapa comparativo de preços'), html.indexOf('3. '));
      expect(section).toContain('<th>F1</th>');
      expect(section).not.toContain('Seção não preenchida');
    });

    it('FA-04: pesquisa sem fontes mostra os itens e a mensagem no lugar das colunas', async () => {
      const { research } = await background([]);
      // `background([])` ainda cria 4 fontes sem preço; a pesquisa sem fonte nenhuma vem de outra:
      const created = await newProcess();
      await itemOk(created.id, 'Cimento CP II 50 kg', units.sc, '10');
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
      const empty = priceResearchSchema.parse(data(response));
      const map = await mapOf(empty.id);
      expect(map.items).toHaveLength(1);
      expect(map.sources).toEqual([]);
      expect(map.cells).toEqual([]);
      const rows = sheet((await exportMap(empty.id)).body as Buffer);
      expect(rows.some((row) => row[1] === 'Cadastre ao menos uma fonte para montar o mapa')).toBe(
        true,
      );
      // A pesquisa com fontes sem cotação: colunas presentes, nenhuma célula.
      const withoutPrices = await mapOf(research.id);
      expect(withoutPrices.sources).toHaveLength(4);
      expect(withoutPrices.cells).toEqual([]);
    });
  });

  describe('[Validação]', () => {
    /** Itens/fontes clonados direto nos repositórios em memória (600 itens pela API seria lento). */
    function inflate(researchId: string, totalItems: number, totalSources: number) {
      const researches = api.app.get<unknown, { items: Map<string, PriceItem> }>(
        PRICE_RESEARCH_REPOSITORY,
        { strict: false },
      );
      const sourcesRepo = api.app.get<unknown, { sources: Map<string, PriceSource> }>(
        PRICE_SOURCE_REPOSITORY,
        { strict: false },
      );
      const items = [...researches.items.values()].filter(
        (item) => item.priceResearchId === researchId,
      );
      const template = items[0];
      if (template === undefined) throw new Error('item ausente');
      for (let index = items.length; index < totalItems; index += 1) {
        const id = randomUUID();
        researches.items.set(id, { ...template, id, sortOrder: index + 1 });
      }
      const sources = [...sourcesRepo.sources.values()].filter(
        (source) => source.priceResearchId === researchId,
      );
      const base = sources[0];
      if (base === undefined) throw new Error('fonte ausente');
      for (let index = sources.length; index < totalSources; index += 1) {
        const id = randomUUID();
        sourcesRepo.sources.set(id, {
          ...base,
          id,
          description: `Fonte ${String(index + 1)}`,
          sortOrder: index + 1,
        });
      }
    }

    it('Exportação acima do limite síncrono: 600 itens → 422 EXPORT_TOO_LARGE (sem arquivo nem auditoria)', async () => {
      const { process, research } = await background();
      inflate(research.id, 600, 4);
      const response = await exportMap(research.id);
      const problem = expectProblem(response, 422, 'EXPORT_TOO_LARGE');
      expect(problem.detail).toBe(
        'Esta pesquisa tem mais itens/fontes do que o exportável de uma vez. Gere o PDF ou reduza o recorte.',
      );
      expect((problem as { meta?: unknown }).meta).toMatchObject({
        itemsCount: 600,
        sourcesCount: 4,
      });
      expect(auditOf(process.id, 'price_research.export')).toEqual([]);
      // A tela continua (PRS-21 não tem teto).
      expect((await mapOf(research.id)).items).toHaveLength(600);
    });

    it('Limite nos dois lados: 500 × 50 exporta (com aviso de proximidade); 501 itens ou 51 fontes → 422', async () => {
      const { research } = await background();
      inflate(research.id, 500, 50);
      const ok = await exportMap(research.id);
      expect(ok.status).toBe(200);
      expect(sheet(ok.body as Buffer)[0]).toHaveLength(4 + 50 + 12);
      expect(loggedEvents('warn', 'price_research.export_near_limit').at(-1)).toMatchObject({
        priceResearchId: research.id,
        itemsCount: 500,
        sourcesCount: 50,
      });
      inflate(research.id, 500, 51);
      expectProblem(await exportMap(research.id), 422, 'EXPORT_TOO_LARGE');

      const other = await background();
      inflate(other.research.id, 501, 4);
      expectProblem(await exportMap(other.research.id), 422, 'EXPORT_TOO_LARGE');
    });

    it('V-02: format diferente de xlsx (ou ausente) → 422 VALIDATION_ERROR', async () => {
      const { research } = await background();
      const pdf = expectProblem(
        await exportMap(research.id, MARCOS, 'pdf'),
        422,
        'VALIDATION_ERROR',
      );
      expect(pdf.errors).toEqual([
        expect.objectContaining({
          field: 'format',
          code: 'INVALID_ENUM',
          message: 'Formato de exportação não suportado.',
        }),
      ]);
      const missing = expectProblem(
        await exportMap(research.id, MARCOS, null),
        422,
        'VALIDATION_ERROR',
      );
      expect(missing.errors.map((error) => error.field)).toEqual(['format']);
    });
  });

  describe('[Permissão]', () => {
    it('Sem PROCESS_VIEW_CONFIDENTIAL_BUDGET em orçamento sigiloso: tela, XLSX e PDF mascarados', async () => {
      const { process, research } = await background();
      confidentialForBruno(process);

      // Tela: toda célula monetária null com masked.
      const map = await mapOf(research.id, BRUNO);
      expect(map.masked).toBe(true);
      expect(map.totalEstimatedValue).toBeNull();
      expect(map.cells).toHaveLength(7);
      for (const cell of map.cells) {
        expect(cell).toMatchObject({ unitPrice: null, unitPriceMasked: true });
      }
      for (const item of map.items) {
        expect(item).toMatchObject({
          meanPrice: null,
          medianPrice: null,
          lowestPrice: null,
          highestPrice: null,
          stdDeviation: null,
          coefficientOfVariation: null,
          recommendedUnitPrice: null,
          totalPrice: null,
          valuesMasked: true,
        });
      }
      // Selos e alertas continuam visíveis.
      expect(map.cells.some((cell) => cell.outlierFlag === 'HIGH')).toBe(true);
      expect(map.items[2]?.alerts).toEqual([{ code: 'NO_VALID_QUOTES' }]);

      // XLSX: "Sigiloso" e auditoria com masked: true.
      const response = await exportMap(research.id, BRUNO);
      expect(response.status).toBe(200);
      const rows = sheet(response.body as Buffer);
      expect(rows[1]?.slice(4, 8)).toEqual(['Sigiloso', 'Sigiloso', 'Sigiloso', 'Sigiloso']);
      const flat = rows.flat().join('|');
      // (`100.0000` é a quantidade do Item 1, não um valor.)
      for (const value of ['105.0000', '300.0000', '52.0000', '110.0000']) {
        expect(flat).not.toContain(value);
      }
      expect(auditOf(process.id, 'price_research.export').at(-1)).toMatchObject({
        metadata: { masked: true, itemsCount: 3, sourcesCount: 4 },
      });

      // PDF: a rendition do Bruno é mascarada (POL-09 decidida no pedido).
      const rendition = await renderPdf(research.documentId, BRUNO);
      expect(rendition.masked).toBe(true);
      const html = renderer.lastHtml();
      expect(html).toContain('Valor sigiloso');
      for (const value of ['100,00', '300,00', '50,00', '110,00']) {
        expect(html).not.toContain(value);
      }
      expect(html).toContain('Acima da mediana');

      // Marcos (custódia) continua vendo os valores.
      const full = await mapOf(research.id, MARCOS);
      expect(full.masked).toBe(false);
      expect(full.cells[0]?.unitPrice).toBe('100.0000');
    });

    it('Sem PROCESS_VIEW sobre o processo: 404 PRICE_RESEARCH_NOT_FOUND no mapa e na exportação', async () => {
      const { process, research } = await background();
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
      const response = await getMap(research.id, 'sub-ana');
      expectProblem(response, 404, 'PRICE_RESEARCH_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(/Orçamento|Cimento/);
      expectProblem(await exportMap(research.id, 'sub-ana'), 404, 'PRICE_RESEARCH_NOT_FOUND');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Mapa de uma priceResearchId existente só na Prefeitura B → 404 PRICE_RESEARCH_NOT_FOUND', async () => {
      const { research } = await background();
      // Fábio também tem vínculo na Prefeitura B, onde a pesquisa não existe.
      const response = await getMap(research.id, MARCOS, B);
      expectProblem(response, 404, 'PRICE_RESEARCH_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(/Orçamento|Cimento|100\.0000/);
      const exported = await auth(
        request(api.server).get(
          `/api/v1/price-research/${research.id}/comparative-map/export?format=xlsx`,
        ),
        MARCOS,
        B,
      );
      expectProblem(exported, 404, 'PRICE_RESEARCH_NOT_FOUND');
      expectProblem(await getMap(newId()), 404, 'PRICE_RESEARCH_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Exportar o mesmo XLSX duas vezes sem recálculo gera o mesmo conteúdo, com uma auditoria por exportação', async () => {
      const { process, research } = await background();
      const first = await exportMap(research.id);
      const second = await exportMap(research.id);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((first.body as Buffer).equals(second.body as Buffer)).toBe(true);
      expect(auditOf(process.id, 'price_research.export')).toHaveLength(2);
    });
  });

  describe('[Concorrência]', () => {
    it('Leitura do mapa durante a exclusão de uma cotação reflete o estado antes ou depois, nunca parcial', async () => {
      const { research, items } = await background();
      const before = await mapOf(research.id);
      const target = before.cells.find(
        (cell) => cell.priceItemId === items[0]?.id && cell.unitPrice === '100.0000',
      );
      if (target === undefined) throw new Error('cotação ausente');
      const sources = z
        .array(priceSourceSchema)
        .parse(
          data(
            await auth(
              request(api.server).get(`/api/v1/price-research/${research.id}/sources?pageSize=100`),
            ),
          ),
        );
      const version = sources
        .flatMap((source) => source.quotations)
        .find((quotation) => quotation.id === target.quotationId)?.version;
      const [excluded, during] = await Promise.all([
        auth(request(api.server).post(`/api/v1/quotations/${target.quotationId}/exclude`))
          .set('If-Match', `"${String(version)}"`)
          .send({
            exclusionReason: 'INCONSISTENT',
            exclusionJustification: 'Preço incompatível com o praticado no mercado regional.',
          }),
        getMap(research.id),
      ]);
      expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
      expect(during.status).toBe(200);
      const seen = comparativeMapSchema.parse(data(during));
      const cell = seen.cells.find((candidate) => candidate.quotationId === target.quotationId);
      const item = seen.items[0];
      // Coerente: a célula e as estatísticas do item são do mesmo estado consolidado.
      if (cell?.status === 'EXCLUDED') {
        expect(item?.validQuotationsCount).toBe(3);
      } else {
        expect(cell?.status).toBe('VALID');
        expect(item?.validQuotationsCount).toBe(4);
      }
      const after = await mapOf(research.id);
      expect(
        after.cells.find((candidate) => candidate.quotationId === target.quotationId),
      ).toMatchObject({ status: 'EXCLUDED', exclusionReason: 'INCONSISTENT' });
      expect(after.items[0]?.validQuotationsCount).toBe(3);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao montar o XLSX → 503 DEPENDENCY_UNAVAILABLE, sem arquivo nem auditoria', async () => {
      const { process, research } = await background();
      transactions.down = true;
      const response = await exportMap(research.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['content-type']).not.toContain(XLSX);
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(auditOf(process.id, 'price_research.export')).toEqual([]);
      expect(loggedEvents('error', 'price_research.export_failed').at(-1)).toMatchObject({
        errorCode: 'DEPENDENCY_UNAVAILABLE',
      });
      expectProblem(await getMap(research.id), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect((await exportMap(research.id)).status).toBe(200);
    });
  });

  describe('[Falha de integração]', () => {
    it('Worker de renderização indisponível: DocumentRenditionFailed ao esgotar as tentativas e o XLSX continua disponível', async () => {
      const { research } = await background();
      const requested = await requestPdf(research.documentId);
      expect(requested.status, JSON.stringify(requested.body)).toBe(202);
      const pending = documentRenditionSchema.parse(data(requested));
      renderer.failing = 'unavailable';
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(runRender(api, pending.id, attempt)).rejects.toBeInstanceOf(
          RenderRetryableError,
        );
        api.app.get(PdfRendererCircuit).recordSuccess();
      }
      await expect(runRender(api, pending.id, 5)).rejects.toBeInstanceOf(RenderFailedError);
      const failed = documentRenditionSchema.parse(data(await renditionStatus(pending.id)));
      expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'RENDERER_UNAVAILABLE' });
      expect(eventsOf('DocumentRenditionFailed', pending.id)).toHaveLength(1);
      // Caminhos independentes (FA-02): o XLSX segue normal.
      const xlsx = await exportMap(research.id);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain(XLSX);
      // "Tentar novamente" cria outra rendition e renderiza quando o conversor volta.
      renderer.failing = null;
      const retried = await renderPdf(research.documentId);
      expect(retried.status).toBe('READY');
      expect(retried.id).not.toBe(pending.id);
    });
  });
});

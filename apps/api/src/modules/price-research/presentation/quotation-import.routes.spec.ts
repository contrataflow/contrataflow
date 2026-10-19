import { randomUUID } from 'node:crypto';

import {
  priceItemSchema,
  priceResearchSchema,
  priceSourceSchema,
  problemDetailsSchema,
  quotationImportPreviewSchema,
  quotationImportResultSchema,
  quotationSchema,
} from '@contrataflow/validation';
import type { ProcessDto, ProcessItemDto, QuotationImportPreview } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { columnLetter, readXlsx, writeXlsx } from '#shared/spreadsheet/xlsx.js';
import type { XlsxCellValue } from '#shared/spreadsheet/xlsx.js';
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
  seedProcessStructure,
  setProcessItemReferenceQuantity,
  tenantSettingsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { PRICE_RESEARCH_CLOCK, PRICE_RESEARCH_TRANSACTIONS } from '../application/ports.js';
import type { PriceResearchTransactions } from '../application/ports.js';
import { InMemoryPriceSourceRepository } from '../infrastructure/price-source.repositories.js';

/*
 * US-028 — Importar cotações por planilha (PRS-18/19/24), pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, upload multipart, idempotência, filtro RFC 9457) com a
 * identidade fake e os seeders reais. Background: processo "0012/2026" na etapa PESQUISA_PRECOS com
 * 3 itens, a pesquisa em DRAFT e 2 fontes ("Painel de Preços" e "Orçamento Construtora XYZ"). Fábio
 * (COMPRAS, responsável) é o "Diego"; Ana (REQUISITANTE — só PROCESS_VIEW) é a "Eva". As 8 categorias
 * do Gherkin + FA-01..FA-06 e o modelo (PRS-24). RLS e transação real no PostgreSQL:
 * `test/tenant-leak/quotation-import.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-06T15:00:00.000Z');
const TODAY = '2026-10-06';
const DIEGO = 'sub-fabio';
const EVA = 'sub-ana';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAINEL = 'Painel de Preços';
const XYZ = 'Orçamento Construtora XYZ';

const UNITS_A = {
  organizationId: '0192d028-0000-7000-8000-0000000000a0',
  obras: '0192d028-0000-7000-8000-0000000000a1',
  manutencao: '0192d028-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d028-0000-7000-8000-0000000000a3',
  saude: '0192d028-0000-7000-8000-0000000000a4',
  posto: '0192d028-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d028-0000-7000-8000-0000000000b0',
  obras: '0192d028-0000-7000-8000-0000000000b1',
  manutencao: '0192d028-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d028-0000-7000-8000-0000000000b3',
  saude: '0192d028-0000-7000-8000-0000000000b4',
  posto: '0192d028-0000-7000-8000-0000000000b5',
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

/** Planilha: a 1ª linha é o cabeçalho (texto); números como número, textos como texto. */
function sheet(rows: readonly (readonly (string | number | null)[])[]): Buffer {
  return writeXlsx({
    name: 'Cotações',
    rows: rows.map((row) =>
      row.map((value): XlsxCellValue => {
        if (value === null) return null;
        return typeof value === 'number'
          ? { kind: 'number', value: String(value) }
          : { kind: 'text', value };
      }),
    ),
  });
}

const HEADER = ['Item', 'Descrição do item', 'Unidade', PAINEL, XYZ] as const;

/** Leitor binário do supertest (o modelo `.xlsx`); problem+json continua objeto. */
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

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Importar cotações por planilha (US-028)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let now = NOW;
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
  const preview = (
    researchId: string,
    file: Buffer,
    options: { subject?: string; tenant?: string; fileName?: string; contentType?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/price-research/${researchId}/import-preview`),
      options.subject,
      options.tenant,
    ).attach('file', file, {
      filename: options.fileName ?? 'cotacoes.xlsx',
      contentType: options.contentType ?? XLSX,
    });
  const apply = (
    researchId: string,
    previewToken: string,
    options: { subject?: string; tenant?: string; key?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/price-research/${researchId}/import`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({ previewToken });
  const template = (researchId: string, subject = DIEGO, tenant: string = A) =>
    auth(
      request(api.server).get(`/api/v1/price-research/${researchId}/import-template`),
      subject,
      tenant,
    )
      .buffer(true)
      .parse(binary);

  const sourcesStore = () => api.app.get(InMemoryPriceSourceRepository, { strict: false });
  const quotationsOf = (researchId: string) =>
    sourcesStore()
      .snapshot()
      .quotations.filter((quotation) => quotation.priceResearchId === researchId);
  const sourcesOf = (researchId: string) =>
    sourcesStore()
      .snapshot()
      .sources.filter((source) => source.priceResearchId === researchId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const importKeys = () =>
    [...api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false }).entries.keys()].filter(
      (key) => key.includes(':price-import:preview:'),
    );
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

  async function sourceOk(researchId: string, body: Record<string, unknown>) {
    const response = await auth(
      request(api.server).post(`/api/v1/price-research/${researchId}/sources`),
    )
      .set('Idempotency-Key', randomUUID())
      .send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return priceSourceSchema.parse(data(response));
  }

  /** Background: "0012/2026" com 3 itens, a pesquisa em DRAFT e as 2 fontes. */
  async function background() {
    const created = await newProcess();
    await itemOk(
      created.id,
      { description: 'Cimento CP II 50 kg', unitOfMeasureId: units.sc },
      '100',
    );
    await itemOk(created.id, { description: 'Areia média', unitOfMeasureId: units.m3 }, '12');
    await itemOk(created.id, { description: 'Brita 1', unitOfMeasureId: units.m3 }, '8');
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
    const items = z.array(priceItemSchema).parse(data(itemsResponse));
    const painel = await sourceOk(research.id, {
      sourceTypeId: types.SITIO_ELETRONICO,
      description: PAINEL,
      url: 'https://paineldeprecos.planejamento.gov.br',
      accessedAt: '2026-09-12T14:32:00Z',
    });
    const xyz = await sourceOk(research.id, {
      sourceTypeId: types.PESQUISA_DIRETA_FORNECEDOR,
      description: XYZ,
      supplierId: supplierA.id,
      quoteDate: '2026-09-30',
      supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
    });
    return { process, research, items, painel, xyz };
  }

  async function previewOk(researchId: string, file: Buffer, subject = DIEGO) {
    const response = await preview(researchId, file, { subject });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return quotationImportPreviewSchema.parse(data(response));
  }

  const FULL = sheet([
    HEADER,
    [1, 'Cimento CP II 50 kg', 'SC', 150, 148.9],
    [2, 'Areia média', 'M3', 80, '79,50'],
    [3, 'Brita 1', 'M3', 45.5, 44.99],
  ]);

  const priceOf = (researchId: string, itemId: string, sourceId: string) =>
    quotationsOf(researchId).find(
      (quotation) => quotation.priceItemId === itemId && quotation.priceSourceId === sourceId,
    )?.unitPrice;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PRICE_RESEARCH_TRANSACTIONS, value: transactions },
        { token: PRICE_RESEARCH_CLOCK, value: () => now },
        { token: CATALOG_CLOCK, value: () => NOW },
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
      ['PESQUISA_DIRETA_FORNECEDOR', 'SITIO_ELETRONICO'].map((code) => [
        code,
        catalogItemId(api, A, 'PRICE_SOURCE_TYPE', code),
      ]),
    );
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
    now = NOW;
  });

  describe('[Sucesso]', () => {
    it('Importar planilha válida: prévia com 6 células válidas; aplicação grava as 6, recalcula uma vez e audita', async () => {
      const { process, research, items, painel, xyz } = await background();
      const logged = vi.spyOn(Logger.prototype, 'log');
      const result = await previewOk(research.id, FULL);
      expect(result.summary).toEqual({
        total: 6,
        valid: 6,
        errors: 0,
        empty: 0,
        warnings: 0,
        rows: 3,
      });
      expect(result).toMatchObject({
        fileName: 'cotacoes.xlsx',
        expiresAt: '2026-10-06T15:15:00.000Z',
        columnIssues: [],
      });
      expect(result.columns).toEqual([
        { column: 'D', header: PAINEL, priceSourceId: painel.id },
        { column: 'E', header: XYZ, priceSourceId: xyz.id },
      ]);
      // A prévia não grava nada nem gera evento (RN-PRICE-37).
      expect(quotationsOf(research.id)).toEqual([]);
      const recalculatedBefore = eventsOf(process.id, 'PriceResearchRecalculated').length;

      const response = await apply(research.id, result.previewToken);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(quotationImportResultSchema.parse(data(response))).toEqual({
        appliedCount: 6,
        skippedCount: 0,
      });
      expect(quotationsOf(research.id)).toHaveLength(6);
      const [first, second] = items;
      if (!first || !second) throw new Error('itens ausentes');
      expect(priceOf(research.id, first.id, xyz.id)).toBe('148.9000');
      expect(priceOf(research.id, second.id, xyz.id)).toBe('79.5000');
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(
        recalculatedBefore + 1,
      );
      expect(auditOf(process.id, 'price_research.import')).toMatchObject([
        {
          entityType: 'PriceResearch',
          entityId: research.id,
          metadata: expect.objectContaining({
            appliedCount: 6,
            skippedCount: 0,
            fileName: 'cotacoes.xlsx',
          }) as unknown,
        },
      ]);
      // As fontes ganham versão nova (a grade aberta recebe 412).
      expect(sourcesOf(research.id).map((source) => source.version)).toEqual([2, 2]);
      // Os itens passam a ter cotações válidas (recálculo).
      const itemsAfter = z
        .array(priceItemSchema)
        .parse(
          data(await auth(request(api.server).get(`/api/v1/price-research/${research.id}/items`))),
        );
      expect(itemsAfter.map((item) => item.validQuotationsCount)).toEqual([2, 2, 2]);
      // Logs sem preços.
      const logs = JSON.stringify(logged.mock.calls);
      expect(logs).toContain('price_research.import_previewed');
      expect(logs).toContain('price_research.import_applied');
      expect(logs).not.toContain('148.9');
      expect(logs).not.toContain('79.5');
    });

    it('Importar planilha com células vazias: só as 4 preenchidas mudam; as vazias não alteram as cotações existentes', async () => {
      const { research, items, painel, xyz } = await background();
      const [first, second, third] = items;
      if (!first || !second || !third) throw new Error('itens ausentes');
      // Cotação já lançada pela grade: item 3 na fonte Painel.
      const grid = await auth(
        request(api.server).put(`/api/v1/price-sources/${painel.id}/quotations`),
      )
        .set('If-Match', '"1"')
        .send({ items: [{ priceItemId: third.id, unitPrice: '45.00' }] });
      expect(grid.status, JSON.stringify(grid.body)).toBe(200);

      const result = await previewOk(
        research.id,
        sheet([
          HEADER,
          [1, null, null, 150, 149],
          [2, null, null, null, 79],
          [3, null, null, null, 44],
        ]),
      );
      expect(result.summary).toMatchObject({ total: 6, valid: 4, empty: 2, errors: 0 });
      const response = await apply(research.id, result.previewToken);
      expect(quotationImportResultSchema.parse(data(response))).toEqual({
        appliedCount: 4,
        skippedCount: 0,
      });
      expect(quotationsOf(research.id)).toHaveLength(5);
      expect(priceOf(research.id, third.id, painel.id)).toBe('45.0000');
      expect(priceOf(research.id, second.id, painel.id)).toBeUndefined();
      expect(priceOf(research.id, first.id, xyz.id)).toBe('149.0000');
    });

    it('PRS-24: o modelo traz itens × fontes com os preços atuais; preenchido e reenviado, é aceito', async () => {
      const { research, items, painel } = await background();
      const [first] = items;
      if (!first) throw new Error('item ausente');
      await auth(request(api.server).put(`/api/v1/price-sources/${painel.id}/quotations`))
        .set('If-Match', '"1"')
        .send({ items: [{ priceItemId: first.id, unitPrice: '150.00' }] });

      const response = await template(research.id);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe(XLSX);
      expect(response.headers['content-disposition']).toMatch(
        /^attachment; filename="cotacoes-pp-\d{4}-2026\.xlsx"$/,
      );
      const file = response.body as Buffer;
      const rows = readXlsx(file, { maxRows: 10, maxColumns: 10 }).map((row) =>
        Object.fromEntries(
          [...row.cells.entries()].map(([column, cell]) => [columnLetter(column), cell.text]),
        ),
      );
      expect(rows).toEqual([
        { A: 'Item', B: 'Descrição do item', C: 'Unidade', D: PAINEL, E: XYZ },
        { A: '1', B: 'Cimento CP II 50 kg', C: 'Unidade', D: '150.00' },
        { A: '2', B: 'Areia média', C: expect.any(String) as string },
        { A: '3', B: 'Brita 1', C: expect.any(String) as string },
      ]);
      // O próprio modelo, sem alteração, é uma prévia válida (1 célula, igual à gravada).
      const result = await previewOk(research.id, file);
      expect(result.summary).toMatchObject({ valid: 1, empty: 5, errors: 0 });
      expect(
        quotationImportResultSchema.parse(data(await apply(research.id, result.previewToken))),
      ).toEqual({ appliedCount: 0, skippedCount: 1 });
    });
  });

  describe('[Validação]', () => {
    it('Linha com preço "-10": erro VALIDATION_ERROR/INVALID_DECIMAL naquela linha/coluna; a célula não é gravada', async () => {
      const { research, items, painel } = await background();
      const result = await previewOk(
        research.id,
        sheet([
          HEADER,
          [1, null, null, -10, 148],
          [2, null, null, 80, 79],
          [3, null, null, 45, 44],
        ]),
      );
      expect(result.summary).toMatchObject({ valid: 5, errors: 1 });
      expect(result.rows[0]?.issues).toEqual([
        {
          severity: 'ERROR',
          code: 'INVALID_DECIMAL',
          row: 2,
          column: 'D',
          header: PAINEL,
          priceSourceId: painel.id,
          message: `Linha 2, fonte '${PAINEL}': preço inválido.`,
        },
      ]);
      const response = await apply(research.id, result.previewToken);
      expect(quotationImportResultSchema.parse(data(response))).toEqual({
        appliedCount: 5,
        skippedCount: 1,
      });
      expect(priceOf(research.id, items[0]?.id ?? '', painel.id)).toBeUndefined();
      expect(quotationsOf(research.id)).toHaveLength(5);
    });

    it('V-03/FA-02/FA-04: item inexistente, coluna desconhecida (aviso) e colunas reordenadas; tudo com erro → nenhuma célula válida', async () => {
      const { research, xyz } = await background();
      const reordered = await previewOk(
        research.id,
        sheet([
          [XYZ, 'Observações', 'Item'],
          [10, 'x', 1],
          [11, null, 9],
        ]),
      );
      expect(reordered.columnIssues).toMatchObject([
        { severity: 'WARNING', code: 'REFERENCE_NOT_FOUND', column: 'B', header: 'Observações' },
      ]);
      expect(reordered.columns).toContainEqual({ column: 'A', header: XYZ, priceSourceId: xyz.id });
      expect(reordered.rows[1]?.issues).toMatchObject([
        { code: 'REFERENCE_NOT_FOUND', message: 'Linha 3: item não encontrado nesta pesquisa.' },
      ]);
      expect(reordered.summary).toMatchObject({ valid: 1, errors: 1 });

      const allErrors = await previewOk(
        research.id,
        sheet([HEADER, [1, null, null, 'abc', 0], [7, null, null, 10, null]]),
      );
      expect(allErrors.summary).toMatchObject({ valid: 0, errors: 3 });
    });

    it('FA-01: não .xlsx, corrompido ou acima de uploads.maxFileSizeMb → 415/413 sem token de prévia', async () => {
      const { research } = await background();
      const before = importKeys().length;
      const csv = await preview(research.id, Buffer.from('Item;Painel\n1;10'), {
        fileName: 'cotacoes.csv',
        contentType: 'text/csv',
      });
      expect(expectProblem(csv, 415, 'FILE_TYPE_NOT_ALLOWED').detail).toBe(
        'Envie um arquivo .xlsx.',
      );
      expectProblem(
        await preview(research.id, Buffer.from('não é planilha')),
        415,
        'FILE_TYPE_NOT_ALLOWED',
      );
      expectProblem(
        await preview(research.id, FULL, { contentType: 'image/png' }),
        415,
        'FILE_TYPE_NOT_ALLOWED',
      );
      tenantSettingsOf(api).seed(A, 'uploads.maxFileSizeMb', 1);
      try {
        const big = await preview(research.id, Buffer.alloc(1024 * 1024 + 1, 1));
        expect(expectProblem(big, 413, 'FILE_TOO_LARGE').detail).toBe(
          'O arquivo excede o tamanho máximo permitido.',
        );
      } finally {
        tenantSettingsOf(api).seed(A, 'uploads.maxFileSizeMb', 50);
      }
      expect(importKeys()).toHaveLength(before);
    });

    it('RN-PRICE-36: sem a coluna Item, sem coluna de fonte ou sem arquivo → 422 em file; JSON → 415', async () => {
      const { research } = await background();
      const noItem = await preview(research.id, sheet([[PAINEL], [10]]));
      expectProblem(noItem, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(noItem)).toEqual([['file', 'REQUIRED']]);
      const noSource = await preview(
        research.id,
        sheet([
          ['Item', 'Outra fonte'],
          [1, 10],
        ]),
      );
      expect(fieldErrors(noSource)).toEqual([['file', 'REFERENCE_NOT_FOUND']]);
      const noFile = await auth(
        request(api.server).post(`/api/v1/price-research/${research.id}/import-preview`),
      ).field('note', 'x');
      expectProblem(noFile, 422, 'VALIDATION_ERROR');
      expectProblem(
        await auth(
          request(api.server).post(`/api/v1/price-research/${research.id}/import-preview`),
        ).send({ file: 'x' }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
    });

    it('Corpo da aplicação inválido → 422 em previewToken; token desconhecido → 404', async () => {
      const { research } = await background();
      const invalid = await apply(research.id, 'abc');
      expectProblem(invalid, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(invalid)).toEqual([['previewToken', expect.any(String)]]);
      expectProblem(await apply(research.id, newId()), 404, 'NOT_FOUND');
    });

    it('FA-06: pesquisa fora de DRAFT/RETURNED → 409 DOCUMENT_NOT_EDITABLE no modelo, na prévia e na aplicação', async () => {
      const { research } = await background();
      const result = await previewOk(research.id, FULL);
      const document = documentRepositoryOf(api)
        .allDocuments()
        .find((candidate) => candidate.id === research.documentId);
      if (!document) throw new Error('documento ausente');
      documentRepositoryOf(api).seed({ ...document, status: 'IN_REVIEW' });
      const problem = expectProblem(
        await apply(research.id, result.previewToken),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(problem.detail).toBe('Esta pesquisa de preços não pode mais ser editada.');
      expectProblem(await preview(research.id, FULL), 409, 'DOCUMENT_NOT_EDITABLE');
      expectProblem(await template(research.id), 409, 'DOCUMENT_NOT_EDITABLE');
      expect(quotationsOf(research.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário só com PROCESS_VIEW: 403 PERMISSION_DENIED com access.denied em PRS-18, PRS-19 e PRS-24', async () => {
      const { process, research } = await background();
      const response = await preview(research.id, FULL, { subject: EVA });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PRICE_RESEARCH_UPDATE',
      });
      const result = await previewOk(research.id, FULL);
      expectProblem(
        await apply(research.id, result.previewToken, { subject: EVA }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await template(research.id, EVA), 403, 'PERMISSION_DENIED');
      expect(quotationsOf(research.id)).toEqual([]);
      expect(auditOf(process.id, 'price_research.import')).toEqual([]);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Token de outra pesquisa ou usado em outro tenant: 404 NOT_FOUND e nenhuma cotação alterada', async () => {
      const first = await background();
      const second = await background();
      const result = await previewOk(first.research.id, FULL);
      // Token "T1" emitido para a pesquisa do primeiro processo, aplicado na de outro processo.
      expectProblem(await apply(second.research.id, result.previewToken), 404, 'NOT_FOUND');
      // Fábio também tem vínculo na Prefeitura B, onde a pesquisa (e o token) não existem.
      expectProblem(
        await apply(first.research.id, result.previewToken, { tenant: B }),
        404,
        'NOT_FOUND',
      );
      expectProblem(await preview(first.research.id, FULL, { tenant: B }), 404, 'NOT_FOUND');
      expectProblem(await template(first.research.id, DIEGO, B), 404, 'NOT_FOUND');
      expect(quotationsOf(first.research.id)).toEqual([]);
      expect(quotationsOf(second.research.id)).toEqual([]);
      // O token continua valendo na pesquisa certa.
      expect((await apply(first.research.id, result.previewToken)).status).toBe(200);
    });
  });

  describe('[Duplicidade]', () => {
    it('Mesma Idempotency-Key "K1": 200 com Idempotent-Replayed: true, sem duplicar nem recalcular de novo; outra chave → 410 (token consumido)', async () => {
      const { process, research } = await background();
      const result = await previewOk(research.id, FULL);
      const key = randomUUID();
      const first = await apply(research.id, result.previewToken, { key });
      expect(first.status).toBe(200);
      const events = eventsOf(process.id, 'PriceResearchRecalculated').length;
      const replay = await apply(research.id, result.previewToken, { key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data(replay)).toEqual(data(first));
      expect(quotationsOf(research.id)).toHaveLength(6);
      expect(quotationsOf(research.id).every((quotation) => quotation.version === 1)).toBe(true);
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(events);
      expect(auditOf(process.id, 'price_research.import')).toHaveLength(1);
      expectProblem(await apply(research.id, result.previewToken), 410, 'IMPORT_PREVIEW_EXPIRED');
    });
  });

  describe('[Concorrência]', () => {
    it('Edição manual do item 1 na fonte Painel entre a prévia e a aplicação: vale o último valor aplicado, sem erro, com um único recálculo', async () => {
      const { process, research, items, painel } = await background();
      const [first] = items;
      if (!first) throw new Error('item ausente');
      const result = await previewOk(research.id, FULL);
      const grid = await auth(
        request(api.server).put(`/api/v1/price-sources/${painel.id}/quotations`),
      )
        .set('If-Match', '"1"')
        .send({ items: [{ priceItemId: first.id, unitPrice: '155.00' }] });
      expect(grid.status).toBe(200);
      const manual = z.array(quotationSchema).parse(data(grid))[0];
      expect(manual?.unitPrice).toBe('155.0000');
      const before = eventsOf(process.id, 'PriceResearchRecalculated').length;

      const response = await apply(research.id, result.previewToken);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(quotationImportResultSchema.parse(data(response))).toEqual({
        appliedCount: 6,
        skippedCount: 0,
      });
      expect(priceOf(research.id, first.id, painel.id)).toBe('150.0000');
      expect(
        quotationsOf(research.id).find((quotation) => quotation.id === manual?.id)?.version,
      ).toBe(2);
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(before + 1);
    });

    it('Cotação desconsiderada depois da prévia: a célula é ignorada (skipped) e a cotação continua EXCLUDED', async () => {
      const { research, items, painel } = await background();
      const [first] = items;
      if (!first) throw new Error('item ausente');
      const grid = await auth(
        request(api.server).put(`/api/v1/price-sources/${painel.id}/quotations`),
      )
        .set('If-Match', '"1"')
        .send({ items: [{ priceItemId: first.id, unitPrice: '100.00' }] });
      const quotation = z.array(quotationSchema).parse(data(grid))[0];
      const result = await previewOk(research.id, FULL);
      const excluded = await auth(
        request(api.server).post(`/api/v1/quotations/${quotation?.id ?? ''}/exclude`),
      )
        .set('If-Match', '"1"')
        .send({
          exclusionReason: 'INCONSISTENT',
          exclusionJustification: 'Preço muito acima das demais cotações do mesmo item',
        });
      expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
      const response = await apply(research.id, result.previewToken);
      expect(quotationImportResultSchema.parse(data(response))).toEqual({
        appliedCount: 5,
        skippedCount: 1,
      });
      expect(
        quotationsOf(research.id).find((candidate) => candidate.id === quotation?.id),
      ).toMatchObject({ status: 'EXCLUDED', unitPrice: '100.0000' });
      // Na prévia seguinte, a célula sobre a cotação desconsiderada vira aviso (RN-PRICE-39).
      const next = await previewOk(research.id, FULL);
      expect(next.summary).toMatchObject({ valid: 5, warnings: 1 });
      expect(next.rows[0]?.issues).toMatchObject([
        { severity: 'WARNING', code: 'QUOTATION_EXCLUDED' },
      ]);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao aplicar: 503 DEPENDENCY_UNAVAILABLE e nenhuma cotação persistida; o token continua valendo', async () => {
      const { process, research } = await background();
      const result = await previewOk(research.id, FULL);
      transactions.down = true;
      expectProblem(await apply(research.id, result.previewToken), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(quotationsOf(research.id)).toEqual([]);
      expect(auditOf(process.id, 'price_research.import')).toEqual([]);
      expect((await apply(research.id, result.previewToken)).status).toBe(200);
      expect(quotationsOf(research.id)).toHaveLength(6);
    });
  });

  describe('[Falha de integração]', () => {
    it('Token de prévia emitido há 20 minutos: 410 IMPORT_PREVIEW_EXPIRED e nenhuma cotação alterada', async () => {
      const { research } = await background();
      const warned = vi.spyOn(Logger.prototype, 'warn');
      const result: QuotationImportPreview = await previewOk(research.id, FULL);
      now = new Date(NOW.getTime() + 20 * 60 * 1000);
      const problem = expectProblem(
        await apply(research.id, result.previewToken),
        410,
        'IMPORT_PREVIEW_EXPIRED',
      );
      expect(problem.detail).toBe('A prévia expirou. Envie a planilha novamente.');
      expect(quotationsOf(research.id)).toEqual([]);
      expect(JSON.stringify(warned.mock.calls)).toContain('price_research.import_token_expired');
      // Aos 14 minutos ainda vale.
      const fresh = await previewOk(research.id, FULL);
      now = new Date(now.getTime() + 14 * 60 * 1000);
      expect((await apply(research.id, fresh.previewToken)).status).toBe(200);
    });
  });
});

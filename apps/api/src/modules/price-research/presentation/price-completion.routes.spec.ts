import { randomUUID } from 'node:crypto';

import {
  completedPriceResearchSchema,
  PRICE_SUMMARY_COLLECTIONS,
  priceItemSchema,
  priceResearchMetaSchema,
  priceResearchSchema,
  priceSourceSchema,
  problemDetailsSchema,
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
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { documentRepositoryOf } from '../../../../test/support/document-fixtures.js';
import { buildSupplier, seedSuppliers } from '../../../../test/support/price-source-fixtures.js';
import type { Supplier } from '../../../../test/support/price-source-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processItemRepositoryOf,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  setProcessItemReferenceQuantity,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedCustomRole,
} from '../../../../test/support/structure-fixtures.js';
import { PRICE_RESEARCH_CLOCK, PRICE_RESEARCH_TRANSACTIONS } from '../application/ports.js';
import type { PriceResearchTransactions } from '../application/ports.js';

/*
 * US-032 — Concluir a pesquisa de preços (PRS-23 · PRS-07 com a justificativa), pelo pipeline HTTP
 * completo (autenticação, tenant, vínculo, autorização, `If-Match`, idempotência, filtro RFC 9457)
 * com a identidade fake e os seeders reais. Background: processo com 2 itens na etapa
 * PESQUISA_PRECOS e a pesquisa em DRAFT com três fontes — "Item 1" a 100,00 × 50 (5.000,00) e
 * "Item 2" a 40,00 × 100 (4.000,00) — e as seções narrativas preenchidas. Fábio (COMPRAS,
 * responsável) é o "Marcos"; Otávio (perfil só com PRICE_RESEARCH_UPDATE, colaborador) é o "Bruno".
 * Atomicidade com falha induzida, RLS e outbox PENDING no PostgreSQL:
 * `test/tenant-leak/price-completion.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-06T15:00:00.000Z');
const TODAY = '2026-10-06';
const MARCOS = 'sub-fabio';
const BRUNO = 'sub-otavio';
const JUSTIFICATION = 'Mercado restrito na região.'; // 27 caracteres

const UNITS_A = {
  organizationId: '0192d032-0000-7000-8000-0000000000a0',
  obras: '0192d032-0000-7000-8000-0000000000a1',
  manutencao: '0192d032-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d032-0000-7000-8000-0000000000a3',
  saude: '0192d032-0000-7000-8000-0000000000a4',
  posto: '0192d032-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d032-0000-7000-8000-0000000000b0',
  obras: '0192d032-0000-7000-8000-0000000000b1',
  manutencao: '0192d032-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d032-0000-7000-8000-0000000000b3',
  saude: '0192d032-0000-7000-8000-0000000000b4',
  posto: '0192d032-0000-7000-8000-0000000000b5',
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

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Concluir a pesquisa de preços (US-032)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let units: { un: string; m3: string };
  let catalog: { contractingType: string; origin: string; direct: string };
  let supplierA: Supplier;
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = MARCOS, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const complete = (
    researchId: string,
    ifMatch: string | null,
    options: { subject?: string; tenant?: string; key?: string | null } = {},
  ) => {
    let call = auth(
      request(api.server).post(`/api/v1/price-research/${researchId}/complete`),
      options.subject,
      options.tenant,
    );
    if (ifMatch !== null) call = call.set('If-Match', ifMatch);
    const key = options.key === undefined ? randomUUID() : options.key;
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send({});
  };
  const patchItem = (itemId: string, body: Record<string, unknown>, ifMatch: string) =>
    auth(request(api.server).patch(`/api/v1/price-items/${itemId}`))
      .set('If-Match', ifMatch)
      .send(body);
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
  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const versionsOf = (documentId: string) => documentRepositoryOf(api).versionsOf(documentId);
  const processItemsOf = (processId: string) =>
    processItemRepositoryOf(api)
      .all()
      .filter((item) => item.processId === processId)
      .sort((a, b) => a.sequence - b.sequence);

  async function researchOf(researchId: string, subject = MARCOS) {
    const response = await auth(
      request(api.server).get(`/api/v1/price-research/${researchId}`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      research: priceResearchSchema.parse(data(response)),
      meta: priceResearchMetaSchema.parse((response.body as { meta: unknown }).meta),
    };
  }
  const etagOf = async (researchId: string) =>
    `"${String((await researchOf(researchId)).research.version)}"`;

  async function itemsOf(researchId: string) {
    const response = await auth(
      request(api.server).get(`/api/v1/price-research/${researchId}/items`),
    );
    return z.array(priceItemSchema).parse(data(response));
  }

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

  async function sourceOk(researchId: string) {
    const response = await auth(
      request(api.server).post(`/api/v1/price-research/${researchId}/sources`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        sourceTypeId: catalog.direct,
        description: `Orçamento ${words(1)}`,
        supplierId: supplierA.id,
        quoteDate: '2026-09-30',
        supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return priceSourceSchema.parse(data(response));
  }

  async function gridOk(sourceId: string, lines: readonly Record<string, unknown>[]) {
    const response = await auth(
      request(api.server).put(`/api/v1/price-sources/${sourceId}/quotations`),
    )
      .set('If-Match', '"1"')
      .send({ items: lines });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  /** Seções narrativas obrigatórias do template padrão (METHODOLOGY e CONCLUSION) por DOC-05. */
  async function fillNarrative(documentId: string) {
    for (const key of ['METHODOLOGY', 'CONCLUSION']) {
      const revision = documentOf(documentId).draftContent.sections[key]?.revision ?? 0;
      const response = await auth(
        request(api.server).put(`/api/v1/documents/${documentId}/sections/${key}`),
      )
        .set('If-Match', `"s${String(revision)}"`)
        .send({
          content: paragraph(`Texto da seção ${key} da pesquisa de preços da contratação.`),
          notApplicable: false,
          justification: null,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
  }

  /**
   * Background: "Item 1" (50 un) e "Item 2" (100 m³) com três fontes; `item2Quotes` = quantas fontes
   * cotam o Item 2 (3 = completo; 1 = abaixo do mínimo; 0 = sem cotação válida).
   */
  async function background(item2Quotes = 3, narrative = true) {
    const created = await newProcess();
    await itemOk(created.id, 'Cimento CP II 50 kg', units.un, '50');
    await itemOk(created.id, 'Areia média', units.m3, '100');
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
    const [first, second] = await itemsOf(research.id);
    if (!first || !second) throw new Error('itens ausentes');
    for (let index = 0; index < 3; index += 1) {
      const source = await sourceOk(research.id);
      await gridOk(source.id, [
        { priceItemId: first.id, unitPrice: '100.00' },
        ...(index < item2Quotes ? [{ priceItemId: second.id, unitPrice: '40.00' }] : []),
      ]);
    }
    if (narrative) await fillNarrative(research.documentId);
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.otavio.id,
      role: 'COLLABORATOR',
      expiresAt: new Date('2026-12-31T23:59:59Z'),
    });
    return { process, research, first, second };
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
    // "Bruno": edita a pesquisa, mas não a conclui.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedCustomRole(api, A, 'Editor da pesquisa', [
        'PROCESS_VIEW',
        'PRICE_RESEARCH_UPDATE',
      ]).id,
    });
    units = {
      un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
      m3: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'M3'),
    };
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      direct: catalogItemId(api, A, 'PRICE_SOURCE_TYPE', 'PESQUISA_DIRETA_FORNECEDOR'),
    };
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
  });

  describe('[Sucesso]', () => {
    it('Concluir pesquisa com todos os itens completos: documento FINALIZED, valores propagados, eventos e auditoria', async () => {
      const { process, research, first, second } = await background();
      expect((await researchOf(research.id)).meta.allowedActions).toContain('COMPLETE');
      const ifMatch = await etagOf(research.id);
      const response = await complete(research.id, ifMatch);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const completed = completedPriceResearchSchema.parse(data(response));
      expect(completed).toMatchObject({
        id: research.id,
        status: 'FINALIZED',
        totalEstimatedValue: '9000.00',
        document: { status: 'FINALIZED' },
      });
      expect(completed.document.currentVersionId).not.toBeNull();
      expect(response.headers.etag).toBe(`"${String(completed.version)}"`);
      expect(
        priceResearchMetaSchema.parse((response.body as { meta: unknown }).meta),
      ).toMatchObject({ allowedActions: [], lockReason: 'DOCUMENT_NOT_EDITABLE' });

      // Documento finalizado, com a versão FINALIZATION.
      const document = documentOf(research.documentId);
      expect(document).toMatchObject({ status: 'FINALIZED', finalizedById: FAKE_USERS.fabio.id });
      const versions = versionsOf(research.documentId);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        id: completed.document.currentVersionId,
        reason: 'FINALIZATION',
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      });

      // RN-PRICE-60/61/62: cabeçalho concluído, itens e valor estimado do processo.
      const header = (await researchOf(research.id)).research;
      expect(header.completedAt).toBe(document.finalizedAt?.toISOString());
      expect(completed.completedAt).toBe(header.completedAt);
      const items = processItemsOf(process.id);
      expect(items.map((item) => item.referenceUnitPrice)).toEqual(['100.0000', '40.0000']);
      expect(items.every((item) => item.referenceUnitPriceSourceDocumentId === research.id)).toBe(
        true,
      );
      expect(currentOf(process)).toMatchObject({
        estimatedValue: '9000.00',
        estimatedValueSource: 'PRICE_RESEARCH',
      });
      expect(currentOf(process).version).toBeGreaterThan(process.version);

      // Eventos: DocumentVersionCreated e PriceResearchCompleted (DocumentFinalized).
      const finalized = eventsOf(process.id, 'DocumentFinalized');
      expect(finalized).toHaveLength(1);
      expect(finalized[0]).toMatchObject({
        routingKey: 'document.finalized.price_research',
        payload: {
          documentId: research.documentId,
          documentTypeCode: 'PRICE_RESEARCH',
          documentVersionId: completed.document.currentVersionId,
          typedSummary: {
            totalEstimatedValueMasked: false,
            itemsCount: 2,
            itemsWithAlertsCount: 0,
          },
        },
      });
      expect(eventsOf(process.id, 'DocumentVersionCreated').at(-1)).toMatchObject({
        routingKey: 'document.version_created.price_research',
        payload: { reason: 'FINALIZATION', contentHash: versions[0]?.contentHash },
      });
      expect(JSON.stringify(finalized)).not.toContain('9000');

      // Auditoria: price_research.complete (valor anterior/novo) + document.finalize.
      const audits = auditOf(process.id, 'price_research.complete');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        entityType: 'PriceResearch',
        entityId: research.id,
        changes: [
          { path: 'estimatedValue', old: null, new: '9000.00' },
          { path: 'estimatedValueSource', old: null, new: 'PRICE_RESEARCH' },
        ],
        metadata: {
          documentVersionId: completed.document.currentVersionId,
          itemsCount: 2,
          itemsWithAlertsCount: 0,
          processItemsUpdated: 2,
          estimatedValueApplied: true,
        },
      });
      expect(auditOf(process.id, 'document.finalize')).toHaveLength(1);

      // Bloqueia novas edições (POL-02 → 409 DOCUMENT_NOT_EDITABLE).
      const edit = await patchItem(first.id, { quantity: '60' }, `"${String(first.version)}"`);
      expectProblem(edit, 409, 'DOCUMENT_NOT_EDITABLE');
      expect(second.id).toBeDefined();
    });

    it('FA-02: item abaixo do mínimo com justificativa conclui e a justificativa consta na versão', async () => {
      const { research, second } = await background(1);
      const [, item2] = await itemsOf(research.id);
      expect(item2).toMatchObject({
        validQuotationsCount: 1,
        alerts: [{ code: 'BELOW_MINIMUM_QUOTES' }],
      });
      const justified = await patchItem(
        second.id,
        { belowMinimumJustification: `  ${JUSTIFICATION}  ` },
        `"${String(item2?.version)}"`,
      );
      expect(justified.status, JSON.stringify(justified.body)).toBe(200);
      expect(priceItemSchema.parse(data(justified)).belowMinimumJustification).toBe(JUSTIFICATION);

      const response = await complete(research.id, await etagOf(research.id));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [version] = versionsOf(research.documentId);
      const rows = version?.content?.collections[PRICE_SUMMARY_COLLECTIONS.items] as
        readonly Record<string, unknown>[] | undefined;
      expect(rows?.find((row) => row.id === second.id)).toMatchObject({
        belowMinimumJustification: JUSTIFICATION,
        validQuotationsCount: 1,
      });
      // A justificativa nunca vai para a auditoria nem para os eventos.
      expect(JSON.stringify(api.auditRecords())).not.toContain(JUSTIFICATION);
      expect(JSON.stringify(api.outboxRows())).not.toContain(JUSTIFICATION);
    });

    it('FA-03: alertas (HIGH_CV) não bloqueiam e entram no typedSummary e na auditoria', async () => {
      const { process, research, first } = await background();
      const source = await sourceOk(research.id);
      await gridOk(source.id, [{ priceItemId: first.id, unitPrice: '300.00' }]);
      const header = (await researchOf(research.id)).research;
      expect(header.itemsWithAlertsCount).toBeGreaterThan(0);
      const response = await complete(research.id, await etagOf(research.id));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id, 'DocumentFinalized')[0]?.payload).toMatchObject({
        typedSummary: { itemsWithAlertsCount: header.itemsWithAlertsCount },
      });
      expect(auditOf(process.id, 'price_research.complete')[0]?.metadata).toMatchObject({
        itemsWithAlertsCount: header.itemsWithAlertsCount,
      });
    });

    it('MANUAL: o preço manual vira o preço de referência do item', async () => {
      const { process, research, first } = await background();
      const [item1] = await itemsOf(research.id);
      const manual = await patchItem(
        first.id,
        {
          methodOverride: 'MANUAL',
          manualUnitPrice: '95.50',
          manualJustification: 'Valor de ata vigente do consórcio regional de saúde',
        },
        `"${String(item1?.version)}"`,
      );
      expect(manual.status, JSON.stringify(manual.body)).toBe(200);
      const response = await complete(research.id, await etagOf(research.id));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(processItemsOf(process.id).map((item) => item.referenceUnitPrice)).toEqual([
        '95.5000',
        '40.0000',
      ]);
      expect(currentOf(process).estimatedValue).toBe('8775.00');
    });

    it('DEC-032: valor de TR aprovado tem precedência — itens atualizados, valor do processo mantido', async () => {
      const { process, research } = await background();
      moveTo(process, { estimatedValue: '12000.00', estimatedValueSource: 'TERM' });
      const response = await complete(research.id, await etagOf(research.id));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(currentOf(process)).toMatchObject({
        estimatedValue: '12000.00',
        estimatedValueSource: 'TERM',
      });
      expect(processItemsOf(process.id).map((item) => item.referenceUnitPrice)).toEqual([
        '100.0000',
        '40.0000',
      ]);
      expect(auditOf(process.id, 'price_research.complete')[0]).toMatchObject({
        changes: null,
        metadata: { estimatedValueApplied: false, estimatedValueSource: 'TERM' },
      });
    });

    it('POL-09: em processo sigiloso a auditoria guarda hash + máscara e o evento marca o sigilo', async () => {
      const { process, research } = await background();
      moveTo(process, { isBudgetConfidential: true });
      const response = await complete(research.id, await etagOf(research.id));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [audit] = auditOf(process.id, 'price_research.complete');
      expect(audit?.changes?.[0]).toMatchObject({
        path: 'estimatedValue',
        old: null,
        new: { masked: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string },
      });
      expect(JSON.stringify(audit)).not.toContain('9000');
      expect(eventsOf(process.id, 'DocumentFinalized')[0]?.payload).toMatchObject({
        typedSummary: { totalEstimatedValueMasked: true },
      });
    });

    it('DOC-10 sobre a pesquisa dá no mesmo: completude da pesquisa e propagação na mesma transação', async () => {
      const { process, research } = await background(0);
      const document = documentOf(research.documentId);
      const blocked = await auth(
        request(api.server).post(`/api/v1/documents/${research.documentId}/finalize`),
      )
        .set('If-Match', `"${String(document.version)}"`)
        .set('Idempotency-Key', randomUUID())
        .send({ acknowledgedWarnings: [] });
      const problem = expectProblem(blocked, 422, 'DOCUMENT_INCOMPLETE');
      expect(problem.violations.map((violation) => violation.code)).toContain(
        'PRICE_ITEM_WITHOUT_PRICE',
      );
      expect(currentOf(process).estimatedValueSource).toBeNull();
    });
  });

  describe('[Validação]', () => {
    it('Item sem nenhuma cotação válida bloqueia: 422 PRICE_RESEARCH_INCOMPLETE e o documento fica em DRAFT', async () => {
      const { process, research, second } = await background(0);
      const response = await complete(research.id, await etagOf(research.id));
      const problem = expectProblem(response, 422, 'PRICE_RESEARCH_INCOMPLETE');
      expect(problem.violations).toEqual([
        {
          code: 'PRICE_ITEM_WITHOUT_PRICE',
          severity: 'BLOCKING',
          message: 'O item "Item 2" não tem preço calculado. Registre cotações ou um valor manual.',
          ruleId: 'RN-PRICE-58',
          sectionKey: null,
          field: null,
          itemId: second.id,
          params: { sequence: 2, processItemId: second.processItemId },
        },
      ]);
      expect(documentOf(research.documentId).status).toBe('DRAFT');
      expect(versionsOf(research.documentId)).toEqual([]);
      expect(processItemsOf(process.id).every((item) => item.referenceUnitPrice === null)).toBe(
        true,
      );
      expect(eventsOf(process.id, 'DocumentFinalized')).toEqual([]);
      expect(auditOf(process.id, 'price_research.complete')).toEqual([]);
    });

    it('Item abaixo do mínimo sem justificativa bloqueia: PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED', async () => {
      const { research, second } = await background(1);
      const response = await complete(research.id, await etagOf(research.id));
      const problem = expectProblem(response, 422, 'PRICE_RESEARCH_INCOMPLETE');
      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED',
          itemId: second.id,
          field: 'belowMinimumJustification',
          message:
            'O item "Item 2" tem menos cotações que o mínimo exigido. Informe a justificativa.',
        }),
      ]);
      expect(documentOf(research.documentId).status).toBe('DRAFT');
    });

    it('Valor manual sem cotação válida continua bloqueando (RN-PRICE-58)', async () => {
      const { research, second } = await background(0);
      const [, item2] = await itemsOf(research.id);
      const manual = await patchItem(
        second.id,
        {
          methodOverride: 'MANUAL',
          manualUnitPrice: '41.00',
          manualJustification: 'Valor de ata vigente do consórcio regional de saúde',
          belowMinimumJustification: JUSTIFICATION,
        },
        `"${String(item2?.version)}"`,
      );
      expect(manual.status, JSON.stringify(manual.body)).toBe(200);
      const problem = expectProblem(
        await complete(research.id, await etagOf(research.id)),
        422,
        'PRICE_RESEARCH_INCOMPLETE',
      );
      expect(problem.violations[0]).toMatchObject({
        code: 'PRICE_ITEM_WITHOUT_PRICE',
        message: 'O item "Item 2" não tem cotação válida. Registre ao menos uma cotação válida.',
      });
    });

    it('PRS-07: justificativa curta → 422 TOO_SHORT; vazia apaga', async () => {
      const { research, second } = await background(1);
      const [, item2] = await itemsOf(research.id);
      const short = await patchItem(
        second.id,
        { belowMinimumJustification: 'curta' },
        `"${String(item2?.version)}"`,
      );
      expectProblem(short, 422, 'VALIDATION_ERROR');
      expect(problemDetailsSchema.parse(short.body).errors).toEqual([
        expect.objectContaining({ field: 'belowMinimumJustification', code: 'TOO_SHORT' }),
      ]);
      const saved = await patchItem(
        second.id,
        { belowMinimumJustification: JUSTIFICATION },
        `"${String(item2?.version)}"`,
      );
      expect(saved.status).toBe(200);
      const cleared = await patchItem(
        second.id,
        { belowMinimumJustification: '' },
        saved.headers.etag ?? '',
      );
      expect(priceItemSchema.parse(data(cleared)).belowMinimumJustification).toBeNull();
    });

    it('V-04: If-Match ausente → 428 PRECONDITION_REQUIRED', async () => {
      const { research } = await background();
      expectProblem(await complete(research.id, null), 428, 'PRECONDITION_REQUIRED');
      expect(documentOf(research.documentId).status).toBe('DRAFT');
    });

    it('V-03: pesquisa já concluída → 409 DOCUMENT_NOT_EDITABLE', async () => {
      const { research } = await background();
      expect((await complete(research.id, await etagOf(research.id))).status).toBe(200);
      const again = await complete(research.id, await etagOf(research.id));
      const problem = expectProblem(again, 409, 'DOCUMENT_NOT_EDITABLE');
      expect(problem.detail).toBe(
        'Esta pesquisa já foi concluída ou não pode ser concluída agora.',
      );
    });

    it('Seções obrigatórias vazias → 422 DOCUMENT_INCOMPLETE sem alterar nada', async () => {
      const created = await background(3, false);
      const response = await complete(created.research.id, await etagOf(created.research.id));
      expectProblem(response, 422, 'DOCUMENT_INCOMPLETE');
      expect(documentOf(created.research.documentId).status).toBe('DRAFT');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário só com PRICE_RESEARCH_UPDATE: 403 PERMISSION_DENIED com access.denied e nada muda', async () => {
      const { process, research } = await background();
      expect((await researchOf(research.id, BRUNO)).meta.allowedActions).not.toContain('COMPLETE');
      const response = await complete(research.id, await etagOf(research.id), { subject: BRUNO });
      const problem = expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(problem.detail).toBe('Você não tem permissão para concluir esta pesquisa.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PRICE_RESEARCH_COMPLETE',
      });
      expect(documentOf(research.documentId).status).toBe('DRAFT');
      expect(auditOf(process.id, 'price_research.complete')).toEqual([]);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Pesquisa de outro tenant: 404 PRICE_RESEARCH_NOT_FOUND sem ler nem alterar', async () => {
      const { process, research } = await background();
      // Fábio também tem vínculo na Prefeitura B (CONSULTOR_EXTERNO), onde a pesquisa não existe.
      const response = await complete(research.id, '"1"', { tenant: B });
      expectProblem(response, 404, 'PRICE_RESEARCH_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(research.documentId.slice(0, 8) + 'x');
      expect(documentOf(research.documentId).status).toBe('DRAFT');
      expect(eventsOf(process.id, 'DocumentFinalized')).toEqual([]);
      expectProblem(await complete(newId(), '"1"'), 404, 'PRICE_RESEARCH_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave de idempotência: 200 com Idempotent-Replayed e uma única versão', async () => {
      const { process, research } = await background();
      const ifMatch = await etagOf(research.id);
      const k1 = randomUUID();
      const first = await complete(research.id, ifMatch, { key: k1 });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await complete(research.id, ifMatch, { key: k1 });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(versionsOf(research.documentId)).toHaveLength(1);
      expect(eventsOf(process.id, 'DocumentFinalized')).toHaveLength(1);
      expect(auditOf(process.id, 'price_research.complete')).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('If-Match divergente após outra pessoa alterar uma cotação: 412 VERSION_CONFLICT com currentVersion', async () => {
      const { process, research, first } = await background();
      const stale = await etagOf(research.id);
      const source = await sourceOk(research.id);
      await gridOk(source.id, [{ priceItemId: first.id, unitPrice: '101.00' }]);
      const current = (await researchOf(research.id)).research.version;
      const response = await complete(research.id, stale);
      const problem = expectProblem(response, 412, 'VERSION_CONFLICT');
      expect(problem).toMatchObject({ currentVersion: current });
      expect(documentOf(research.documentId).status).toBe('DRAFT');
      expect(processItemsOf(process.id).every((item) => item.referenceUnitPrice === null)).toBe(
        true,
      );
    });

    it('Duas conclusões simultâneas com chaves diferentes: uma 200 e a outra 412', async () => {
      const { process, research } = await background();
      const ifMatch = await etagOf(research.id);
      const pair = await Promise.all([
        complete(research.id, ifMatch),
        complete(research.id, ifMatch),
      ]);
      expect(pair.map((response) => response.status).sort()).toEqual([200, 412]);
      expect(versionsOf(research.documentId)).toHaveLength(1);
      expect(auditOf(process.id, 'price_research.complete')).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE e nada muda nem é publicado', async () => {
      const { process, research } = await background();
      const ifMatch = await etagOf(research.id);
      transactions.down = true;
      const response = await complete(research.id, ifMatch);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(documentOf(research.documentId).status).toBe('DRAFT');
      expect(currentOf(process).estimatedValueSource).toBeNull();
      expect(processItemsOf(process.id).every((item) => item.referenceUnitPrice === null)).toBe(
        true,
      );
      expect(eventsOf(process.id, 'DocumentFinalized')).toEqual([]);
      expect(eventsOf(process.id, 'DocumentVersionCreated')).toEqual([]);
      // Depois que o banco volta, a mesma conclusão segue normalmente.
      expect((await complete(research.id, ifMatch)).status).toBe(200);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: conclusão 200 e os eventos ficam gravados no outbox (sem publicação síncrona)', async () => {
      const { process, research } = await background();
      const response = await complete(research.id, await etagOf(research.id));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // O outbox em memória não tem relay: as linhas gravadas na transação esperam a publicação.
      expect(eventsOf(process.id, 'DocumentFinalized')).toHaveLength(1);
      expect(eventsOf(process.id, 'DocumentVersionCreated')).toHaveLength(1);
    });
  });
});

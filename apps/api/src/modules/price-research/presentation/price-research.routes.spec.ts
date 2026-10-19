import { randomUUID } from 'node:crypto';

import {
  priceItemSchema,
  priceResearchMetaSchema,
  priceResearchSchema,
  priceResearchSummarySchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  PriceItemDto,
  PriceResearchDto,
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
  buildDocument,
  documentItemRepositoryOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  numberSequencesOf,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  setProcessItemReferenceQuantity,
  tenantSettingsOf,
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { PRICE_RESEARCH_CLOCK, PRICE_RESEARCH_TRANSACTIONS } from '../application/ports.js';
import type { PriceResearchTransactions } from '../application/ports.js';
import { InMemoryPriceResearchRepository } from '../infrastructure/price-research.repositories.js';

/*
 * US-024 — Criar pesquisa de preços a partir dos itens do processo, pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com
 * a identidade fake, os seeders reais (catálogo, perfis, tipos de documento, biblioteca de templates
 * e o workflow padrão) e o processo do PRC-02 levado à etapa PESQUISA_PRECOS. As 8 categorias do
 * Gherkin: PRS-01..06/08. Fábio (COMPRAS) é o "Rui"; Ana (REQUISITANTE) é a "Ana"; Lúcia
 * (GESTOR_CONTRATACOES) fica sem custódia; Otávio (ADMIN_ORGAO — sem PRICE_RESEARCH_*
 * nem POL-09) é o consultor participante e o leitor do processo sigiloso. Atomicidade com numeração, índice único
 * sob concorrência, RLS e FKs compostas no PostgreSQL: `test/tenant-leak/price-research.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-06T15:00:00.000Z');
const TODAY = '2026-10-06';
const SEQUENCE = (year = 2026) => `DOCUMENT:PRICE_RESEARCH:*:${String(year)}`;
const RUI = 'sub-fabio';

const UNITS_A = {
  organizationId: '0192d024-0000-7000-8000-0000000000a0',
  obras: '0192d024-0000-7000-8000-0000000000a1',
  manutencao: '0192d024-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d024-0000-7000-8000-0000000000a3',
  saude: '0192d024-0000-7000-8000-0000000000a4',
  posto: '0192d024-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d024-0000-7000-8000-0000000000b0',
  obras: '0192d024-0000-7000-8000-0000000000b1',
  manutencao: '0192d024-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d024-0000-7000-8000-0000000000b3',
  saude: '0192d024-0000-7000-8000-0000000000b4',
  posto: '0192d024-0000-7000-8000-0000000000b5',
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

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Criar pesquisa de preços a partir dos itens do processo (US-024)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let units: { sc: string; m3: string };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = RUI, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const createResearch = (
    processId: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/price-research`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const listResearch = (processId: string, subject = RUI, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/price-research`), subject, tenant);
  const getResearch = (id: string, subject = RUI, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/price-research/${id}`), subject, tenant);
  const patchResearch = (
    id: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    subject = RUI,
  ) => {
    const call = auth(request(api.server).patch(`/api/v1/price-research/${id}`), subject);
    return (ifMatch === null ? call : call.set('If-Match', ifMatch)).send(body);
  };
  const listItems = (id: string, query = '', subject = RUI, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/price-research/${id}/items${query}`), subject, tenant);
  const addItems = (id: string, items: readonly Record<string, unknown>[], subject = RUI) =>
    auth(request(api.server).post(`/api/v1/price-research/${id}/items`), subject).send({ items });
  const removeItem = (itemId: string, ifMatch: string | null, subject = RUI) => {
    const call = auth(request(api.server).delete(`/api/v1/price-items/${itemId}`), subject);
    return ifMatch === null ? call : call.set('If-Match', ifMatch);
  };
  const addProcessItem = (processId: string, body: Record<string, unknown>) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/items`), 'sub-ana')
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', ...body });

  const store = () => api.app.get(InMemoryPriceResearchRepository, { strict: false });
  const researchesOf = (processId: string) =>
    store()
      .snapshot()
      .researches.filter((research) => research.processId === processId);
  const priceItemsOf = (researchId: string) =>
    store()
      .snapshot()
      .items.filter((item) => item.priceResearchId === researchId);
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
  const lastNumber = () => numberSequencesOf(api).valueOf(A, SEQUENCE());
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

  /** Processo criado pelo PRC-02 (Ana) e levado à PESQUISA_PRECOS com o Rui responsável. */
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

  function toResearchStage(process: Process): Process {
    return moveTo(process, {
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId(process, 'PESQUISA_PRECOS'),
      currentResponsibleId: FAKE_USERS.fabio.id,
    });
  }

  async function itemOk(processId: string, body: Record<string, unknown>) {
    const { referenceQuantity, ...fields } = body;
    const response = await addProcessItem(processId, fields);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const item = data<ProcessItemDto>(response);
    if (typeof referenceQuantity === 'string') {
      setProcessItemReferenceQuantity(api, item.id, `${referenceQuantity}.0000`);
    }
    return item;
  }

  /** ETP do processo com a quantidade do item (RN-PRICE-04 — fonte depois do processo). */
  function seedEtpQuantity(process: Process, processItemId: string, quantity: string) {
    const etpType = documentTypeRepositoryOf(api)
      .snapshot()
      .find((type) => type.tenantId === A && type.code === 'ETP');
    const etp = buildDocument({
      tenantId: A,
      processId: process.id,
      documentTypeId: etpType?.id ?? newId(),
      code: 'ETP 0001/2026',
      title: 'ETP',
      singletonKey: etpType?.id ?? null,
    });
    documentRepositoryOf(api).seed(etp);
    void documentItemRepositoryOf(api).replace({} as TenantTx, etp.id, [
      {
        id: newId(),
        tenantId: A,
        documentId: etp.id,
        processItemId,
        quantity,
        notes: null,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
        createdById: FAKE_USERS.ana.id,
        updatedById: FAKE_USERS.ana.id,
      },
    ]);
  }

  /** Background: itens 1 cimento (100 SC), 2 areia (12 M3) e 3 brita (sem quantidade; 6 no ETP). */
  async function background() {
    const created = await newProcess();
    const cement = await itemOk(created.id, {
      description: 'Cimento CP II 50 kg',
      unitOfMeasureId: units.sc,
      referenceQuantity: '100',
    });
    const sand = await itemOk(created.id, {
      description: 'Areia média',
      unitOfMeasureId: units.m3,
      referenceQuantity: '12',
    });
    const gravel = await itemOk(created.id, {
      description: 'Brita 1',
      unitOfMeasureId: units.m3,
    });
    const process = toResearchStage(created);
    seedEtpQuantity(process, gravel.id, '6.0000');
    return { process, cement, sand, gravel };
  }

  async function createOk(processId: string, body: Record<string, unknown> = {}) {
    const response = await createResearch(processId, { referenceDate: TODAY, ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return priceResearchSchema.parse(data(response));
  }

  async function itemsOk(researchId: string, subject = RUI) {
    const response = await listItems(researchId, '', subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
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
      'workflow.seedWorkflows',
    ]);
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
    // A última pesquisa do tenant em 2026 é a PP 0002/2026.
    numberSequencesOf(api).seed(A, SEQUENCE(), 2);
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
    it('Criar pesquisa com todos os itens: PP 0003/2026, quantidades 100/12/6, snapshot, alertas, 201 + Location/ETag, auditoria, evento e timeline', async () => {
      const { process, cement, sand, gravel } = await background();
      const response = await createResearch(process.id, { referenceDate: TODAY });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const research = priceResearchSchema.parse(data(response));
      const meta = priceResearchMetaSchema.parse((response.body as { meta: unknown }).meta);
      expect(response.headers.location).toBe(`/api/v1/price-research/${research.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(research).toMatchObject({
        code: 'PP 0003/2026',
        status: 'DRAFT',
        confidentiality: 'INTERNAL',
        processId: process.id,
        documentId: research.id,
        title: `Pesquisa de preços — ${process.code ?? ''}`,
        referenceDate: TODAY,
        parameters: {
          defaultMethod: 'AUTO_CV',
          cvThresholdPercent: '25.0000',
          minQuotations: 3,
          directQuoteMaxAgeDays: 180,
          similarContractMaxAgeDays: 365,
          outlierLowerPercent: '70.0000',
          outlierUpperPercent: '130.0000',
          unitPriceDecimals: 2,
          roundingMode: 'HALF_UP',
        },
        itemsCount: 3,
        itemsWithAlertsCount: 3,
        totalEstimatedValue: null,
        totalEstimatedValueMasked: false,
        completedAt: null,
        pendingApprovalId: null,
        version: 1,
      });
      expect(meta.allowedActions).toEqual(['UPDATE', 'ADD_ITEMS', 'REMOVE_ITEMS']);
      expect(meta.template?.sections.map((section) => section.key)).toEqual(
        expect.arrayContaining(['METHODOLOGY', 'CONCLUSION']),
      );

      const items = await itemsOk(research.id);
      expect(items.map((item) => [item.processItemId, item.sequence, item.quantity])).toEqual([
        [cement.id, 1, '100.0000'],
        [sand.id, 2, '12.0000'],
        [gravel.id, 3, '6.0000'],
      ]);
      for (const item of items) {
        expect(item.alerts.map((alert) => alert.code)).toEqual([
          'NO_VALID_QUOTES',
          'BELOW_MINIMUM_QUOTES',
        ]);
        expect(item).toMatchObject({ quotationsCount: 0, valuesMasked: false, version: 1 });
      }
      expect(items[0]?.unit.allowsDecimal).toBe(false);
      expect(items[0]?.description).toBe('Cimento CP II 50 kg');

      const [document] = documentsOf(process.id).filter((doc) => doc.id === research.id);
      expect(document).toMatchObject({ responsibleId: FAKE_USERS.fabio.id, status: 'DRAFT' });
      expect(Object.keys(document?.draftContent.sections ?? {})).toEqual(
        expect.arrayContaining(['METHODOLOGY', 'CONCLUSION']),
      );
      expect(auditOf(process.id, 'document.create')).toMatchObject([
        {
          entityId: research.id,
          metadata: {
            documentTypeCode: 'PRICE_RESEARCH',
            code: 'PP 0003/2026',
            itemsCount: 3,
            parameters: { minQuotations: 3, cvThresholdPercent: '25.0000' },
          },
        },
      ]);
      expect(eventsOf(process.id, 'DocumentCreated')).toMatchObject([
        {
          routingKey: 'document.created.price_research',
          aggregateId: research.id,
          payload: {
            documentId: research.id,
            documentTypeCode: 'PRICE_RESEARCH',
            kind: 'STRUCTURED',
            code: 'PP 0003/2026',
            templateVersionId: research.templateVersionId,
          },
        },
      ]);
      expect(timelineOf(process.id).map((row) => row.type)).toContain('DOCUMENT_CREATED');
      // A pesquisa nasce sob custódia de quem a criou: nenhuma notificação.
      expect(api.outboxRows().filter((row) => row.eventType.startsWith('Notification'))).toEqual(
        [],
      );

      // PRS-01 e PRS-03.
      const summaries = z
        .array(priceResearchSummarySchema)
        .parse(data(await listResearch(process.id)));
      expect(summaries).toMatchObject([{ id: research.id, code: 'PP 0003/2026', itemsCount: 3 }]);
      const fetched = await getResearch(research.id);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.etag).toBe('"1"');
      expect(priceResearchSchema.parse(data(fetched))).toEqual(research);
    });

    it('Snapshot não muda com a configuração do tenant: minQuotations continua 3 depois de alterado para 5', async () => {
      const { process } = await background();
      const research = await createOk(process.id);
      tenantSettingsOf(api).seed(A, 'priceResearch.minQuotations', 5);
      try {
        expect(
          priceResearchSchema.parse(data(await getResearch(research.id))).parameters,
        ).toMatchObject({ minQuotations: 3 });
        // A data-base alterada recalcula pelos parâmetros do snapshot, não pelos vigentes.
        const changed = await patchResearch(research.id, { referenceDate: '2026-10-01' }, '"1"');
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        expect(priceResearchSchema.parse(data(changed)).parameters.minQuotations).toBe(3);
      } finally {
        tenantSettingsOf(api).seed(A, 'priceResearch.minQuotations', 3);
      }
    });

    it('FA-07: alterar a data-base recalcula (PriceResearchRecalculated sem valores), audita document.draft_update e devolve o novo ETag; título editável', async () => {
      const { process } = await background();
      const research = await createOk(process.id);
      const response = await patchResearch(
        research.id,
        { referenceDate: '2026-10-01', title: 'Pesquisa de preços — materiais' },
        '"1"',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(priceResearchSchema.parse(data(response))).toMatchObject({
        referenceDate: '2026-10-01',
        title: 'Pesquisa de preços — materiais',
        version: 2,
        itemsCount: 3,
      });
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toMatchObject([
        {
          routingKey: 'price_research.recalculated',
          payload: { priceResearchId: research.id, itemsCount: 3, itemsWithAlertsCount: 3 },
        },
      ]);
      const [audit] = auditOf(process.id, 'document.draft_update');
      expect(audit?.changes).toEqual(
        expect.arrayContaining([
          { path: 'referenceDate', old: TODAY, new: '2026-10-01' },
          expect.objectContaining({ path: 'title' }),
        ]),
      );
      // O título nunca vai em claro na auditoria.
      expect(JSON.stringify(audit)).not.toContain('materiais');
    });

    it('FA-04/FA-05: incluir item criado depois (PRS-06) e remover item (PRS-08) com document.items_update e o evento', async () => {
      const created = await newProcess();
      const cement = await itemOk(created.id, {
        description: 'Cimento CP II 50 kg',
        unitOfMeasureId: units.sc,
        referenceQuantity: '100',
      });
      const process = toResearchStage(created);
      const research = await createOk(process.id);
      expect(research.itemsCount).toBe(1);

      moveTo(process, { currentResponsibleId: FAKE_USERS.ana.id });
      const sand = await itemOk(process.id, {
        description: 'Areia média',
        unitOfMeasureId: units.m3,
        referenceQuantity: '12',
      });
      moveTo(process, { currentResponsibleId: FAKE_USERS.fabio.id });

      const added = await addItems(research.id, [{ processItemId: sand.id }]);
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(z.array(priceItemSchema).parse(data(added))).toMatchObject([
        { processItemId: sand.id, quantity: '12.0000', quotationsCount: 0 },
      ]);
      const afterAdd = priceResearchSchema.parse(data(await getResearch(research.id)));
      expect(afterAdd).toMatchObject({ itemsCount: 2, itemsWithAlertsCount: 2, version: 2 });
      expect(auditOf(process.id, 'document.items_update')).toMatchObject([
        {
          changes: [
            { path: 'items.added', new: [{ processItemId: sand.id, quantity: '12.0000' }] },
          ],
        },
      ]);

      const items = await itemsOk(research.id);
      const cementLine = items.find((item) => item.processItemId === cement.id);
      const removed = await removeItem(cementLine?.id ?? '', `"${String(cementLine?.version)}"`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      expect(priceItemsOf(research.id).map((item) => item.processItemId)).toEqual([sand.id]);
      expect(priceResearchSchema.parse(data(await getResearch(research.id)))).toMatchObject({
        itemsCount: 1,
        version: 3,
      });
      expect(auditOf(process.id, 'document.items_update').at(-1)).toMatchObject({
        changes: [{ path: 'items.removed' }],
        metadata: { quotationsRemoved: 0, documentTypeCode: 'PRICE_RESEARCH' },
      });
      expect(eventsOf(process.id, 'PriceResearchRecalculated')).toHaveLength(2);

      // Filtros do PRS-05.
      const withAlerts = await listItems(research.id, '?hasAlerts=true');
      expect(data<PriceItemDto[]>(withAlerts)).toHaveLength(1);
      expect((withAlerts.body as { meta: { totalItems: number } }).meta.totalItems).toBe(1);
      expect(data<PriceItemDto[]>(await listItems(research.id, '?hasAlerts=false'))).toEqual([]);
    });

    it('Item da pesquisa em uso: excluir o item do processo responde 409 ITEM_IN_USE com a pesquisa', async () => {
      const { process, cement } = await background();
      const research = await createOk(process.id);
      moveTo(process, { currentResponsibleId: FAKE_USERS.ana.id });
      const response = await auth(
        request(api.server).delete(`/api/v1/process-items/${cement.id}`),
        'sub-ana',
      ).set('If-Match', '"1"');
      expectProblem(response, 409, 'ITEM_IN_USE');
      expect(JSON.stringify(response.body)).toContain(research.code ?? 'PP');
    });
  });

  describe('[Validação]', () => {
    it('Processo sem itens: 422 BUSINESS_RULE_VIOLATION com PRICE_ITEMS_REQUIRED e nada criado nem numerado', async () => {
      const process = toResearchStage(await newProcess());
      const before = lastNumber();
      const response = await createResearch(process.id, { referenceDate: TODAY });
      const problem = expectProblem(response, 422, 'BUSINESS_RULE_VIOLATION');
      expect(problem.violations).toMatchObject([
        {
          code: 'PRICE_ITEMS_REQUIRED',
          message: 'Cadastre os itens da contratação antes de criar a pesquisa.',
        },
      ]);
      expect(researchesOf(process.id)).toEqual([]);
      expect(lastNumber()).toBe(before);
    });

    it('Quantidade inválida e data-base futura: 422 com OUT_OF_RANGE em items[2].quantity e em referenceDate', async () => {
      const { process, cement, sand, gravel } = await background();
      const response = await createResearch(process.id, {
        referenceDate: '2026-10-10',
        items: [
          { processItemId: cement.id },
          { processItemId: sand.id },
          { processItemId: gravel.id, quantity: '0' },
        ],
      });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([
        ['items[2].quantity', 'OUT_OF_RANGE'],
        ['referenceDate', 'OUT_OF_RANGE'],
      ]);
      expect(researchesOf(process.id)).toEqual([]);
    });

    it('V-01/V-03/V-04/V-06: lista vazia, item repetido, fração em unidade inteira e título curto', async () => {
      const { process, cement } = await background();
      expect(fieldErrors(await createResearch(process.id, { items: [] }))).toEqual([
        ['items', 'REQUIRED'],
      ]);
      expect(
        fieldErrors(
          await createResearch(process.id, {
            items: [{ processItemId: cement.id }, { processItemId: cement.id }],
          }),
        ),
      ).toEqual([['items[1].processItemId', 'DUPLICATE_IN_LIST']]);
      const fraction = await createResearch(process.id, {
        items: [{ processItemId: cement.id, quantity: '2.5' }],
      });
      expect(fieldErrors(fraction)).toEqual([['items[0].quantity', 'INVALID_DECIMAL']]);
      expect(fieldErrors(await createResearch(process.id, { title: 'PP' }))).toEqual([
        ['title', 'TOO_SHORT'],
      ]);
      expect(researchesOf(process.id)).toEqual([]);
    });

    it('FA-03: item sem quantidade em nenhuma fonte é obrigatório no envio', async () => {
      const created = await newProcess();
      const loose = await itemOk(created.id, { description: 'Brita 2', unitOfMeasureId: units.m3 });
      const process = toResearchStage(created);
      expect(fieldErrors(await createResearch(process.id, { referenceDate: TODAY }))).toEqual([
        ['items[0].quantity', 'REQUIRED'],
      ]);
      const research = await createOk(process.id, {
        items: [{ processItemId: loose.id, quantity: '7.5' }],
      });
      expect((await itemsOk(research.id))[0]?.quantity).toBe('7.5000');
    });

    it('V-07/V-10: template inválido; parâmetro do snapshot no PATCH; remover o último item', async () => {
      const { process } = await background();
      expect(fieldErrors(await createResearch(process.id, { templateId: newId() }))).toEqual([
        ['templateId', 'REFERENCE_NOT_FOUND'],
      ]);
      const research = await createOk(process.id, {});
      // US-029: os parâmetros de cálculo passaram a editáveis; os prazos de validade seguem fixos.
      const fixed = await patchResearch(research.id, { directQuoteMaxAgeDays: 90 }, '"1"');
      expectProblem(fixed, 422, 'VALIDATION_ERROR');
      expect(problemDetailsSchema.parse(fixed.body).errors).toMatchObject([
        {
          field: 'directQuoteMaxAgeDays',
          code: 'NOT_ALLOWED',
          message: 'Este parâmetro foi fixado na criação da pesquisa.',
        },
      ]);
      expectProblem(
        await patchResearch(research.id, { referenceDate: '2026-12-01' }, '"1"'),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await patchResearch(research.id, { title: 'Novo' }, null),
        428,
        'PRECONDITION_REQUIRED',
      );

      const items = await itemsOk(research.id);
      for (const item of items.slice(1)) {
        expect((await removeItem(item.id, `"${String(item.version)}"`)).status).toBe(204);
      }
      const last = items[0];
      const problem = expectProblem(
        await removeItem(last?.id ?? '', `"${String(last?.version)}"`),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toMatchObject([
        { code: 'NOT_ALLOWED', message: 'A pesquisa precisa de ao menos um item.' },
      ]);
    });

    it('Etapa sem pesquisa de preços → 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE; processo suspenso → 409 INVALID_PROCESS_STATUS', async () => {
      const { process } = await background();
      moveTo(process, { currentWorkflowStageId: stageId(process, 'ESTUDOS_PRELIMINARES') });
      const problem = expectProblem(
        await createResearch(process.id),
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
      );
      expect(problem.detail).toBe('A etapa atual não permite criar pesquisa de preços.');
      moveTo(process, {
        currentWorkflowStageId: stageId(process, 'PESQUISA_PRECOS'),
        status: 'SUSPENDED',
      });
      expectProblem(await createResearch(process.id), 409, 'INVALID_PROCESS_STATUS');
      expect(researchesOf(process.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem permissão de criar (REQUISITANTE): 403 PERMISSION_DENIED com access.denied PRICE_RESEARCH_CREATE', async () => {
      const { process } = await background();
      moveTo(process, { currentResponsibleId: FAKE_USERS.ana.id });
      expectProblem(
        await createResearch(process.id, {}, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PRICE_RESEARCH_CREATE',
      });
      expect(researchesOf(process.id)).toEqual([]);
    });

    it('Compras sem custódia do processo: 403 NOT_PROCESS_CUSTODIAN', async () => {
      const { process } = await background();
      moveTo(process, { currentResponsibleId: FAKE_USERS.lucia.id });
      const problem = expectProblem(await createResearch(process.id), 403, 'NOT_PROCESS_CUSTODIAN');
      expect(problem.detail).toBe('Você não pode criar a pesquisa deste processo agora.');
      expect(researchesOf(process.id)).toEqual([]);
    });

    it('Consultor externo participante edita a pesquisa, mas não a cria; leitor sem permissão vê sem ações', async () => {
      const { process } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'CONSULTANT',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      expectProblem(
        await createResearch(process.id, {}, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      const research = await createOk(process.id);
      const view = await getResearch(research.id, 'sub-otavio');
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      expect(
        priceResearchMetaSchema.parse((view.body as { meta: unknown }).meta).allowedActions,
      ).toContain('UPDATE');
      const edited = await patchResearch(
        research.id,
        { referenceDate: '2026-10-02' },
        '"1"',
        'sub-otavio',
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);

      // Ana (REQUISITANTE, sem custódia) só lê: nenhuma ação e 403 ao editar.
      const readOnly = await getResearch(research.id, 'sub-ana');
      expect(readOnly.status, JSON.stringify(readOnly.body)).toBe(200);
      const meta = priceResearchMetaSchema.parse((readOnly.body as { meta: unknown }).meta);
      expect(meta.allowedActions).toEqual([]);
      expect(meta.lockReason).toBe('PERMISSION_DENIED');
      expectProblem(
        await patchResearch(research.id, { referenceDate: '2026-10-03' }, '"2"', 'sub-ana'),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('FA-09: processo sigiloso — pesquisa RESTRICTED, valores mascarados e edição negada (POL-09) para quem não vê o orçamento', async () => {
      const { process } = await background();
      moveTo(process, { isBudgetConfidential: true });
      const research = await createOk(process.id);
      expect(research.confidentiality).toBe('RESTRICTED');
      expect(research.totalEstimatedValueMasked).toBe(false);

      // Otávio (ADMIN_ORGAO) vê o processo, mas não atende POL-09.
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      const masked = await getResearch(research.id, 'sub-otavio');
      expect(masked.status, JSON.stringify(masked.body)).toBe(200);
      expect(priceResearchSchema.parse(data(masked))).toMatchObject({
        totalEstimatedValue: null,
        totalEstimatedValueMasked: true,
      });
      const meta = priceResearchMetaSchema.parse((masked.body as { meta: unknown }).meta);
      expect(meta.allowedActions).toEqual([]);
      expect(meta.lockReason).toBe('CONFIDENTIAL_BUDGET');
      const items = await itemsOk(research.id, 'sub-otavio');
      expect(items[0]).toMatchObject({
        valuesMasked: true,
        recommendedUnitPrice: null,
        recommendedUnitPriceMasked: true,
      });
      expectProblem(
        await patchResearch(research.id, { referenceDate: '2026-10-02' }, '"1"', 'sub-otavio'),
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
    it('Item de processo de outro tenant: 422 REFERENCE_NOT_FOUND em items[0].processItemId sem revelar a existência', async () => {
      const { process } = await background();
      const foreignItem = newId();
      const response = await createResearch(process.id, {
        items: [{ processItemId: foreignItem, quantity: '1' }],
      });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problemDetailsSchema.parse(response.body).errors).toEqual([
        {
          field: 'items[0].processItemId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione itens deste processo.',
        },
      ]);
    });

    it('Pesquisa de outro tenant: 404 em PRS-01/03/04/05/06/08', async () => {
      const { process } = await background();
      const research = await createOk(process.id);
      const [item] = await itemsOk(research.id);
      // Fábio também tem vínculo na Prefeitura B (CONSULTOR_EXTERNO).
      expectProblem(await getResearch(research.id, RUI, B), 404, 'NOT_FOUND');
      expectProblem(await listItems(research.id, '', RUI, B), 404, 'NOT_FOUND');
      expectProblem(await listResearch(process.id, RUI, B), 404, 'NOT_FOUND');
      const patch = await auth(
        request(api.server).patch(`/api/v1/price-research/${research.id}`),
        RUI,
        B,
      )
        .set('If-Match', '"1"')
        .send({ referenceDate: TODAY });
      expectProblem(patch, 404, 'NOT_FOUND');
      const add = await auth(
        request(api.server).post(`/api/v1/price-research/${research.id}/items`),
        RUI,
        B,
      ).send({ items: [{ processItemId: newId() }] });
      expectProblem(add, 404, 'NOT_FOUND');
      const remove = await auth(
        request(api.server).delete(`/api/v1/price-items/${item?.id ?? ''}`),
        RUI,
        B,
      ).set('If-Match', '"1"');
      expectProblem(remove, 404, 'NOT_FOUND');
      expect(priceItemsOf(research.id)).toHaveLength(3);
    });
  });

  describe('[Duplicidade]', () => {
    it('Segunda pesquisa no mesmo processo: 409 DOCUMENT_ALREADY_EXISTS com meta.existingId', async () => {
      const { process } = await background();
      const research = await createOk(process.id);
      const conflict = await createResearch(process.id, { referenceDate: TODAY });
      const problem = expectProblem(conflict, 409, 'DOCUMENT_ALREADY_EXISTS');
      expect(problem.detail).toBe('Este processo já tem uma pesquisa de preços.');
      expect(conflict.body).toMatchObject({ meta: { existingId: research.id } });
      expect(researchesOf(process.id)).toHaveLength(1);
    });

    it('Reenvio com a mesma chave: 201 com a mesma pesquisa, Idempotent-Replayed e uma só pesquisa', async () => {
      const { process } = await background();
      const before = lastNumber();
      const key = randomUUID(); // a chave "K7" do cenário
      const first = await createResearch(process.id, { referenceDate: TODAY }, { key });
      const replay = await createResearch(process.id, { referenceDate: TODAY }, { key });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<PriceResearchDto>(replay).id).toBe(data<PriceResearchDto>(first).id);
      expect(researchesOf(process.id)).toHaveLength(1);
      expect(lastNumber()).toBe(before + 1);
      expectProblem(
        await createResearch(process.id, { referenceDate: '2026-10-01' }, { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('Inclusão de item já presente → 422 DUPLICATE_IN_LIST', async () => {
      const { process, cement } = await background();
      const research = await createOk(process.id);
      const response = await addItems(research.id, [{ processItemId: cement.id }]);
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['items[0].processItemId', 'DUPLICATE_IN_LIST']]);
    });
  });

  describe('[Concorrência]', () => {
    it('Criações simultâneas no mesmo processo com chaves diferentes: uma 201 e outra 409', async () => {
      const { process } = await background();
      const responses = await Promise.all([
        createResearch(process.id, { referenceDate: TODAY }),
        createResearch(process.id, { referenceDate: TODAY }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const loser = responses.find((response) => response.status === 409);
      expectProblem(loser as request.Response, 409, 'DOCUMENT_ALREADY_EXISTS');
      expect(researchesOf(process.id)).toHaveLength(1);
    });

    it('Alteração da data-base com versão desatualizada: 412 VERSION_CONFLICT com currentVersion', async () => {
      const { process } = await background();
      const research = await createOk(process.id);
      for (const [index, date] of ['2026-10-01', '2026-10-02', '2026-10-03'].entries()) {
        const response = await patchResearch(
          research.id,
          { referenceDate: date },
          `"${String(index + 1)}"`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      const stale = await patchResearch(research.id, { referenceDate: '2026-10-04' }, '"3"');
      expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(stale.body).toMatchObject({ currentVersion: 4 });
      const [item] = await itemsOk(research.id);
      expectProblem(await removeItem(item?.id ?? '', '"9"'), 412, 'VERSION_CONFLICT');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na criação: 503 DEPENDENCY_UNAVAILABLE e nada persistido nem numerado', async () => {
      const { process } = await background();
      const before = lastNumber();
      transactions.down = true;
      const response = await createResearch(process.id, { referenceDate: TODAY });
      const problem = expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(problem.correlationId).toEqual(expect.any(String));
      transactions.down = false;
      expect(researchesOf(process.id)).toEqual([]);
      expect(documentsOf(process.id).filter((doc) => doc.code?.startsWith('PP'))).toEqual([]);
      expect(eventsOf(process.id, 'DocumentCreated')).toEqual([]);
      expect(auditOf(process.id, 'document.create')).toEqual([]);
      expect(lastNumber()).toBe(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: a pesquisa é criada normalmente e o aviso idempotency.store_unavailable é registrado', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const degraded = await createTestApi({ stores: 'redis' });
      const as = (call: request.Test, subject: string) =>
        call
          .set('Authorization', degraded.bearer(subject, { amr: ['pwd', 'otp'] }))
          .set('X-Tenant-Id', A)
          .set('Idempotency-Key', randomUUID());
      try {
        await runTenantSeeders(degraded, A, [
          'catalog.items',
          'access.defaultRoles',
          'document.systemTypes',
          'document.templateLibrary',
          'workflow.seedWorkflows',
        ]);
        seedProcessStructure(degraded, A, {
          ...UNITS_A,
          shortName: 'PMSJ',
          cnpj: '11222333000181',
        });
        assignDepartment(degraded, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
        const created = await as(
          request(degraded.server).post('/api/v1/processes'),
          'sub-ana',
        ).send({
          title: `Aquisição de materiais de construção ${words(2)}`,
          object: `Aquisição de materiais para a reforma da escola ${words(2)}`,
          contractingTypeId: catalogItemId(degraded, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
          requestingSecretariatId: UNITS_A.obras,
          requestingDepartmentId: UNITS_A.manutencao,
          originId: catalogItemId(degraded, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
          priority: 'MEDIUM',
          pcaStatus: 'NOT_APPLICABLE',
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const processId = data<ProcessDto>(created).id;
        const item = await as(
          request(degraded.server).post(`/api/v1/processes/${processId}/items`),
          'sub-ana',
        ).send({
          kind: 'GOOD',
          description: 'Cimento CP II 50 kg',
          unitOfMeasureId: catalogItemId(degraded, A, 'UNIT_OF_MEASURE', 'UN'),
        });
        expect(item.status, JSON.stringify(item.body)).toBe(201);
        setProcessItemReferenceQuantity(degraded, data<ProcessItemDto>(item).id, '100.0000');
        const process = processRepositoryOf(degraded)
          .allProcesses()
          .find((candidate) => candidate.id === processId);
        if (!process) throw new Error('processo ausente');
        processRepositoryOf(degraded).replace({
          ...process,
          status: 'IN_PROGRESS',
          currentWorkflowStageId:
            workflowStagesOf(degraded, A).find(
              (stage) =>
                stage.key === 'PESQUISA_PRECOS' &&
                stage.workflowVersionId === process.workflowVersionId,
            )?.id ?? null,
          currentResponsibleId: FAKE_USERS.fabio.id,
        });
        const response = await as(
          request(degraded.server).post(`/api/v1/processes/${processId}/price-research`),
          RUI,
        ).send({});
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
      } finally {
        await degraded.close();
      }
    });
  });
});

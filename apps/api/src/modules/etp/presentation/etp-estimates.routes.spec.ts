import { randomUUID } from 'node:crypto';

import {
  documentItemSchema,
  etpDetailMetaSchema,
  etpDetailSchema,
  etpSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { DocumentItemDto, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
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
  DOCUMENT_CLOCK,
  DOCUMENT_TRANSACTIONS,
  documentItemRepositoryOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import { seedPriceResearch } from '../../../../test/support/price-research-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { ETP_CLOCK, ETP_TRANSACTIONS } from '../application/ports.js';
import { InMemoryEtpRepository } from '../infrastructure/etp.repositories.js';

/*
 * US-022 — Estimar quantidades e vincular valor à pesquisa de preços, pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, `If-Match`, filtro RFC 9457) com a identidade fake,
 * os seeders reais e o ETP do ETP-02 no processo levado aos estudos preliminares: DOC-07 (quantidade
 * e memória de cálculo por item) e ETP-04 (origem e valor estimado) nas 8 categorias do Gherkin +
 * FA-01..05, V-01..V-08. Lúcia (PLANEJAMENTO, custódia) é a "Ana" do Gherkin; Otávio
 * (SOMENTE_LEITURA) é o "Bruno"; Ana (REQUISITANTE, participante COLLABORATOR) é o "Carlos". A
 * pesquisa de preços é semeada com o total (conclusão = US-032). A sincronização assíncrona
 * (Duplicidade e Falha de integração — RN-ETP-29/31) roda no worker:
 * `apps/worker/test/tenant-leak/etp-estimate-sync.spec.ts`; RLS e a atualização condicional no
 * PostgreSQL: `test/tenant-leak/etp-estimates.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-19T15:00:00.000Z');
const LUCIA = 'sub-lucia';
const OTAVIO = 'sub-otavio';
const ANA = 'sub-ana';

const UNITS_A = {
  organizationId: '0192d022-0000-7000-8000-0000000000a0',
  obras: '0192d022-0000-7000-8000-0000000000a1',
  manutencao: '0192d022-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d022-0000-7000-8000-0000000000a3',
  saude: '0192d022-0000-7000-8000-0000000000a4',
  posto: '0192d022-0000-7000-8000-0000000000a5',
};

const MEMO = 'Consumo médio mensal (50) × 10 meses de obra';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações que podem simular o banco fora do ar. */
class FlakyTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
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

const ETP_RESPONSE = z.object({ data: etpDetailSchema, meta: etpDetailMetaSchema });

describe('Feature: Estimar quantidades e vincular valor à pesquisa de preços (US-022)', () => {
  let api: TestApi;
  const documents = new FlakyTransactions();
  const etps = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; un: string; m3: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = LUCIA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const getEtp = (id: string, subject = LUCIA, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/etps/${id}`), subject, tenant);
  const patchEtp = (
    id: string,
    body: Record<string, unknown>,
    options: { ifMatch: number | null; subject?: string; tenant?: string },
  ) => {
    const call = auth(
      request(api.server).patch(`/api/v1/etps/${id}`),
      options.subject,
      options.tenant,
    );
    return (
      options.ifMatch === null ? call : call.set('If-Match', `"${String(options.ifMatch)}"`)
    ).send(body);
  };
  const getItems = (documentId: string, subject = LUCIA) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/items`), subject);
  const putItems = (
    documentId: string,
    items: readonly Record<string, unknown>[],
    options: { ifMatch: number; subject?: string; tenant?: string },
  ) =>
    auth(
      request(api.server).put(`/api/v1/documents/${documentId}/items`),
      options.subject,
      options.tenant,
    )
      .set('If-Match', `"${String(options.ifMatch)}"`)
      .send({ items });

  const auditOf = (entityId: string, action: string) =>
    api.auditRecords().filter((row) => row.entityId === entityId && row.action === action);
  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const stageId = (process: Process, key: string) =>
    workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === key && candidate.workflowVersionId === process.workflowVersionId,
    )?.id ?? null;
  const typeOf = (code: string, tenantId: string = A) =>
    documentTypeRepositoryOf(api)
      .snapshot()
      .find((type) => type.tenantId === tenantId && type.code === code);

  async function itemOk(processId: string, body: Record<string, unknown>) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/items`),
      ANA,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessItemDto>(response);
  }

  /**
   * Background: processo "0012/2026" (PRC-02, Ana) com os itens "1 - Cimento CP-II" e "2 - Areia
   * média", nos estudos preliminares sob custódia da Lúcia, e o ETP (ETP-02) em DRAFT com os dois
   * itens (DOC-07 — o que a importação do DFD faria).
   */
  async function background(options: { confidential?: boolean } = {}) {
    const response = await auth(request(api.server).post('/api/v1/processes'), ANA)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Reforma da escola ${words(2)}`,
        object: `Aquisição de materiais de construção para a reforma ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        priority: 'MEDIUM',
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const processId = data<ProcessDto>(response).id;
    const cement = await itemOk(processId, {
      description: 'Cimento CP-II (saco 50kg)',
      unitOfMeasureId: catalog.un,
    });
    const sand = await itemOk(processId, {
      description: 'Areia média (m³)',
      unitOfMeasureId: catalog.m3,
    });
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === processId);
    if (!created) throw new Error('processo ausente');
    const process = {
      ...created,
      status: 'IN_PROGRESS' as const,
      currentWorkflowStageId: stageId(created, 'ESTUDOS_PRELIMINARES'),
      currentResponsibleId: FAKE_USERS.lucia.id,
      isBudgetConfidential: options.confidential === true,
    };
    processRepositoryOf(api).replace(process);
    const etpResponse = await auth(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
    const etp = etpSchema.parse(data(etpResponse));
    const seeded = await putItems(
      etp.documentId,
      [
        { processItemId: cement.id, quantity: '400' },
        { processItemId: sand.id, quantity: '12.5' },
      ],
      { ifMatch: etp.documentVersion },
    );
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    return { process, etp, cement, sand };
  }

  /** Pesquisa de preços do processo (documento no status dado) com o total (`null` = sem cálculo). */
  function seedResearch(
    process: Pick<Process, 'id' | 'tenantId'>,
    options: { status?: 'DRAFT' | 'FINALIZED' | 'CANCELED'; total?: string | null } = {},
  ) {
    const type = typeOf('PRICE_RESEARCH', process.tenantId);
    const id = newId();
    documentRepositoryOf(api).seed(
      buildDocument({
        id,
        tenantId: process.tenantId,
        processId: process.id,
        documentTypeId: type?.id ?? newId(),
        code: 'PP 0003/2026',
        title: 'Pesquisa de preços — materiais',
        status: options.status ?? 'FINALIZED',
        singletonKey: options.status === 'CANCELED' ? null : (type?.id ?? null),
      }),
    );
    seedPriceResearch(api, {
      id,
      tenantId: process.tenantId,
      processId: process.id,
      totalEstimatedValue: options.total === undefined ? '125000.00' : options.total,
      completedAt: options.status === 'FINALIZED' || options.status === undefined ? NOW : null,
      now: NOW,
    });
    return id;
  }

  async function detailOf(id: string, subject = LUCIA) {
    const response = await getEtp(id, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return ETP_RESPONSE.parse(response.body);
  }

  async function itemsOf(documentId: string, subject = LUCIA) {
    const response = await getItems(documentId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      items: z.array(documentItemSchema).parse(data(response)),
      version: Number(String(response.headers.etag).replaceAll('"', '')),
    };
  }

  const linesOf = (items: readonly DocumentItemDto[]) =>
    items.map((item) => ({
      processItemId: item.processItemId,
      quantity: item.quantity,
      ...(item.calculationMemo === null ? {} : { calculationMemo: item.calculationMemo }),
    }));

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: documents },
        { token: ETP_TRANSACTIONS, value: etps },
        { token: ETP_CLOCK, value: () => NOW },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    for (const tenant of [A, B]) {
      await runTenantSeeders(api, tenant, [
        'catalog.items',
        'access.defaultRoles',
        'document.systemTypes',
        'document.templateLibrary',
        'workflow.seedWorkflows',
      ]);
    }
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
      m3: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'M3'),
    };
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    documents.down = false;
    etps.down = false;
  });

  describe('[Sucesso]', () => {
    it('Informar quantidade e memória de cálculo de um item (DOC-07): 500,0000 e document.items_update sem o texto', async () => {
      const { etp, cement, sand } = await background();
      const before = await itemsOf(etp.documentId);
      const response = await putItems(
        etp.documentId,
        [
          { processItemId: cement.id, quantity: '500', calculationMemo: paragraph(MEMO) },
          { processItemId: sand.id, quantity: '12.5' },
        ],
        { ifMatch: before.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(`"${String(before.version + 1)}"`);
      const items = z.array(documentItemSchema).parse(data(response));
      expect(items[0]).toMatchObject({
        processItemId: cement.id,
        quantity: '500.0000',
        calculationMemo: paragraph(MEMO),
      });
      expect(items[1]).toMatchObject({ quantity: '12.5000', calculationMemo: null });

      const audits = auditOf(etp.documentId, 'document.items_update');
      const last = audits.at(-1);
      expect(last?.changes).toEqual([
        { path: `items.${cement.id}.quantity`, old: '400.0000', new: '500.0000' },
        {
          path: `items.${cement.id}.calculationMemo`,
          old: null,
          new: {
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
            bytes: expect.any(Number) as unknown,
          },
        },
      ]);
      // Memória de cálculo nunca vai em claro para a auditoria (hash + tamanho).
      expect(JSON.stringify(audits)).not.toContain('Consumo médio');

      // A memória ausente no corpo é preservada (ids e ordem também — "Impacto técnico").
      const ids = documentItemRepositoryOf(api)
        .snapshot()
        .filter((row) => row.documentId === etp.documentId)
        .map((row) => row.id);
      const kept = await putItems(
        etp.documentId,
        [
          { processItemId: cement.id, quantity: '501' },
          { processItemId: sand.id, quantity: '12.5' },
        ],
        { ifMatch: before.version + 1 },
      );
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(z.array(documentItemSchema).parse(data(kept))[0]?.calculationMemo).toEqual(
        paragraph(MEMO),
      );
      expect(
        documentItemRepositoryOf(api)
          .snapshot()
          .filter((row) => row.documentId === etp.documentId)
          .map((row) => row.id),
      ).toEqual(ids);
      const { items: listed } = await itemsOf(etp.documentId);
      expect(listed[0]).toMatchObject({ quantity: '501.0000', calculationMemo: paragraph(MEMO) });
    });

    it('Vincular o valor estimado à pesquisa concluída: PRICE_RESEARCH, priceResearchId e R$ 125.000,00 somente leitura', async () => {
      const { process, etp } = await background();
      const researchId = seedResearch(process);
      const response = await patchEtp(
        etp.id,
        { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId },
        { ifMatch: etp.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(`"${String(etp.version + 1)}"`);
      const { data: detail, meta } = ETP_RESPONSE.parse(response.body);
      expect(detail).toMatchObject({
        estimatedValueSource: 'PRICE_RESEARCH',
        priceResearchId: researchId,
        estimatedTotalValue: '125000.00',
        estimatedTotalValueMasked: false,
        version: etp.version + 1,
      });
      expect(meta.allowedActions).toContain('UPDATE');
      // Somente leitura: enviar valor com a pesquisa é recusado.
      const readOnly = expectProblem(
        await patchEtp(
          etp.id,
          {
            estimatedValueSource: 'PRICE_RESEARCH',
            priceResearchId: researchId,
            estimatedTotalValue: '1.00',
          },
          { ifMatch: etp.version + 1 },
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(readOnly.errors).toEqual([
        expect.objectContaining({ field: 'estimatedTotalValue', code: 'NOT_ALLOWED' }),
      ]);
      const draftAudit = auditOf(etp.documentId, 'document.draft_update').at(-1);
      expect(draftAudit?.changes).toEqual(
        expect.arrayContaining([
          { path: 'estimatedValueSource', old: null, new: 'PRICE_RESEARCH' },
          { path: 'priceResearchId', old: null, new: researchId },
          { path: 'estimatedTotalValue', old: null, new: '125000.00' },
        ]),
      );
      expect(draftAudit?.metadata).toMatchObject({
        target: 'HEADER',
        estimatedValueSource: 'PRICE_RESEARCH',
        priceResearchId: researchId,
      });
      const { data: reloaded } = await detailOf(etp.id);
      expect(reloaded.estimatedTotalValue).toBe('125000.00');
      // Nenhum evento de domínio próprio (story · "Eventos gerados").
      expect(
        api
          .outboxRows()
          .filter((row) => row.aggregateId === etp.id)
          .map((row) => row.eventType),
      ).toEqual(['DocumentCreated']);
    });

    it('FA-01/FA-02: manual → pesquisa descarta o manual; pesquisa → manual parte do valor enviado', async () => {
      const { process, etp } = await background();
      const manual = await patchEtp(
        etp.id,
        { estimatedValueSource: 'MANUAL', estimatedTotalValue: '98000.5' },
        { ifMatch: etp.version },
      );
      expect(manual.status, JSON.stringify(manual.body)).toBe(200);
      expect(ETP_RESPONSE.parse(manual.body).data).toMatchObject({
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '98000.50',
        priceResearchId: null,
      });
      const researchId = seedResearch(process);
      const linked = await patchEtp(
        etp.id,
        { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId },
        { ifMatch: etp.version + 1 },
      );
      expect(ETP_RESPONSE.parse(linked.body).data).toMatchObject({
        estimatedValueSource: 'PRICE_RESEARCH',
        estimatedTotalValue: '125000.00',
      });
      const back = await patchEtp(
        etp.id,
        { estimatedValueSource: 'MANUAL', estimatedTotalValue: '125000.00' },
        { ifMatch: etp.version + 2 },
      );
      expect(ETP_RESPONSE.parse(back.body).data).toMatchObject({
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '125000.00',
        priceResearchId: null,
      });
    });

    it('FA-03: pesquisa vinculada ainda sem cálculo → vínculo gravado com o valor ausente', async () => {
      const { process, etp } = await background();
      const researchId = seedResearch(process, { status: 'DRAFT', total: null });
      const response = await patchEtp(
        etp.id,
        { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId },
        { ifMatch: etp.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(ETP_RESPONSE.parse(response.body).data).toMatchObject({
        estimatedValueSource: 'PRICE_RESEARCH',
        priceResearchId: researchId,
        estimatedTotalValue: null,
      });
    });
  });

  describe('[Validação]', () => {
    it('Quantidade zerada ou negativa: 422 VALIDATION_ERROR com OUT_OF_RANGE em quantity, nada gravado', async () => {
      const { etp, cement, sand } = await background();
      const { version } = await itemsOf(etp.documentId);
      const problem = expectProblem(
        await putItems(
          etp.documentId,
          [
            { processItemId: cement.id, quantity: '400' },
            { processItemId: sand.id, quantity: '0' },
          ],
          { ifMatch: version },
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        {
          field: 'items[1].quantity',
          code: 'OUT_OF_RANGE',
          message: 'Informe uma quantidade maior que zero.',
        },
      ]);
      const decimals = expectProblem(
        await putItems(etp.documentId, [{ processItemId: sand.id, quantity: '1.12345' }], {
          ifMatch: version,
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(decimals.errors[0]).toMatchObject({ code: 'INVALID_DECIMAL' });
      expect(documentOf(etp.documentId).version).toBe(version);
    });

    it('V-03: memória de cálculo fora do schema → 422 RICH_TEXT_INVALID; acima de 1 MB → 413', async () => {
      const { etp, cement } = await background();
      const { version } = await itemsOf(etp.documentId);
      expectProblem(
        await putItems(
          etp.documentId,
          [
            {
              processItemId: cement.id,
              quantity: '400',
              calculationMemo: { type: 'doc', content: [{ type: 'script' }] },
            },
          ],
          { ifMatch: version },
        ),
        422,
        'RICH_TEXT_INVALID',
      );
      const big = paragraph('x'.repeat(1024 * 1024));
      const response = await putItems(
        etp.documentId,
        [{ processItemId: cement.id, quantity: '400', calculationMemo: big }],
        { ifMatch: version },
      );
      expect(response.status).toBe(413);
      expect(documentOf(etp.documentId).version).toBe(version);
    });

    it('Valor sem origem definida: 422 VALIDATION_ERROR com REQUIRED em estimatedValueSource', async () => {
      const { etp } = await background();
      const problem = expectProblem(
        await patchEtp(etp.id, { estimatedTotalValue: '1000.00' }, { ifMatch: etp.version }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        {
          field: 'estimatedValueSource',
          code: 'REQUIRED',
          message: 'Escolha como o valor estimado será definido.',
        },
      ]);
      expect((await detailOf(etp.id)).data.version).toBe(etp.version);
    });

    it('V-05: valor manual negativo ou com 3 casas → INVALID_DECIMAL; MANUAL sem valor → REQUIRED', async () => {
      const { etp } = await background();
      for (const estimatedTotalValue of ['-10', '10.123']) {
        const problem = expectProblem(
          await patchEtp(
            etp.id,
            { estimatedValueSource: 'MANUAL', estimatedTotalValue },
            { ifMatch: etp.version },
          ),
          422,
          'VALIDATION_ERROR',
        );
        expect(problem.errors[0]).toMatchObject({
          field: 'estimatedTotalValue',
          code: 'INVALID_DECIMAL',
          message: 'Informe um valor válido, com até 2 casas decimais.',
        });
      }
      const missing = expectProblem(
        await patchEtp(etp.id, { estimatedValueSource: 'MANUAL' }, { ifMatch: etp.version }),
        422,
        'VALIDATION_ERROR',
      );
      expect(missing.errors[0]).toMatchObject({ field: 'estimatedTotalValue', code: 'REQUIRED' });
    });

    it('V-06: pesquisa cancelada → REFERENCE_INACTIVE; de outro processo → REFERENCE_NOT_FOUND', async () => {
      const { process, etp } = await background();
      const canceled = seedResearch(process, { status: 'CANCELED' });
      const inactive = expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: canceled },
          { ifMatch: etp.version },
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(inactive.errors).toEqual([
        {
          field: 'priceResearchId',
          code: 'REFERENCE_INACTIVE',
          message: 'Selecione uma pesquisa de preços válida deste processo.',
        },
      ]);
      const other = await background();
      const foreign = seedResearch(other.process);
      const notFound = expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: foreign },
          { ifMatch: etp.version },
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(notFound.errors[0]).toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    });

    it('V-07: ETP fora de DRAFT/RETURNED → 409 DOCUMENT_NOT_EDITABLE (itens e valor)', async () => {
      const { etp, cement } = await background();
      const document = documentOf(etp.documentId);
      documentRepositoryOf(api).seed({ ...document, status: 'IN_REVIEW' });
      const problem = expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '10.00' },
          { ifMatch: etp.version },
        ),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(problem.detail).toBe('Este ETP não pode ser editado no momento.');
      expectProblem(
        await putItems(etp.documentId, [{ processItemId: cement.id, quantity: '1' }], {
          ifMatch: document.version,
        }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      const { meta } = await detailOf(etp.id);
      expect(meta.allowedActions).not.toContain('UPDATE');
    });

    it('V-08: If-Match ausente → 428 PRECONDITION_REQUIRED', async () => {
      const { etp } = await background();
      expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '10.00' },
          { ifMatch: null },
        ),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem ETP_UPDATE: tela somente leitura e 403 PERMISSION_DENIED no PUT dos itens e no PATCH', async () => {
      const { process, etp, cement } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'OBSERVER',
      });
      const { meta } = await detailOf(etp.id, OTAVIO);
      expect(meta.allowedActions).not.toContain('UPDATE');
      const { version } = await itemsOf(etp.documentId, OTAVIO);
      expectProblem(
        await putItems(etp.documentId, [{ processItemId: cement.id, quantity: '1' }], {
          ifMatch: version,
          subject: OTAVIO,
        }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '10.00' },
          { ifMatch: etp.version, subject: OTAVIO },
        ),
        403,
        'PERMISSION_DENIED',
      );
      expect(
        api
          .auditRecords()
          .some(
            (row) =>
              row.action === 'access.denied' &&
              row.actorUserId === FAKE_USERS.otavio.id &&
              row.reasonCode === 'ETP_UPDATE',
          ),
      ).toBe(true);
      expect((await detailOf(etp.id)).data.estimatedValueSource).toBeNull();
    });

    it('FA-05 (POL-09): orçamento sigiloso mascara o valor para a colaboradora, que também não o altera', async () => {
      const { process, etp } = await background({ confidential: true });
      const researchId = seedResearch(process);
      const linked = await patchEtp(
        etp.id,
        { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId },
        { ifMatch: etp.version },
      );
      // A custodiante vê o valor.
      expect(ETP_RESPONSE.parse(linked.body).data).toMatchObject({
        estimatedTotalValue: '125000.00',
        estimatedTotalValueMasked: false,
      });
      // Processo sigiloso: o valor nunca vai em claro para a auditoria.
      expect(auditOf(etp.documentId, 'document.draft_update').at(-1)?.changes).toContainEqual({
        path: 'estimatedTotalValue',
        old: '[MASKED]',
        new: '[MASKED]',
      });
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const masked = await detailOf(etp.id, ANA);
      expect(masked.data).toMatchObject({
        estimatedTotalValue: null,
        estimatedTotalValueMasked: true,
      });
      expect(JSON.stringify(masked)).not.toContain('125000');
      expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '1.00' },
          { ifMatch: etp.version + 1, subject: ANA },
        ),
        403,
        'PERMISSION_DENIED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Vincular pesquisa de preços de outro tenant: 422 REFERENCE_NOT_FOUND sem revelar que ela existe', async () => {
      const { etp } = await background();
      const foreign = seedResearch({ id: newId(), tenantId: B });
      const problem = expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: foreign },
          { ifMatch: etp.version },
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        {
          field: 'priceResearchId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma pesquisa de preços válida deste processo.',
        },
      ]);
      expect(JSON.stringify(problem)).not.toContain('PP 0003/2026');
      expect(JSON.stringify(problem)).not.toContain('125000');
    });

    it('ETP de outro tenant: ETP-04 → 404 NOT_FOUND sem alterar nada', async () => {
      const { etp } = await background();
      // Fábio tem vínculo na Prefeitura B (CONSULTOR_EXTERNO).
      expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '1.00' },
          { ifMatch: etp.version, subject: 'sub-fabio', tenant: B },
        ),
        404,
        'NOT_FOUND',
      );
      expect((await detailOf(etp.id)).data).toMatchObject({
        estimatedValueSource: null,
        version: etp.version,
      });
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do mesmo valor: 200 sem versão nova nem auditoria duplicada', async () => {
      const { process, etp } = await background();
      const researchId = seedResearch(process);
      const body = { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId };
      const first = await patchEtp(etp.id, body, { ifMatch: etp.version });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const audits = auditOf(etp.documentId, 'document.draft_update').length;
      const again = await patchEtp(etp.id, body, { ifMatch: etp.version + 1 });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.headers.etag).toBe(`"${String(etp.version + 1)}"`);
      expect(auditOf(etp.documentId, 'document.draft_update')).toHaveLength(audits);
    });

    it('A sincronização do worker (RN-ETP-29) atualiza o valor e a tela reflete ao revalidar', async () => {
      const { process, etp } = await background();
      const researchId = seedResearch(process);
      await patchEtp(
        etp.id,
        { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: researchId },
        { ifMatch: etp.version },
      );
      // O efeito do `EtpEstimateSynchronizer` (worker, SQL) sobre a linha.
      api.app
        .get(InMemoryEtpRepository, { strict: false })
        .patch(etp.id, { estimatedTotalValue: '130000.00', version: etp.version + 2 });
      expect((await detailOf(etp.id)).data).toMatchObject({
        estimatedTotalValue: '130000.00',
        version: etp.version + 2,
      });
      // FA-04: vínculo desfeito pelo cancelamento — o último valor fica sem origem.
      api.app
        .get(InMemoryEtpRepository, { strict: false })
        .patch(etp.id, { estimatedValueSource: null, priceResearchId: null });
      expect((await detailOf(etp.id)).data).toMatchObject({
        estimatedValueSource: null,
        priceResearchId: null,
        estimatedTotalValue: '130000.00',
      });
    });
  });

  describe('[Concorrência]', () => {
    it('Duas edições simultâneas dos itens: a segunda com If-Match antigo → 412 VERSION_CONFLICT', async () => {
      const { process, etp, cement, sand } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const { items, version } = await itemsOf(etp.documentId);
      const lines = linesOf(items);
      const [ana, carlos] = await Promise.all([
        putItems(
          etp.documentId,
          lines.map((line) =>
            line.processItemId === cement.id ? { ...line, quantity: '500' } : line,
          ),
          { ifMatch: version },
        ),
        putItems(
          etp.documentId,
          lines.map((line) =>
            line.processItemId === sand.id ? { ...line, quantity: '20' } : line,
          ),
          { ifMatch: version, subject: ANA },
        ),
      ]);
      const statuses = [ana.status, carlos.status].sort();
      expect(statuses).toEqual([200, 412]);
      const loser = ana.status === 412 ? ana : carlos;
      expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect(documentOf(etp.documentId).version).toBe(version + 1);
    });

    it('ETP-04 com If-Match de versão antiga → 412 VERSION_CONFLICT com currentVersion', async () => {
      const { etp } = await background();
      const first = await patchEtp(
        etp.id,
        { estimatedValueSource: 'MANUAL', estimatedTotalValue: '10.00' },
        { ifMatch: etp.version },
      );
      expect(first.status).toBe(200);
      const problem = expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '20.00' },
          { ifMatch: etp.version },
        ),
        412,
        'VERSION_CONFLICT',
      );
      expect(problem).toMatchObject({ currentVersion: etp.version + 1 });
      expect((await detailOf(etp.id)).data.estimatedTotalValue).toBe('10.00');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao salvar os itens: 503 DEPENDENCY_UNAVAILABLE e a quantidade anterior fica', async () => {
      const { etp, cement, sand } = await background();
      const { version } = await itemsOf(etp.documentId);
      documents.down = true;
      expectProblem(
        await putItems(
          etp.documentId,
          [
            { processItemId: cement.id, quantity: '500' },
            { processItemId: sand.id, quantity: '12.5' },
          ],
          { ifMatch: version },
        ),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      documents.down = false;
      const { items } = await itemsOf(etp.documentId);
      expect(items[0]?.quantity).toBe('400.0000');
    });

    it('Banco indisponível ao salvar o valor: 503 e nada muda', async () => {
      const { etp } = await background();
      etps.down = true;
      expectProblem(
        await patchEtp(
          etp.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '10.00' },
          { ifMatch: etp.version },
        ),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      etps.down = false;
      expect((await detailOf(etp.id)).data.estimatedValueSource).toBeNull();
    });
  });
});

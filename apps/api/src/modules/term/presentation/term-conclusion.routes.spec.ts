import { randomUUID } from 'node:crypto';

import {
  documentMetaSchema,
  documentSchema,
  etpSchema,
  problemDetailsSchema,
  termDetailMetaSchema,
  termDetailSchema,
  termSchema,
  violationSchema,
} from '@contrataflow/validation';
import type { ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  DOCUMENT_CLOCK,
  DOCUMENT_TRANSACTIONS,
  documentItemRepositoryOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { TERM_CLOCK, TERM_TRANSACTIONS } from '../application/ports.js';
import type { TermTransactions } from '../application/ports.js';

/*
 * US-039 — Validar e concluir o TR, pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade fake e os seeders
 * reais. Background: processo com 3 itens; nos estudos preliminares o ETP (ETP-02) com as
 * quantidades 100/20/40 (DOC-07), finalizado; na etapa do TR, o TR (TRM-02) em DRAFT sob custódia
 * de Carla ("Lúcia" — PLANEJAMENTO). DOC-08 (pendências genéricas + as do `TermDocumentValidator`),
 * DOC-10 (finalização com revalidação na mesma transação) e DOC-09 (tipo com `requiresApproval`)
 * nas 8 categorias do Gherkin + FA-01/02/03 e V-01..V-08. Bruno ("Otávio") é SOMENTE_LEITURA; Ana
 * (REQUISITANTE) é a outra pessoa; Fábio é da Prefeitura B. RLS, falha induzida no meio da
 * transação e o outbox PENDING no PostgreSQL: `test/tenant-leak/term-conclusion.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';
const ANA = 'sub-ana';
/** Usuário da Prefeitura B. */
const FABIO = 'sub-fabio';

const UNITS_A = {
  organizationId: '0192d039-0000-7000-8000-0000000000a0',
  obras: '0192d039-0000-7000-8000-0000000000a1',
  manutencao: '0192d039-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d039-0000-7000-8000-0000000000a3',
  saude: '0192d039-0000-7000-8000-0000000000a4',
  posto: '0192d039-0000-7000-8000-0000000000a5',
};

const DIVERGENT = 'TR_ITEM_QUANTITY_DIVERGENT';
const NO_GUARANTEE = 'TR_GUARANTEE_NOT_DEFINED';
const SECTION_TEXT =
  'Texto do termo de referência elaborado pela equipe de planejamento, com os elementos do art. 6º, XXIII, da Lei 14.133/2021, sem lacunas pendentes.';

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

const paragraph = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

const TERM_RESPONSE = z.object({ data: termDetailSchema, meta: termDetailMetaSchema });
const DOCUMENT_RESPONSE = z.object({ data: documentSchema, meta: documentMetaSchema });
const VIOLATIONS = z.object({ data: z.object({ violations: z.array(violationSchema) }) });
const PROBLEM_VIOLATIONS = z.looseObject({ violations: z.array(violationSchema) });

describe('Feature: Validar e concluir o TR (US-039)', () => {
  let api: TestApi;
  const documents = new FlakyTransactions();
  const terms = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; un: string; menorPreco: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = CARLA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const post = (path: string, subject = CARLA) =>
    auth(request(api.server).post(`/api/v1${path}`), subject);
  const validation = (documentId: string, subject = CARLA) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/validation`), subject);
  const getDocument = (documentId: string, subject = CARLA) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}`), subject);
  const conclude = (
    action: 'finalize' | 'submit',
    documentId: string,
    version: number | null,
    options: {
      key?: string;
      subject?: string;
      tenant?: string;
      acknowledgedWarnings?: string[];
    } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/documents/${documentId}/${action}`),
      options.subject,
      options.tenant,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    return (version === null ? call : call.set('If-Match', `"${String(version)}"`)).send(
      options.acknowledgedWarnings === undefined
        ? {}
        : { acknowledgedWarnings: options.acknowledgedWarnings },
    );
  };
  const finalize = (
    documentId: string,
    version: number | null,
    options: Parameters<typeof conclude>[3] = {},
  ) => conclude('finalize', documentId, version, options);
  const patchTerm = (termId: string, body: Record<string, unknown>, ifMatch: number) =>
    auth(request(api.server).patch(`/api/v1/terms/${termId}`))
      .set('If-Match', `"${String(ifMatch)}"`)
      .send(body);
  const putItems = (
    documentId: string,
    items: readonly Record<string, unknown>[],
    subject = CARLA,
  ) =>
    auth(request(api.server).put(`/api/v1/documents/${documentId}/items`), subject)
      .set('If-Match', `"${String(documentOf(documentId).version)}"`)
      .send({ items });

  const auditOf = (entityId: string, action: string) =>
    api.auditRecords().filter((row) => row.entityId === entityId && row.action === action);
  const eventsOf = (aggregateId: string) =>
    api.outboxRows().filter((row) => row.aggregateId === aggregateId);
  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const versionsOf = (documentId: string) => documentRepositoryOf(api).versionsOf(documentId);
  const rowsOf = (documentId: string) =>
    documentItemRepositoryOf(api)
      .snapshot()
      .filter((item) => item.documentId === documentId);
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

  async function termOf(termId: string, subject = CARLA) {
    const response = await auth(request(api.server).get(`/api/v1/terms/${termId}`), subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return TERM_RESPONSE.parse(response.body);
  }

  async function violationsOf(documentId: string, subject = CARLA) {
    const response = await validation(documentId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return VIOLATIONS.parse(response.body).data.violations;
  }

  async function documentNow(documentId: string, subject = CARLA) {
    const response = await getDocument(documentId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return DOCUMENT_RESPONSE.parse(response.body);
  }

  async function itemOk(processId: string, description: string) {
    const response = await post(`/processes/${processId}/items`, ANA)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description, unitOfMeasureId: catalog.un });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessItemDto>(response);
  }

  /**
   * Background: processo "0012/2026" com os itens 1..3; ETP com as quantidades 100/20/40
   * (`FINALIZED`, ou no status dado) e o TR em DRAFT do modelo padrão sob custódia de Carla.
   */
  async function background(options: { etpStatus?: 'FINALIZED' | 'DRAFT' } = {}) {
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
    const items = [
      await itemOk(processId, 'Cimento CP-II'),
      await itemOk(processId, 'Areia média'),
      await itemOk(processId, 'Brita 1'),
    ];
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === processId);
    if (!created) throw new Error('processo ausente');
    let process = moveTo(created, {
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId(created, 'ESTUDOS_PRELIMINARES'),
      currentResponsibleId: FAKE_USERS.lucia.id,
    });
    const etpResponse = await post(`/processes/${process.id}/etps`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
    const etp = etpSchema.parse(data(etpResponse));
    const etpItems = await putItems(
      etp.documentId,
      items.map((item, index) => ({
        processItemId: item.id,
        quantity: ['100', '20', '40'][index],
      })),
    );
    expect(etpItems.status, JSON.stringify(etpItems.body)).toBe(200);
    documentRepositoryOf(api).seed({
      ...documentOf(etp.documentId),
      status: options.etpStatus ?? 'FINALIZED',
    });

    process = moveTo(process, { currentWorkflowStageId: stageId(process, 'TERMO_REFERENCIA') });
    const termResponse = await post(`/processes/${process.id}/terms`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(termResponse.status, JSON.stringify(termResponse.body)).toBe(201);
    const term = termSchema.parse(data(termResponse));
    return { process, term, items, etpId: etp.documentId };
  }

  /** Todas as seções do template do TR preenchidas (o trabalho da US-036), direto no rascunho. */
  async function fillSections(termId: string, skip: readonly string[] = []) {
    const { meta } = await termOf(termId);
    const document = documentOf(termId);
    const sections = { ...document.draftContent.sections };
    for (const section of meta.template?.sections ?? []) {
      if (skip.includes(section.key)) continue;
      sections[section.key] = {
        state: 'FILLED',
        content: paragraph(`${section.title}. ${SECTION_TEXT}`),
        justification: null,
        revision: 1,
        updatedAt: NOW.toISOString(),
        updatedById: FAKE_USERS.lucia.id,
      };
    }
    documentRepositoryOf(api).seed({ ...document, draftContent: { sections } });
  }

  /**
   * TR completo: seções preenchidas, itens com as quantidades (as do ETP por padrão), valor manual
   * justificado na seção, critério de julgamento, adjudicação por item e garantia do produto.
   */
  async function complete(
    setup: Awaited<ReturnType<typeof background>>,
    options: { quantities?: readonly string[]; conditions?: Record<string, unknown> } = {},
  ) {
    const { term, items } = setup;
    await fillSections(term.id);
    const saved = await putItems(
      term.documentId,
      items.map((item, index) => ({
        processItemId: item.id,
        quantity: (options.quantities ?? ['100', '20', '40'])[index],
        sortOrder: index,
      })),
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const { data: current } = await termOf(term.id);
    const patched = await patchTerm(
      term.id,
      {
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '98000.00',
        selectionCriterionId: catalog.menorPreco,
        awardType: 'BY_ITEM',
        productWarrantyMonths: 12,
        ...options.conditions,
      },
      current.version,
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: documents },
        { token: TERM_TRANSACTIONS, value: terms },
        { token: TERM_CLOCK, value: () => NOW },
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
    // Fábio é PLANEJAMENTO na Prefeitura B: o 404 vem do isolamento, não da falta de permissão.
    assignRole(api, {
      tenantId: B,
      membershipId:
        FAKE_MEMBERSHIPS.find((m) => m.userId === FAKE_USERS.fabio.id && m.tenantId === B)?.id ??
        '',
      roleId: seedDefaultRolesOf(api, B).get('PLANEJAMENTO')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
      menorPreco: catalogItemId(api, A, 'JUDGMENT_CRITERION', 'MENOR_PRECO'),
    };
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    documents.down = false;
    terms.down = false;
  });

  describe('[Sucesso]', () => {
    it('Concluir TR completo sem avisos: FINALIZED, versão FINALIZATION, DocumentFinalized (TermCompleted) e document.finalize', async () => {
      const setup = await background();
      const { process, term } = setup;
      await complete(setup);
      expect(await violationsOf(term.documentId)).toEqual([]);

      const { data: before, meta } = await documentNow(term.documentId);
      expect(meta.allowedActions).toContain('FINALIZE');
      expect(meta.allowedActions).not.toContain('SUBMIT');
      const response = await finalize(term.documentId, before.version);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const finalized = documentSchema.parse(data(response));
      expect(finalized).toMatchObject({
        status: 'FINALIZED',
        finalizedById: FAKE_USERS.lucia.id,
        finalizedAt: NOW.toISOString(),
      });

      const versions = versionsOf(term.documentId);
      expect(versions).toHaveLength(1);
      const [version] = versions;
      expect(version).toMatchObject({
        id: finalized.currentVersionId,
        versionNumber: 1,
        reason: 'FINALIZATION',
        statusAtCreation: 'FINALIZED',
      });
      // RN-TR-37: snapshot completo — cabeçalho tipado e itens com a especificação.
      expect(version?.content?.header).toMatchObject({
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '98000.00',
        selectionCriterionId: catalog.menorPreco,
        awardType: 'BY_ITEM',
        productWarrantyMonths: 12,
      });
      const items = version?.content?.collections.items as
        readonly Record<string, unknown>[] | undefined;
      expect(items?.map((item) => [item.sequence, item.quantity])).toEqual([
        [1, '100.0000'],
        [2, '20.0000'],
        [3, '40.0000'],
      ]);
      expect(items?.[0]).toHaveProperty('specification', null);
      expect(version?.contentHash).toBe(sha256Hex(canonicalJson(version?.content)));

      const typed = eventsOf(term.documentId).filter((row) =>
        ['DocumentFinalized', 'DocumentVersionCreated'].includes(row.eventType),
      );
      expect(typed.map((row) => `${row.eventType}:${row.routingKey}`)).toEqual([
        'DocumentVersionCreated:document.version_created.tr',
        'DocumentFinalized:document.finalized.tr',
      ]);
      expect(typed.at(-1)?.payload).toEqual({
        documentId: term.documentId,
        documentTypeCode: 'TR',
        documentVersionId: version?.id,
        typedSummary: {
          estimatedTotalValueMasked: false,
          itemsCount: 3,
          warningsAcknowledgedCount: 0,
        },
      });
      // Nunca o valor estimado no evento nem na auditoria.
      expect(JSON.stringify(typed)).not.toContain('98000');
      const [audit] = auditOf(term.documentId, 'document.finalize');
      expect(audit?.changes).toEqual([{ path: 'status', old: 'DRAFT', new: 'FINALIZED' }]);
      expect(audit?.metadata).toMatchObject({
        documentVersionId: version?.id,
        warningsAcknowledged: [],
        idempotencyKey: expect.any(String) as unknown,
      });
      expect(JSON.stringify(audit)).not.toContain('98000');
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === process.id)
          .map((row) => row.type),
      ).toContain('DOCUMENT_FINALIZED');

      // Edição bloqueada até a reabertura (POL-11).
      const after = await termOf(term.id);
      expect(after.data.status).toBe('FINALIZED');
      expect(after.meta.allowedActions).not.toContain('UPDATE');
      expectProblem(
        await patchTerm(term.id, { awardType: 'GLOBAL' }, after.data.version),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
    });

    it('Concluir reconhecendo o aviso de divergência com o ETP (item 3: 50 no TR × 40 no ETP)', async () => {
      const setup = await background();
      const { term, items } = setup;
      await complete(setup, { quantities: ['100', '20', '50'] });
      const violations = await violationsOf(term.documentId);
      const row = rowsOf(term.documentId).find((item) => item.processItemId === items[2]?.id);
      expect(violations).toEqual([
        {
          code: DIVERGENT,
          severity: 'WARNING',
          message: 'A quantidade do item 3 no TR (50) diverge da quantidade no ETP (40).',
          ruleId: null,
          sectionKey: null,
          field: 'items',
          itemId: row?.id,
          params: {
            etpQuantity: '40',
            trQuantity: '50',
            processItemId: items[2]?.id,
            sequence: 3,
          },
        },
      ]);

      const { data: before } = await documentNow(term.documentId);
      const response = await finalize(term.documentId, before.version, {
        acknowledgedWarnings: [DIVERGENT],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(documentSchema.parse(data(response)).status).toBe('FINALIZED');
      const [audit] = auditOf(term.documentId, 'document.finalize');
      expect(audit?.metadata).toMatchObject({
        warningsAcknowledged: [{ code: DIVERGENT, message: violations[0]?.message }],
      });
      const finalizedEvent = eventsOf(term.documentId).find(
        (event) => event.eventType === 'DocumentFinalized',
      );
      expect(finalizedEvent?.payload).toMatchObject({
        typedSummary: { warningsAcknowledgedCount: 1, itemsCount: 3 },
      });
    });

    it('FA-03: tipo TR com requiresApproval — "Submeter para aprovação" (DOC-09) leva a IN_REVIEW com DocumentSubmitted', async () => {
      const type = documentTypeRepositoryOf(api)
        .snapshot()
        .find((candidate) => candidate.tenantId === A && candidate.code === 'TR');
      if (!type) throw new Error('tipo TR ausente');
      documentTypeRepositoryOf(api).seed({
        ...type,
        requiresApproval: true,
        approvalPolicy: {
          approverType: 'USER',
          approverUserId: FAKE_USERS.marta.id,
          allowDeputy: false,
        },
      });
      try {
        const setup = await background();
        const { term } = setup;
        await complete(setup);
        const { data: before, meta } = await documentNow(term.documentId);
        expect(meta.allowedActions).toContain('SUBMIT');
        expect(meta.allowedActions).not.toContain('FINALIZE');
        // FINALIZE não vale para o tipo com aprovação avulsa.
        expect((await finalize(term.documentId, before.version)).status).toBeGreaterThanOrEqual(
          400,
        );
        const response = await conclude('submit', term.documentId, before.version);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(documentSchema.parse(data(response)).status).toBe('IN_REVIEW');
        expect(versionsOf(term.documentId)).toEqual([
          expect.objectContaining({ reason: 'SUBMISSION' }),
        ]);
        expect(
          eventsOf(term.documentId)
            .filter((row) =>
              ['DocumentSubmitted', 'DocumentVersionCreated'].includes(row.eventType),
            )
            .map((row) => `${row.eventType}:${row.routingKey}`),
        ).toEqual([
          'DocumentVersionCreated:document.version_created.tr',
          'DocumentSubmitted:document.submitted.tr',
        ]);
        expect(auditOf(term.documentId, 'document.submit')).toHaveLength(1);
        expect(auditOf(term.documentId, 'document.finalize')).toEqual([]);
      } finally {
        documentTypeRepositoryOf(api).seed(type);
      }
    });
  });

  describe('[Validação]', () => {
    it('DOC-08: TR recém-criado lista as pendências TR_* bloqueantes, as de seção e o aviso de garantia', async () => {
      const { term } = await background();
      const violations = await violationsOf(term.documentId);
      const codes = violations.map((item) => `${item.severity}:${item.code}`);
      expect(codes).toEqual(
        expect.arrayContaining([
          'BLOCKING:SECTION_REQUIRED',
          'BLOCKING:TR_ESTIMATED_VALUE_REQUIRED',
          'BLOCKING:TR_ITEMS_REQUIRED',
          'BLOCKING:TR_SELECTION_CRITERION_REQUIRED',
          'BLOCKING:TR_AWARD_TYPE_REQUIRED',
          `WARNING:${NO_GUARANTEE}`,
        ]),
      );
      // Bloqueantes antes dos avisos (api.md §2.1.2).
      expect(codes.at(-1)).toBe(`WARNING:${NO_GUARANTEE}`);
      // Sem itens no TR: nada a comparar com o ETP.
      expect(codes).not.toContain(`WARNING:${DIVERGENT}`);
    });

    it('Pendência bloqueante impede a conclusão: sem item com quantidade → 422 DOCUMENT_INCOMPLETE com TR_ITEMS_REQUIRED e o TR em DRAFT', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      expect((await putItems(term.documentId, [])).status).toBe(200);
      const { data: before } = await documentNow(term.documentId);
      const problem = expectProblem(
        await finalize(term.documentId, before.version),
        422,
        'DOCUMENT_INCOMPLETE',
      );
      expect(PROBLEM_VIOLATIONS.parse(problem).violations.map((item) => item.code)).toContain(
        'TR_ITEMS_REQUIRED',
      );
      expect(documentOf(term.documentId).status).toBe('DRAFT');
      expect(versionsOf(term.documentId)).toEqual([]);
      expect(auditOf(term.documentId, 'document.finalize')).toEqual([]);
    });

    it('RN-TR-35: valor MANUAL sem a seção do valor justificada → TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      const document = documentOf(term.documentId);
      const { ESTIMATED_VALUE: _removed, ...sections } = document.draftContent.sections;
      documentRepositoryOf(api).seed({ ...document, draftContent: { sections } });
      const violations = await violationsOf(term.documentId);
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED',
            sectionKey: 'ESTIMATED_VALUE',
            severity: 'BLOCKING',
          }),
        ]),
      );
    });

    it('FA-02/V-02: aviso não reconhecido → 422 WARNINGS_NOT_ACKNOWLEDGED; reconhecido, conclui', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup, { conditions: { productWarrantyMonths: null } });
      const violations = await violationsOf(term.documentId);
      expect(violations.map((item) => item.code)).toEqual([NO_GUARANTEE]);
      const { data: before } = await documentNow(term.documentId);
      const problem = expectProblem(
        await finalize(term.documentId, before.version),
        422,
        'WARNINGS_NOT_ACKNOWLEDGED',
      );
      expect(PROBLEM_VIOLATIONS.parse(problem).violations.map((item) => item.code)).toEqual([
        NO_GUARANTEE,
      ]);
      // Reconhecer outro código não basta.
      expectProblem(
        await finalize(term.documentId, before.version, { acknowledgedWarnings: [DIVERGENT] }),
        422,
        'WARNINGS_NOT_ACKNOWLEDGED',
      );
      expect(documentOf(term.documentId).status).toBe('DRAFT');
      const done = await finalize(term.documentId, before.version, {
        acknowledgedWarnings: [NO_GUARANTEE],
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    });

    it('RN-TR-36: com o ETP ainda em DRAFT não há aviso de divergência', async () => {
      const setup = await background({ etpStatus: 'DRAFT' });
      await complete(setup, { quantities: ['1', '2', '3'] });
      expect(await violationsOf(setup.term.documentId)).toEqual([]);
    });

    it('Edição concorrente entre a consulta e o clique: a finalização revalida o estado atual (422, sem versão)', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      expect(await violationsOf(term.documentId)).toEqual([]);
      const { data: before } = await documentNow(term.documentId);
      // Outra aba retira o tipo de adjudicação (TRM-04 não muda a versão do documento).
      const { data: current } = await termOf(term.id);
      expect((await patchTerm(term.id, { awardType: null }, current.version)).status).toBe(200);
      const problem = expectProblem(
        await finalize(term.documentId, before.version),
        422,
        'DOCUMENT_INCOMPLETE',
      );
      expect(PROBLEM_VIOLATIONS.parse(problem).violations.map((item) => item.code)).toEqual([
        'TR_AWARD_TYPE_REQUIRED',
      ]);
      expect(versionsOf(term.documentId)).toEqual([]);
    });

    it('V-03/V-06: TR já concluído → 409; sem If-Match → 428 PRECONDITION_REQUIRED', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      expectProblem(await finalize(term.documentId, null), 428, 'PRECONDITION_REQUIRED');
      const { data: before } = await documentNow(term.documentId);
      expect((await finalize(term.documentId, before.version)).status).toBe(200);
      const { data: after } = await documentNow(term.documentId);
      // O DOC-10 genérico (US-065) recusa a transição de FINALIZED com 409 `INVALID_STATE`.
      const again = await finalize(term.documentId, after.version);
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(versionsOf(term.documentId)).toHaveLength(1);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem TERM_SUBMIT: sem FINALIZE em allowedActions e 403 PERMISSION_DENIED com access.denied', async () => {
      const setup = await background();
      const { process, term } = setup;
      await complete(setup);
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'OBSERVER',
      });
      const { data: doc, meta } = await documentNow(term.documentId, BRUNO);
      expect(meta.allowedActions).not.toContain('FINALIZE');
      expectProblem(
        await finalize(term.documentId, doc.version, { subject: BRUNO }),
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
              row.reasonCode === 'TERM_SUBMIT',
          ),
      ).toBe(true);
      expect(documentOf(term.documentId).status).toBe('DRAFT');
    });

    it('POL-01/02: TERM_SUBMIT sem custódia nem participação → 403; como COLLABORATOR conclui', async () => {
      const setup = await background();
      const { process, term } = setup;
      await complete(setup);
      const { data: doc } = await documentNow(term.documentId);
      const refused = await finalize(term.documentId, doc.version, { subject: ANA });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(documentOf(term.documentId).status).toBe('DRAFT');
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const done = await finalize(term.documentId, doc.version, { subject: ANA });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Concluir TR de outro tenant: 404 NOT_FOUND (DOC-08 e DOC-10)', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      const { data: doc } = await documentNow(term.documentId);
      expectProblem(
        await finalize(term.documentId, doc.version, { subject: FABIO, tenant: B }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await auth(
          request(api.server).get(`/api/v1/documents/${term.documentId}/validation`),
          FABIO,
          B,
        ),
        404,
        'NOT_FOUND',
      );
      expect(documentOf(term.documentId).status).toBe('DRAFT');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da conclusão com a mesma chave: 200, Idempotent-Replayed e uma única versão FINALIZATION', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      const { data: doc } = await documentNow(term.documentId);
      // A "K2" do Gherkin: a chave é um UUID (convenção de api.md §2).
      const key = randomUUID();
      const first = await finalize(term.documentId, doc.version, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await finalize(term.documentId, doc.version, { key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(versionsOf(term.documentId)).toHaveLength(1);
      expect(auditOf(term.documentId, 'document.finalize')).toHaveLength(1);
      expectProblem(
        await finalize(term.documentId, doc.version, { key, acknowledgedWarnings: [DIVERGENT] }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Carla conclui com If-Match antigo depois de outra pessoa editar os itens: 412 VERSION_CONFLICT', async () => {
      const setup = await background();
      const { process, term, items } = setup;
      await complete(setup);
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const { data: loaded } = await documentNow(term.documentId);
      const edited = await putItems(
        term.documentId,
        items.map((item, index) => ({
          processItemId: item.id,
          quantity: ['100', '20', '40'][index],
          notes: 'Entrega parcelada',
          sortOrder: index,
        })),
        ANA,
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(documentOf(term.documentId).version).toBe(loaded.version + 1);
      expectProblem(await finalize(term.documentId, loaded.version), 412, 'VERSION_CONFLICT');
      expect(documentOf(term.documentId).status).toBe('DRAFT');
    });

    it('Duas conclusões simultâneas com o mesmo If-Match: uma 200 e a outra 412', async () => {
      const setup = await background();
      const { process, term } = setup;
      await complete(setup);
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const { data: doc } = await documentNow(term.documentId);
      const [one, two] = await Promise.all([
        finalize(term.documentId, doc.version),
        finalize(term.documentId, doc.version, { subject: ANA }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
      const loser = one.status === 412 ? one : two;
      expect(problemDetailsSchema.parse(loser.body).code).toBe('VERSION_CONFLICT');
      expect(versionsOf(term.documentId)).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao concluir: 503 DEPENDENCY_UNAVAILABLE e o TR em DRAFT sem versão', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      const { data: doc } = await documentNow(term.documentId);
      documents.down = true;
      expectProblem(await finalize(term.documentId, doc.version), 503, 'DEPENDENCY_UNAVAILABLE');
      documents.down = false;
      expect(documentOf(term.documentId).status).toBe('DRAFT');
      expect(versionsOf(term.documentId)).toEqual([]);
      expect(auditOf(term.documentId, 'document.finalize')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200, FINALIZED e o DocumentFinalized gravado para publicação posterior', async () => {
      const setup = await background();
      const { term } = setup;
      await complete(setup);
      const { data: doc } = await documentNow(term.documentId);
      const response = await finalize(term.documentId, doc.version);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(documentOf(term.documentId).status).toBe('FINALIZED');
      // Sem relay no teste: o evento fica no outbox (PENDING no PostgreSQL — tenant-leak).
      expect(
        eventsOf(term.documentId).filter((row) => row.eventType === 'DocumentFinalized'),
      ).toHaveLength(1);
    });
  });
});

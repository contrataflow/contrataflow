import { randomUUID } from 'node:crypto';

import {
  documentSchema,
  documentMetaSchema,
  etpAlternativeSchema,
  etpDetailMetaSchema,
  etpDetailSchema,
  etpSchema,
  problemDetailsSchema,
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
  documentRepositoryOf,
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
import { ETP_CLOCK, ETP_TRANSACTIONS } from '../application/ports.js';

/*
 * US-023 — Validar completude do ETP e concluí-lo, pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade
 * fake, os seeders reais (template ETP da biblioteca padrão) e o ETP do ETP-02 no processo levado
 * aos estudos preliminares: ETP-04 (conclusão e parcelamento), DOC-08 (pendências genéricas + as
 * do `EtpDocumentValidator`) e DOC-10 (finalização com revalidação na mesma transação) nas 8
 * categorias do Gherkin + FA-03/FA-04 e V-03..V-09. Lúcia (PLANEJAMENTO, custódia) é a "Ana" do
 * Gherkin; Otávio (SOMENTE_LEITURA) é o "Bruno"; Ana (REQUISITANTE, participante COLLABORATOR) é o
 * "Carlos". RLS e o outbox PENDING no PostgreSQL: `test/tenant-leak/etp-conclusion.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const LUCIA = 'sub-lucia';
const OTAVIO = 'sub-otavio';
const ANA = 'sub-ana';
/** Usuário da Prefeitura B. */
const FABIO = 'sub-fabio';

const UNITS_A = {
  organizationId: '0192d023-0000-7000-8000-0000000000a0',
  obras: '0192d023-0000-7000-8000-0000000000a1',
  manutencao: '0192d023-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d023-0000-7000-8000-0000000000a3',
  saude: '0192d023-0000-7000-8000-0000000000a4',
  posto: '0192d023-0000-7000-8000-0000000000a5',
};

const NOT_VIABLE = 'ETP_NOT_VIABLE_CONCLUSION';
const SECTION_TEXT =
  'Texto do estudo técnico preliminar elaborado pela equipe de planejamento, com fundamentação suficiente para a seção, conforme o art. 18 da Lei 14.133/2021 e a IN SEGES/ME 58/2022, sem lacunas pendentes.';

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
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

const ETP_RESPONSE = z.object({ data: etpDetailSchema, meta: etpDetailMetaSchema });
const DOCUMENT_RESPONSE = z.object({ data: documentSchema, meta: documentMetaSchema });
const VIOLATIONS = z.object({ data: z.object({ violations: z.array(violationSchema) }) });
const PROBLEM_VIOLATIONS = z.looseObject({ violations: z.array(violationSchema) });

describe('Feature: Validar completude do ETP e concluí-lo (US-023)', () => {
  let api: TestApi;
  const documents = new FlakyTransactions();
  const etps = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; un: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = LUCIA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const patchEtp = (
    id: string,
    body: Record<string, unknown>,
    options: { ifMatch: number; subject?: string; tenant?: string },
  ) =>
    auth(request(api.server).patch(`/api/v1/etps/${id}`), options.subject, options.tenant)
      .set('If-Match', `"${String(options.ifMatch)}"`)
      .send(body);
  const validation = (documentId: string, subject = LUCIA) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/validation`), subject);
  const getDocument = (documentId: string, subject = LUCIA) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}`), subject);
  const finalize = (
    documentId: string,
    version: number,
    options: {
      key?: string;
      subject?: string;
      tenant?: string;
      acknowledgedWarnings?: string[];
    } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/documents/${documentId}/finalize`),
      options.subject,
      options.tenant,
    )
      .set('If-Match', `"${String(version)}"`)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(
        options.acknowledgedWarnings === undefined
          ? {}
          : { acknowledgedWarnings: options.acknowledgedWarnings },
      );

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
  const stageId = (process: Process, key: string) =>
    workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === key && candidate.workflowVersionId === process.workflowVersionId,
    )?.id ?? null;

  async function itemOk(processId: string, body: Record<string, unknown>) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/items`),
      ANA,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', unitOfMeasureId: catalog.un, ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessItemDto>(response);
  }

  async function etpOf(id: string, subject = LUCIA) {
    const response = await auth(request(api.server).get(`/api/v1/etps/${id}`), subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return ETP_RESPONSE.parse(response.body);
  }

  async function violationsOf(documentId: string, subject = LUCIA) {
    const response = await validation(documentId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return VIOLATIONS.parse(response.body).data.violations;
  }

  /** Todas as seções do template preenchidas (o trabalho da US-020), direto no rascunho. */
  async function fillSections(etpId: string) {
    const { meta } = await etpOf(etpId);
    const document = documentOf(etpId);
    const sections = { ...document.draftContent.sections };
    for (const section of meta.template?.sections ?? []) {
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

  /** Alternativa recomendada (ETP-06 + ETP-09 — US-021). */
  async function recommendAlternative(etpId: string) {
    const created = await auth(request(api.server).post(`/api/v1/etps/${etpId}/alternatives`))
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Aquisição direta ${words(1)}`,
        description: paragraph('Compra dos materiais'),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const alternative = etpAlternativeSchema.parse(data(created));
    const decided = await auth(
      request(api.server).post(`/api/v1/etp-alternatives/${alternative.id}/decide`),
    )
      .set('If-Match', `"${String(alternative.version)}"`)
      .send({
        decision: 'RECOMMENDED',
        decisionJustification: 'Menor custo total e prazo compatível com a obra.',
      });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return etpAlternativeSchema.parse(data(decided));
  }

  async function patchOk(etpId: string, body: Record<string, unknown>) {
    const { data: current } = await etpOf(etpId);
    const response = await patchEtp(etpId, body, { ifMatch: current.version });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return ETP_RESPONSE.parse(response.body);
  }

  async function documentVersion(documentId: string, subject = LUCIA) {
    const response = await getDocument(documentId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return DOCUMENT_RESPONSE.parse(response.body);
  }

  /**
   * Background: processo "0012/2026" (PRC-02, Ana) com 2 itens, nos estudos preliminares sob
   * custódia da Lúcia, e o ETP (ETP-02) em DRAFT com os 2 itens com quantidade. `ready`: seções
   * preenchidas, parcelamento definido, alternativa recomendada e valor estimado R$ 125.000,00 —
   * falta só a conclusão.
   */
  async function background(options: { ready?: boolean } = {}) {
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
    const cement = await itemOk(processId, { description: 'Cimento CP-II (saco 50kg)' });
    const sand = await itemOk(processId, { description: 'Areia média (m³)' });
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === processId);
    if (!created) throw new Error('processo ausente');
    const process = {
      ...created,
      status: 'IN_PROGRESS' as const,
      currentWorkflowStageId: stageId(created, 'ESTUDOS_PRELIMINARES'),
      currentResponsibleId: FAKE_USERS.lucia.id,
    };
    processRepositoryOf(api).replace(process);
    const etpResponse = await auth(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
    const etp = etpSchema.parse(data(etpResponse));
    const items = await auth(request(api.server).put(`/api/v1/documents/${etp.documentId}/items`))
      .set('If-Match', `"${String(etp.documentVersion)}"`)
      .send({
        items: [
          { processItemId: cement.id, quantity: '400' },
          { processItemId: sand.id, quantity: '12' },
        ],
      });
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    if (options.ready === true) {
      await fillSections(etp.id);
      await recommendAlternative(etp.id);
      await patchOk(etp.id, {
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '125000.00',
        parcelingDecision: 'NOT_PARCELED',
      });
    }
    return { process, etp };
  }

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
    it('Concluir ETP viável com todas as pendências resolvidas: FINALIZED, versão 1, DocumentFinalized e document.finalize', async () => {
      const { process, etp } = await background({ ready: true });
      const concluded = await patchOk(etp.id, { conclusion: 'VIABLE' });
      expect(concluded.data).toMatchObject({
        conclusion: 'VIABLE',
        parcelingDecision: 'NOT_PARCELED',
      });
      expect(await violationsOf(etp.documentId)).toEqual([]);

      const { data: before } = await documentVersion(etp.documentId);
      const response = await finalize(etp.documentId, before.version);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const finalized = documentSchema.parse(data(response));
      expect(finalized).toMatchObject({
        status: 'FINALIZED',
        finalizedById: FAKE_USERS.lucia.id,
        finalizedAt: NOW.toISOString(),
      });

      const versions = versionsOf(etp.documentId);
      expect(versions).toHaveLength(1);
      const [version] = versions;
      expect(version).toMatchObject({
        id: finalized.currentVersionId,
        versionNumber: 1,
        reason: 'FINALIZATION',
        statusAtCreation: 'FINALIZED',
      });
      // RN-ETP-38: o snapshot congela o cabeçalho, os itens e as alternativas do momento.
      expect(version?.content?.header).toMatchObject({
        conclusion: 'VIABLE',
        parcelingDecision: 'NOT_PARCELED',
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '125000.00',
      });
      expect(version?.content?.collections.items).toHaveLength(2);
      expect(version?.content?.collections.alternatives).toEqual([
        expect.objectContaining({ decision: 'RECOMMENDED' }),
      ]);
      expect(version?.contentHash).toBe(sha256Hex(canonicalJson(version?.content)));

      expect(
        eventsOf(etp.documentId)
          .filter((row) => ['DocumentFinalized', 'DocumentVersionCreated'].includes(row.eventType))
          .map((row) => `${row.eventType}:${row.routingKey}`),
      ).toEqual([
        'DocumentVersionCreated:document.version_created.etp',
        'DocumentFinalized:document.finalized.etp',
      ]);
      // Sem `typedSummary` para o ETP (não definido no catálogo de eventos).
      expect(eventsOf(etp.documentId).at(-1)?.payload).toEqual({
        documentId: etp.documentId,
        documentTypeCode: 'ETP',
        documentVersionId: version?.id,
      });
      const [audit] = auditOf(etp.documentId, 'document.finalize');
      expect(audit?.changes).toEqual([{ path: 'status', old: 'DRAFT', new: 'FINALIZED' }]);
      expect(audit?.metadata).toMatchObject({ warningsAcknowledged: [] });
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === process.id)
          .map((row) => row.type),
      ).toContain('DOCUMENT_FINALIZED');
      // RN-ETP-39: nenhuma aprovação aberta por este card.
      expect(eventsOf(etp.documentId).map((row) => row.eventType)).not.toContain(
        'ApprovalRequested',
      );

      // RN-ETP-38: edição bloqueada depois de concluído.
      expectProblem(
        await patchEtp(etp.id, { conclusion: 'NOT_VIABLE' }, { ifMatch: concluded.data.version }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect((await etpOf(etp.id)).meta.allowedActions).not.toContain('UPDATE');
    });

    it('Concluir ETP não viável após reconhecer o aviso: FINALIZED e o aviso na auditoria', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'NOT_VIABLE' });
      const violations = await violationsOf(etp.documentId);
      expect(violations).toEqual([
        expect.objectContaining({
          code: NOT_VIABLE,
          severity: 'WARNING',
          field: 'conclusion',
          message: 'Este ETP conclui pela não viabilidade da contratação',
        }),
      ]);
      const { data: before } = await documentVersion(etp.documentId);
      const response = await finalize(etp.documentId, before.version, {
        acknowledgedWarnings: [NOT_VIABLE],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(documentSchema.parse(data(response)).status).toBe('FINALIZED');
      const [audit] = auditOf(etp.documentId, 'document.finalize');
      expect(audit?.metadata).toMatchObject({
        warningsAcknowledged: [
          { code: NOT_VIABLE, message: 'Este ETP conclui pela não viabilidade da contratação' },
        ],
      });
    });

    it('ETP-04: conclusão e parcelamento sem estimativa, sem POL-09, auditados com os valores anterior e novo', async () => {
      const { etp } = await background();
      const response = await patchEtp(
        etp.id,
        { conclusion: 'VIABLE', parcelingDecision: 'PARCELED' },
        { ifMatch: etp.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(`"${String(etp.version + 1)}"`);
      expect(ETP_RESPONSE.parse(response.body).data).toMatchObject({
        conclusion: 'VIABLE',
        parcelingDecision: 'PARCELED',
        estimatedValueSource: null,
        version: etp.version + 1,
      });
      const audit = auditOf(etp.documentId, 'document.draft_update').at(-1);
      expect(audit?.changes).toEqual([
        { path: 'conclusion', old: 'PENDING', new: 'VIABLE' },
        { path: 'parcelingDecision', old: null, new: 'PARCELED' },
      ]);
      expect(audit?.metadata).toMatchObject({
        target: 'HEADER',
        fields: ['conclusion', 'parcelingDecision'],
        conclusion: 'VIABLE',
        parcelingDecision: 'PARCELED',
      });
      // Reenvio igual: 200 sem versão nova nem auditoria.
      const count = auditOf(etp.documentId, 'document.draft_update').length;
      const again = await patchEtp(etp.id, { conclusion: 'VIABLE' }, { ifMatch: etp.version + 1 });
      expect(again.status).toBe(200);
      expect(again.headers.etag).toBe(`"${String(etp.version + 1)}"`);
      expect(auditOf(etp.documentId, 'document.draft_update')).toHaveLength(count);
    });

    it('ETP-04: estimativa e conclusão juntas sobem uma versão só', async () => {
      const { etp } = await background();
      const response = await patchEtp(
        etp.id,
        { estimatedValueSource: 'MANUAL', estimatedTotalValue: '10.00', conclusion: 'NOT_VIABLE' },
        { ifMatch: etp.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(ETP_RESPONSE.parse(response.body).data).toMatchObject({
        estimatedTotalValue: '10.00',
        conclusion: 'NOT_VIABLE',
        version: etp.version + 1,
      });
    });
  });

  describe('[Validação]', () => {
    it('DOC-08: ETP recém-criado lista seções, conclusão, parcelamento (e nada de itens — já têm quantidade)', async () => {
      const { etp } = await background();
      const violations = await violationsOf(etp.documentId);
      const codes = violations.map((item) => `${item.code}:${item.field ?? item.sectionKey ?? ''}`);
      expect(codes).toContain('FIELD_REQUIRED:conclusion');
      expect(codes).toContain('FIELD_REQUIRED:parcelingDecision');
      expect(codes.some((code) => code.startsWith('SECTION_REQUIRED:'))).toBe(true);
      expect(codes).not.toContain('ITEMS_REQUIRED:items');
      // Sem conclusão definida, as regras de VIABLE não se aplicam ainda (RN-ETP-35).
      expect(codes).not.toContain('ETP_RECOMMENDED_ALTERNATIVE_REQUIRED:recommendedAlternativeId');
      expect(violations.find((item) => item.field === 'conclusion')?.message).toBe(
        'Defina a conclusão do ETP (viável ou não viável).',
      );
    });

    it('Tentar concluir sem alternativa recomendada: 422 DOCUMENT_INCOMPLETE com ETP_RECOMMENDED_ALTERNATIVE_REQUIRED e o ETP em DRAFT', async () => {
      const { etp } = await background();
      await fillSections(etp.id);
      await patchOk(etp.id, {
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '125000.00',
        parcelingDecision: 'NOT_PARCELED',
        conclusion: 'VIABLE',
      });
      const { data: before } = await documentVersion(etp.documentId);
      const problem = expectProblem(
        await finalize(etp.documentId, before.version),
        422,
        'DOCUMENT_INCOMPLETE',
      );
      expect(PROBLEM_VIOLATIONS.parse(problem).violations).toEqual([
        expect.objectContaining({
          code: 'ETP_RECOMMENDED_ALTERNATIVE_REQUIRED',
          severity: 'BLOCKING',
          message: 'Defina a alternativa recomendada antes de concluir.',
        }),
      ]);
      expect(documentOf(etp.documentId).status).toBe('DRAFT');
      expect(versionsOf(etp.documentId)).toEqual([]);
    });

    it('V-07/V-05: VIABLE sem valor estimado e sem itens com quantidade', async () => {
      const { etp } = await background();
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      const { data: doc } = await documentVersion(etp.documentId);
      const cleared = await auth(
        request(api.server).put(`/api/v1/documents/${etp.documentId}/items`),
      )
        .set('If-Match', `"${String(doc.version)}"`)
        .send({ items: [] });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      const codes = (await violationsOf(etp.documentId)).map((item) => item.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          'ITEMS_REQUIRED',
          'ETP_ESTIMATED_VALUE_REQUIRED',
          'ETP_RECOMMENDED_ALTERNATIVE_REQUIRED',
        ]),
      );
    });

    it('Tentar concluir sem reconhecer o aviso de não viabilidade: 422 WARNINGS_NOT_ACKNOWLEDGED', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'NOT_VIABLE' });
      const { data: before } = await documentVersion(etp.documentId);
      const problem = expectProblem(
        await finalize(etp.documentId, before.version),
        422,
        'WARNINGS_NOT_ACKNOWLEDGED',
      );
      expect(PROBLEM_VIOLATIONS.parse(problem).violations.map((item) => item.code)).toEqual([
        NOT_VIABLE,
      ]);
      expect(documentOf(etp.documentId).status).toBe('DRAFT');
    });

    it('ETP-04: conclusão PENDING ou parcelamento desconhecido → 422 VALIDATION_ERROR', async () => {
      const { etp } = await background();
      expectProblem(
        await patchEtp(etp.id, { conclusion: 'PENDING' }, { ifMatch: etp.version }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await patchEtp(etp.id, { parcelingDecision: 'TALVEZ' }, { ifMatch: etp.version }),
        422,
        'VALIDATION_ERROR',
      );
      expect((await etpOf(etp.id)).data.conclusion).toBe('PENDING');
    });

    it('FA-03: pendência surgida entre a consulta e o clique — a finalização usa o estado atual', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      expect(await violationsOf(etp.documentId)).toEqual([]);
      // Entre a consulta e o clique, Ana ("Carlos", colaboradora) descarta a alternativa recomendada.
      seedParticipant(api, {
        tenantId: A,
        processId: etp.processId,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const listed = await auth(request(api.server).get(`/api/v1/etps/${etp.id}/alternatives`));
      const [recommended] = z.array(etpAlternativeSchema).parse(data(listed));
      if (!recommended) throw new Error('alternativa ausente');
      const changed = await auth(
        request(api.server).post(`/api/v1/etp-alternatives/${recommended.id}/decide`),
        ANA,
      )
        .set('If-Match', `"${String(recommended.version)}"`)
        .send({
          decision: 'DISCARDED',
          decisionJustification: 'Fornecedor único deixou de atender a região.',
        });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);

      const { data: before } = await documentVersion(etp.documentId);
      const problem = expectProblem(
        await finalize(etp.documentId, before.version),
        422,
        'DOCUMENT_INCOMPLETE',
      );
      expect(PROBLEM_VIOLATIONS.parse(problem).violations.map((item) => item.code)).toContain(
        'ETP_RECOMMENDED_ALTERNATIVE_REQUIRED',
      );
      expect(documentOf(etp.documentId).status).toBe('DRAFT');
    });

    it('FA-04/V-09: processo fora de status editável ou ETP já concluído bloqueiam a conclusão (409)', async () => {
      const { process, etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      const { data: before } = await documentVersion(etp.documentId);
      const current = processRepositoryOf(api)
        .allProcesses()
        .find((candidate) => candidate.id === process.id);
      if (!current) throw new Error('processo ausente');
      processRepositoryOf(api).replace({ ...current, status: 'SUSPENDED' });
      const suspended = await finalize(etp.documentId, before.version);
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(409);
      expect(documentOf(etp.documentId).status).toBe('DRAFT');

      processRepositoryOf(api).replace({ ...current, status: 'IN_PROGRESS' });
      expect((await finalize(etp.documentId, before.version)).status).toBe(200);
      const again = await finalize(etp.documentId, before.version + 1);
      expect(again.status, JSON.stringify(again.body)).toBe(409);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem ETP_SUBMIT: sem FINALIZE em allowedActions e 403 PERMISSION_DENIED com access.denied', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      seedParticipant(api, {
        tenantId: A,
        processId: etp.processId,
        userId: FAKE_USERS.otavio.id,
        role: 'OBSERVER',
      });
      const { data: doc, meta } = await documentVersion(etp.documentId, OTAVIO);
      expect(meta.allowedActions).not.toContain('FINALIZE');
      expect((await documentVersion(etp.documentId)).meta.allowedActions).toContain('FINALIZE');
      expectProblem(
        await finalize(etp.documentId, doc.version, { subject: OTAVIO }),
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
              row.reasonCode === 'ETP_SUBMIT',
          ),
      ).toBe(true);
      expect(documentOf(etp.documentId).status).toBe('DRAFT');
    });

    it('ETP_SUBMIT sem custódia nem participação: 403 e o ETP em DRAFT', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      const { data: doc } = await documentVersion(etp.documentId);
      const response = await finalize(etp.documentId, doc.version, { subject: ANA });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(documentOf(etp.documentId).status).toBe('DRAFT');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Finalizar ETP de outro tenant: 404 NOT_FOUND (e o ETP-04 também)', async () => {
      const { etp } = await background({ ready: true });
      const { data: doc } = await documentVersion(etp.documentId);
      expectProblem(
        await finalize(etp.documentId, doc.version, { subject: FABIO, tenant: B }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await patchEtp(etp.id, { conclusion: 'VIABLE' }, { ifMatch: 1, subject: FABIO, tenant: B }),
        404,
        'NOT_FOUND',
      );
      expect(documentOf(etp.documentId).status).toBe('DRAFT');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da finalização com a mesma chave: 200, Idempotent-Replayed e uma única versão', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      const { data: doc } = await documentVersion(etp.documentId);
      const key = randomUUID();
      const first = await finalize(etp.documentId, doc.version, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await finalize(etp.documentId, doc.version, { key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(versionsOf(etp.documentId)).toHaveLength(1);
      expect(auditOf(etp.documentId, 'document.finalize')).toHaveLength(1);
      // Mesma chave com outro corpo: 422 IDEMPOTENCY_KEY_REUSED.
      expectProblem(
        await finalize(etp.documentId, doc.version, { key, acknowledgedWarnings: [NOT_VIABLE] }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Duas tentativas de concluir simultâneas com o mesmo If-Match: uma 200 e a outra 412 VERSION_CONFLICT', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      seedParticipant(api, {
        tenantId: A,
        processId: etp.processId,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const { data: doc } = await documentVersion(etp.documentId);
      const [one, two] = await Promise.all([
        finalize(etp.documentId, doc.version),
        finalize(etp.documentId, doc.version, { subject: ANA }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
      const loser = one.status === 412 ? one : two;
      expect(problemDetailsSchema.parse(loser.body).code).toBe('VERSION_CONFLICT');
      expect(versionsOf(etp.documentId)).toHaveLength(1);
      expect(documentOf(etp.documentId).status).toBe('FINALIZED');
    });

    it('ETP-04 com If-Match desatualizado: 412 VERSION_CONFLICT com currentVersion', async () => {
      const { etp } = await background();
      await patchOk(etp.id, { parcelingDecision: 'NOT_APPLICABLE' });
      const problem = expectProblem(
        await patchEtp(etp.id, { conclusion: 'VIABLE' }, { ifMatch: etp.version }),
        412,
        'VERSION_CONFLICT',
      );
      expect((problem as unknown as { currentVersion: number }).currentVersion).toBe(
        etp.version + 1,
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante a finalização: 503 DEPENDENCY_UNAVAILABLE, ETP em DRAFT sem versão', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      const { data: doc } = await documentVersion(etp.documentId);
      documents.down = true;
      expectProblem(await finalize(etp.documentId, doc.version), 503, 'DEPENDENCY_UNAVAILABLE');
      documents.down = false;
      expect(documentOf(etp.documentId).status).toBe('DRAFT');
      expect(versionsOf(etp.documentId)).toEqual([]);
      expect(auditOf(etp.documentId, 'document.finalize')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200, FINALIZED e o DocumentFinalized gravado para publicação posterior', async () => {
      const { etp } = await background({ ready: true });
      await patchOk(etp.id, { conclusion: 'VIABLE' });
      const { data: doc } = await documentVersion(etp.documentId);
      const response = await finalize(etp.documentId, doc.version);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(documentOf(etp.documentId).status).toBe('FINALIZED');
      // Sem relay no teste: o evento fica no outbox (PENDING no PostgreSQL — tenant-leak).
      expect(
        eventsOf(etp.documentId).filter((row) => row.eventType === 'DocumentFinalized'),
      ).toHaveLength(1);
    });
  });
});

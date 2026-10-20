import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  richTextFromPlainText,
  termDetailMetaSchema,
  termDetailSchema,
  termListMetaSchema,
  termMetaSchema,
  termSchema,
  termSummarySchema,
} from '@contrataflow/validation';
import type { ProcessDto, TermDetailDto, TermDto } from '@contrataflow/validation';
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
  documentRepositoryOf,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import { seedPriceResearch } from '../../../../test/support/price-research-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  numberSequencesOf,
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
import { InMemoryTermRepository } from '../infrastructure/term.repositories.js';

/*
 * US-036 — Criar TR e editar suas seções, pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * autorização, `Idempotency-Key`, `If-Match`, filtro RFC 9457) com a identidade fake, os seeders
 * reais (catálogo, perfis, tipos de documento, biblioteca de templates e o workflow padrão) e o
 * processo do PRC-02 levado à etapa TERMO_REFERENCIA. As 8 categorias do Gherkin: TRM-01..04 e as
 * seções pelo DOC-05. Lúcia ("Paula") recebe PLANEJAMENTO e a custódia; Marta ("André") recebe só
 * LICITACOES; Ana (REQUISITANTE, com TERM_CREATE) não tem a custódia; Otávio ("Bruno") é o
 * participante CONSULTANT. A pesquisa de preços "PP 0002/2026" é semeada FINALIZED com o total
 * (a conclusão é da US-032). Atomicidade com numeração, índice único, RLS e FKs compostas no
 * PostgreSQL: `test/tenant-leak/terms.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-19T15:00:00.000Z');
const SEQUENCE = (year = 2026) => `DOCUMENT:TR:*:${String(year)}`;
const PAULA = 'sub-lucia';
const ANDRE = 'sub-marta';
const BRUNO = 'sub-otavio';
const JUSTIFICATION = 'O serviço é prestado integralmente de forma remota.';

const TR_SECTIONS = [
  'OBJECT',
  'JUSTIFICATION',
  'SPECIFICATIONS',
  'ACCEPTANCE_CRITERIA',
  'CONTRACTOR_OBLIGATIONS',
  'CONTRACTING_PARTY_OBLIGATIONS',
  'DEADLINES',
  'DELIVERY',
  'PAYMENT',
  'OVERSIGHT',
  'GUARANTEES',
  'SANCTIONS',
  'SELECTION_CRITERIA',
  'ESTIMATED_VALUE',
  'BUDGET_ADEQUACY',
];

const UNITS_A = {
  organizationId: '0192d036-0000-7000-8000-0000000000a0',
  obras: '0192d036-0000-7000-8000-0000000000a1',
  manutencao: '0192d036-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d036-0000-7000-8000-0000000000a3',
  saude: '0192d036-0000-7000-8000-0000000000a4',
  posto: '0192d036-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as do módulo) que podem simular o banco fora do ar. */
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

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

describe('Feature: Criar TR e editar suas seções (US-036)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = PAULA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const createTerm = (
    processId: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/terms`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const listTerms = (processId: string, subject = PAULA, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/terms`), subject, tenant);
  const getTerm = (id: string, subject = PAULA, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/terms/${id}`), subject, tenant);
  const patchTerm = (
    id: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string | null; subject?: string; tenant?: string } = {},
  ) => {
    const call = auth(
      request(api.server).patch(`/api/v1/terms/${id}`),
      options.subject,
      options.tenant,
    );
    return (options.ifMatch === null ? call : call.set('If-Match', options.ifMatch ?? '"1"')).send(
      body,
    );
  };
  const putSection = (
    documentId: string,
    sectionKey: string,
    body: Record<string, unknown>,
    options: { ifMatch: string; subject?: string; tenant?: string },
  ) =>
    auth(
      request(api.server).put(`/api/v1/documents/${documentId}/sections/${sectionKey}`),
      options.subject,
      options.tenant,
    )
      .set('If-Match', options.ifMatch)
      .send(body);
  const validationOf = (documentId: string) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/validation`));

  const termsOf = (processId: string) =>
    api.app
      .get(InMemoryTermRepository, { strict: false })
      .snapshot()
      .filter((term) => term.processId === processId);
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const documentOf = (id: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((document) => document.id === id);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const lastNumber = () => numberSequencesOf(api).valueOf(A, SEQUENCE());
  const typeOf = (code: string, tenantId: string = A) =>
    documentTypeRepositoryOf(api)
      .snapshot()
      .find((type) => type.tenantId === tenantId && type.code === code);
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
  const etag = (revision: number) => `"s${String(revision)}"`;

  /** Processo criado pelo PRC-02 (Ana), levado à etapa TERMO_REFERENCIA sob custódia de Paula. */
  async function background(fields: Partial<Process> = {}) {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana')
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Notebooks ${words(2)}`,
        object: `Aquisição de notebooks para as escolas municipais ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        priority: 'MEDIUM',
        pcaStatus: 'NOT_APPLICABLE',
        // Os títulos aleatórios às vezes caem na detecção de duplicidade (US-003): fora do escopo.
        confirmDuplicate: true,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    return moveTo(created, {
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId(created, 'TERMO_REFERENCIA'),
      currentResponsibleId: FAKE_USERS.lucia.id,
      ...fields,
    });
  }

  /** Pesquisa de preços "PP 0002/2026" do processo com o documento no status dado e o total. */
  function seedResearch(
    process: Process,
    options: { status?: 'DRAFT' | 'FINALIZED' | 'APPROVED'; total?: string | null } = {},
  ) {
    const type = typeOf('PRICE_RESEARCH');
    const id = newId();
    const document = buildDocument({
      id,
      tenantId: process.tenantId,
      processId: process.id,
      documentTypeId: type?.id ?? newId(),
      code: 'PP 0002/2026',
      title: 'Pesquisa de preços — notebooks',
      status: options.status ?? 'FINALIZED',
      singletonKey: type?.id ?? null,
    });
    documentRepositoryOf(api).seed(document);
    seedPriceResearch(api, {
      id,
      tenantId: process.tenantId,
      processId: process.id,
      totalEstimatedValue: options.total === undefined ? '98000.00' : options.total,
      completedAt: options.status === 'DRAFT' ? null : NOW,
      now: NOW,
    });
    return { id, code: 'PP 0002/2026' };
  }

  async function createOk(processId: string, body: Record<string, unknown> = {}) {
    const response = await createTerm(processId, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { response, term: termSchema.parse(data(response)) };
  }

  async function detailOf(id: string, subject = PAULA) {
    const response = await getTerm(id, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      response,
      data: termDetailSchema.parse(data(response)),
      meta: termDetailMetaSchema.parse((response.body as { meta: unknown }).meta),
    };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: TERM_TRANSACTIONS, value: transactions },
        { token: TERM_CLOCK, value: () => NOW },
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
    ]);
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
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: roles.get('LICITACOES')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
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
    it('Criar o TR com o modelo padrão: código, versão do template, seções, objeto, pesquisa, auditoria, evento e timeline', async () => {
      const process = await background();
      const research = seedResearch(process);
      const before = lastNumber();
      const { response, term } = await createOk(process.id);

      expect(response.headers.location).toBe(`/api/v1/terms/${term.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(
        termMetaSchema.parse((response.body as { meta: unknown }).meta).allowedActions,
      ).toEqual(expect.arrayContaining(['UPDATE']));
      expect(term).toMatchObject({
        documentId: term.id,
        processId: process.id,
        status: 'DRAFT',
        inApproval: false,
        title: `Termo de Referência — ${process.title}`,
        objectDefinition: process.object,
        priceResearchId: research.id,
        estimatedTotalValue: '98000.00',
        estimatedTotalValueMasked: false,
        estimatedValueSource: 'PRICE_RESEARCH',
        responsibleId: FAKE_USERS.lucia.id,
        importedFromEtpId: null,
        importedFromEtpVersionId: null,
        version: 1,
      });
      expect(term.code).toBe(`TR ${String(before + 1).padStart(4, '0')}/2026`);
      expect(lastNumber()).toBe(before + 1);

      const type = typeOf('TR');
      const document = documentOf(term.documentId);
      expect(document).toMatchObject({
        status: 'DRAFT',
        singletonKey: type?.id,
        responsibleId: FAKE_USERS.lucia.id,
        templateVersionId: term.templateVersion?.id,
      });
      expect(term.templateVersion?.versionNumber).toBe(1);
      const sections = document.draftContent.sections;
      expect(Object.keys(sections).sort()).toEqual([...TR_SECTIONS].sort());
      expect(Object.values(sections).every((section) => section.revision === 1)).toBe(true);

      expect(auditOf(process.id, 'document.create').at(-1)).toMatchObject({
        entityId: term.documentId,
        changes: [{ path: 'documentTypeCode', old: null, new: 'TR' }],
        metadata: expect.objectContaining({
          code: term.code,
          documentTypeCode: 'TR',
          templateVersionId: term.templateVersion?.id,
          priceResearchId: research.id,
          idempotencyKey: expect.any(String) as unknown,
        }) as unknown,
      });
      const [event] = eventsOf(process.id, 'DocumentCreated').filter(
        (row) => row.aggregateId === term.documentId,
      );
      expect(event).toMatchObject({
        routingKey: 'document.created.tr',
        payload: expect.objectContaining({
          documentId: term.documentId,
          documentTypeCode: 'TR',
          kind: 'STRUCTURED',
          code: term.code,
          templateVersionId: term.templateVersion?.id,
        }) as unknown,
      });
      expect(JSON.stringify(event?.payload)).not.toContain('98000');
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === process.id)
          .map((row) => row.type),
      ).toContain('DOCUMENT_CREATED');
    });

    it('Sem pesquisa concluída o TR nasce sem valor; título informado é usado', async () => {
      const process = await background();
      seedResearch(process, { status: 'DRAFT' });
      const { term } = await createOk(process.id, { title: 'TR dos notebooks escolares' });
      expect(term).toMatchObject({
        title: 'TR dos notebooks escolares',
        priceResearchId: null,
        estimatedTotalValue: null,
        estimatedValueSource: null,
      });
    });

    it('TRM-01 lista modelos publicados e o título padrão; depois da criação, o TR', async () => {
      const process = await background();
      const empty = await listTerms(process.id);
      expect(empty.status, JSON.stringify(empty.body)).toBe(200);
      expect(data(empty)).toEqual([]);
      const meta = termListMetaSchema.parse((empty.body as { meta: unknown }).meta);
      expect(meta.defaultTitle).toBe(`Termo de Referência — ${process.title}`);
      expect(meta.templates).toEqual([
        expect.objectContaining({ name: 'Termo de Referência — Modelo padrão', isDefault: true }),
      ]);
      const { term } = await createOk(process.id, { templateId: meta.templates[0]?.id });
      const listed = await listTerms(process.id, BRUNO);
      expect(z.array(termSummarySchema).parse(data(listed))).toEqual([
        {
          id: term.id,
          documentId: term.documentId,
          code: term.code,
          status: 'DRAFT',
          title: term.title,
          version: 1,
        },
      ]);
    });

    it('Autosave de seção sem criar versão: If-Match "s1" → 200 FILLED na revisão 2 e a completude aumenta', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const before = await detailOf(term.id);
      expect(before.data.draftContent.sections.OBJECT).toMatchObject({
        state: 'EMPTY',
        revision: 1,
      });
      expect(before.meta.template?.sections.map((section) => section.key)).toEqual(TR_SECTIONS);
      expect(before.data.completeness).toMatchObject({ required: 15, satisfied: 0, percent: 0 });
      const documentVersion = documentOf(term.documentId).version;

      const saved = await putSection(
        term.documentId,
        'OBJECT',
        { content: richTextFromPlainText('Aquisição de 200 notebooks para as escolas.') },
        { ifMatch: etag(1) },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(data(saved)).toMatchObject({ sectionKey: 'OBJECT', state: 'FILLED', revision: 2 });
      expect(documentOf(term.documentId)).toMatchObject({
        version: documentVersion,
        currentVersionId: null,
      });
      const after = await detailOf(term.id);
      expect(after.data.completeness).toMatchObject({ required: 15, satisfied: 1, percent: 6 });
      expect(after.response.headers.etag).toBe('"1"');
    });

    it('"Não se aplica" justificado em DELIVERY satisfaz a seção', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const saved = await putSection(
        term.documentId,
        'DELIVERY',
        { content: null, state: 'NOT_APPLICABLE', justification: JUSTIFICATION },
        { ifMatch: etag(1) },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const { data: detail } = await detailOf(term.id);
      expect(detail.completeness.sections).toContainEqual({ key: 'DELIVERY', complete: true });
    });

    it('Painel "Dados do TR": objeto atualizado com If-Match sem alterar o processo, com auditoria sem o texto', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const response = await patchTerm(term.id, {
        objectDefinition: 'Aquisição de 200 notebooks educacionais',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(data<TermDto>(response)).toMatchObject({
        objectDefinition: 'Aquisição de 200 notebooks educacionais',
        version: 2,
      });
      expect(currentOf(process).object).toBe(process.object);
      const audit = auditOf(process.id, 'document.draft_update').at(-1);
      expect(audit).toMatchObject({
        entityId: term.documentId,
        metadata: expect.objectContaining({
          target: 'HEADER',
          fields: ['objectDefinition'],
        }) as unknown,
      });
      expect(JSON.stringify(audit)).not.toContain('notebooks educacionais');
      // Sem mudança: 200 sem versão nova.
      const same = await patchTerm(
        term.id,
        { objectDefinition: 'Aquisição de 200 notebooks educacionais' },
        { ifMatch: '"2"' },
      );
      expect(same.status).toBe(200);
      expect(data<TermDto>(same).version).toBe(2);
    });

    it('Vincular a pesquisa concluída depois ("Usar o valor da pesquisa")', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const research = seedResearch(process);
      const linked = await patchTerm(term.id, { estimatedValueSource: 'PRICE_RESEARCH' });
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      expect(data<TermDto>(linked)).toMatchObject({
        priceResearchId: research.id,
        estimatedTotalValue: '98000.00',
        estimatedValueSource: 'PRICE_RESEARCH',
      });
      const { data: detail } = await detailOf(term.id);
      expect(detail.priceResearch).toMatchObject({
        id: research.id,
        code: 'PP 0002/2026',
        completed: true,
      });
    });
  });

  describe('[Validação]', () => {
    it('Seção obrigatória "SANCTIONS" como NOT_APPLICABLE: 422 VALIDATION_ERROR NOT_ALLOWED em state', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const response = await putSection(
        term.documentId,
        'SANCTIONS',
        { content: null, state: 'NOT_APPLICABLE', justification: JUSTIFICATION },
        { ifMatch: etag(1) },
      );
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'state',
          code: 'NOT_ALLOWED',
          message: "Esta seção é obrigatória e não pode ser marcada como 'não se aplica'.",
        },
      ]);
      expect(documentOf(term.documentId).draftContent.sections.SANCTIONS).toMatchObject({
        state: 'EMPTY',
        revision: 1,
      });
    });

    it('Justificativa curta em DELIVERY: 422 TOO_SHORT e a seção não é salva', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const response = await putSection(
        term.documentId,
        'DELIVERY',
        { content: null, state: 'NOT_APPLICABLE', justification: 'Serviço remoto' },
        { ifMatch: etag(1) },
      );
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ field: 'justification', code: 'TOO_SHORT' });
      expect(documentOf(term.documentId).draftContent.sections.DELIVERY?.revision).toBe(1);
    });

    it('Seção fora do template: 422 SECTION_NOT_IN_TEMPLATE', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      expectProblem(
        await putSection(term.documentId, 'NOT_A_SECTION', { content: null }, { ifMatch: etag(1) }),
        422,
        'SECTION_NOT_IN_TEMPLATE',
      );
    });

    it('Valor manual com pesquisa concluída disponível: origem MANUAL, pesquisa desvinculada e a validação aponta ESTIMATED_VALUE', async () => {
      const process = await background();
      const research = seedResearch(process);
      const { term } = await createOk(process.id);
      const response = await patchTerm(term.id, {
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '100000',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<TermDto>(response)).toMatchObject({
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue: '100000.00',
        priceResearchId: null,
      });
      const { data: detail } = await detailOf(term.id);
      // FA-04: a pesquisa concluída continua disponível para o aviso.
      expect(detail.completedPriceResearch).toMatchObject({ id: research.id, completed: true });
      const validation = await validationOf(term.documentId);
      expect(validation.status, JSON.stringify(validation.body)).toBe(200);
      expect(JSON.stringify(validation.body)).toContain('ESTIMATED_VALUE');
      expect(auditOf(process.id, 'document.draft_update').at(-1)?.changes).toEqual(
        expect.arrayContaining([
          { path: 'estimatedValueSource', old: 'PRICE_RESEARCH', new: 'MANUAL' },
          { path: 'estimatedTotalValue', old: '98000.00', new: '100000.00' },
        ]),
      );
    });

    it('V-01/V-11/RN-TR-08: objeto curto, valor inválido, valor sobre a pesquisa, origem ETP e título curto', async () => {
      const process = await background();
      seedResearch(process);
      const { term } = await createOk(process.id);
      const errorOf = async (body: Record<string, unknown>) =>
        expectProblem(await patchTerm(term.id, body), 422, 'VALIDATION_ERROR').errors[0];
      expect(await errorOf({ objectDefinition: 'curto' })).toMatchObject({
        field: 'objectDefinition',
        code: 'TOO_SHORT',
      });
      expect(
        await errorOf({ estimatedValueSource: 'MANUAL', estimatedTotalValue: '-1' }),
      ).toMatchObject({
        field: 'estimatedTotalValue',
        code: 'INVALID_DECIMAL',
        message: 'Informe um valor válido, com até 2 casas decimais.',
      });
      expect(await errorOf({ estimatedTotalValue: '5.00' })).toMatchObject({
        field: 'estimatedTotalValue',
        code: 'NOT_ALLOWED',
      });
      expect(await errorOf({ estimatedValueSource: 'ETP' })).toMatchObject({
        field: 'estimatedValueSource',
        code: 'NOT_ALLOWED',
      });
      expect(await errorOf({ estimatedValueSource: 'MANUAL' })).toMatchObject({
        field: 'estimatedTotalValue',
        code: 'CONDITIONAL_REQUIRED',
      });
      expect(await errorOf({ priceResearchId: newId() })).toMatchObject({
        field: 'priceResearchId',
        code: 'REFERENCE_NOT_FOUND',
      });
      const other = await background();
      expect(
        expectProblem(await createTerm(other.id, { title: 'TR' }), 422, 'VALIDATION_ERROR')
          .errors[0],
      ).toMatchObject({ field: 'title', code: 'TOO_SHORT' });
      expect(termsOf(term.processId)).toEqual([expect.objectContaining({ version: 1 })]);
    });

    it('Pesquisa não concluída: 422 REFERENCE_INACTIVE em priceResearchId', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const draft = seedResearch(process, { status: 'DRAFT' });
      expect(
        expectProblem(
          await patchTerm(term.id, { priceResearchId: draft.id }),
          422,
          'VALIDATION_ERROR',
        ).errors[0],
      ).toMatchObject({ field: 'priceResearchId', code: 'REFERENCE_INACTIVE' });
    });

    it('TR em status não editável (FA-06): 409 DOCUMENT_NOT_EDITABLE no painel e na seção', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      documentRepositoryOf(api).seed({ ...documentOf(term.documentId), status: 'FINALIZED' });
      const problem = expectProblem(
        await patchTerm(term.id, { objectDefinition: 'Aquisição de notebooks novos' }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(problem.detail).toBe('O TR está concluído. Reabra-o para editar.');
      expectProblem(
        await putSection(
          term.documentId,
          'OBJECT',
          { content: richTextFromPlainText('Objeto') },
          { ifMatch: etag(1) },
        ),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      const { meta } = await detailOf(term.id);
      expect(meta.allowedActions).not.toContain('UPDATE');
    });

    it('Processo suspenso: 409 INVALID_PROCESS_STATUS na criação', async () => {
      const process = await background({ status: 'SUSPENDED' });
      const problem = expectProblem(await createTerm(process.id), 409, 'INVALID_PROCESS_STATUS');
      expect(problem.detail).toBe('O processo não permite alterações no status atual.');
      expect(termsOf(process.id)).toEqual([]);
    });

    it('If-Match ausente no TRM-04: 428 PRECONDITION_REQUIRED', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      expectProblem(
        await patchTerm(
          term.id,
          { objectDefinition: 'Aquisição de notebooks novos' },
          { ifMatch: null },
        ),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem TERM_CREATE (LICITACOES): 403 PERMISSION_DENIED com access.denied TERM_CREATE', async () => {
      const process = await background();
      expectProblem(await createTerm(process.id, {}, { subject: ANDRE }), 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'TERM_CREATE',
      });
      expect(termsOf(process.id)).toEqual([]);
    });

    it('Com TERM_CREATE mas sem custódia (REQUISITANTE): 403 NOT_PROCESS_CUSTODIAN', async () => {
      const process = await background();
      const problem = expectProblem(
        await createTerm(process.id, {}, { subject: 'sub-ana' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(problem.detail).toBe('Somente quem está com o processo pode criar o TR.');
      // RN-TR-02: participante colaborador também não cria.
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      expectProblem(
        await createTerm(process.id, {}, { subject: 'sub-ana' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(termsOf(process.id)).toEqual([]);
    });

    it('Etapa que não admite o TR (ABERTURA): 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', async () => {
      const process = await background();
      moveTo(process, { currentWorkflowStageId: stageId(process, 'ABERTURA') });
      const problem = expectProblem(
        await createTerm(process.id),
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
      );
      expect(problem.detail).toBe('O Termo de Referência não pode ser elaborado nesta etapa.');
      expect(termsOf(process.id)).toEqual([]);
    });

    it('Orçamento sigiloso: o CONSULTANT vê "estimatedTotalValue" nulo e mascarado, edita seções e não altera o valor', async () => {
      const process = await background({ isBudgetConfidential: true });
      seedResearch(process);
      const { term } = await createOk(process.id);
      expect(documentOf(term.documentId).confidentiality).toBe('RESTRICTED');
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'CONSULTANT',
      });
      const { data: detail, meta } = await detailOf(term.id, BRUNO);
      expect(detail).toMatchObject({
        estimatedTotalValue: null,
        estimatedTotalValueMasked: true,
        estimatedValueSource: 'PRICE_RESEARCH',
      });
      expect(detail.priceResearch?.totalEstimatedValue).toBeNull();
      expect(meta.allowedActions).toContain('UPDATE');
      expect(JSON.stringify(detail)).not.toContain('98000');
      const saved = await putSection(
        term.documentId,
        'SPECIFICATIONS',
        { content: richTextFromPlainText('Processador de 8 núcleos.') },
        { ifMatch: etag(1), subject: BRUNO },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expectProblem(
        await patchTerm(
          term.id,
          { estimatedValueSource: 'MANUAL', estimatedTotalValue: '1.00' },
          { subject: BRUNO },
        ),
        403,
        'PERMISSION_DENIED',
      );
      const objectOnly = await patchTerm(
        term.id,
        { objectDefinition: 'Aquisição de notebooks educacionais' },
        { subject: BRUNO },
      );
      expect(objectOnly.status, JSON.stringify(objectOnly.body)).toBe(200);
      expect(data<TermDto>(objectOnly).estimatedTotalValue).toBeNull();
      // A custodiante vê o valor.
      expect((await detailOf(term.id)).data.estimatedTotalValue).toBe('98000.00');
    });

    it('Sem participação nem custódia o somente-leitura abre em leitura e não grava', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const { meta } = await detailOf(term.id, BRUNO);
      expect(meta.allowedActions).not.toContain('UPDATE');
      expectProblem(
        await patchTerm(
          term.id,
          { objectDefinition: 'Aquisição de notebooks novos' },
          { subject: BRUNO },
        ),
        403,
        'PERMISSION_DENIED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('TR e template de outro tenant: 404 sem revelar e 422 REFERENCE_NOT_FOUND em templateId', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      // Fábio tem vínculo na Prefeitura B.
      expectProblem(await getTerm(term.id, 'sub-fabio', B), 404, 'NOT_FOUND');
      expectProblem(
        await patchTerm(
          term.id,
          { objectDefinition: 'Objeto de outro tenant' },
          { subject: 'sub-fabio', tenant: B },
        ),
        404,
        'NOT_FOUND',
      );
      expectProblem(await listTerms(process.id, 'sub-fabio', B), 404, 'NOT_FOUND');
      expectProblem(await getTerm(newId()), 404, 'NOT_FOUND');

      const other = await background();
      const templateOfB = typeOf('TR', B)?.defaultTemplateId ?? newId();
      const problem = expectProblem(
        await createTerm(other.id, { templateId: templateOfB }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'templateId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(termsOf(other.id)).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Segundo TR no mesmo processo: 409 DOCUMENT_ALREADY_EXISTS com o identificador do existente', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const conflict = await createTerm(process.id);
      const problem = expectProblem(conflict, 409, 'DOCUMENT_ALREADY_EXISTS');
      expect(problem.detail).toBe('Este processo já tem um Termo de Referência.');
      expect(conflict.body).toMatchObject({ meta: { existingTermId: term.id, code: term.code } });
      expect(termsOf(process.id)).toHaveLength(1);
    });

    it('Reenvio com a mesma chave: 201 com o mesmo TR, Idempotent-Replayed e sem consumir número', async () => {
      const process = await background();
      const key = randomUUID();
      const first = await createTerm(process.id, {}, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const after = lastNumber();
      const replay = await createTerm(process.id, {}, { key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<TermDto>(replay).id).toBe(data<TermDto>(first).id);
      expect(lastNumber()).toBe(after);
      expect(termsOf(process.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Autosave concorrente na mesma seção: 412 SECTION_REVISION_CONFLICT; seções diferentes salvam', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'CONSULTANT',
      });
      const bruno = await putSection(
        term.documentId,
        'SPECIFICATIONS',
        { content: richTextFromPlainText('Versão do Bruno.') },
        { ifMatch: etag(1), subject: BRUNO },
      );
      expect(bruno.status, JSON.stringify(bruno.body)).toBe(200);
      expectProblem(
        await putSection(
          term.documentId,
          'SPECIFICATIONS',
          { content: richTextFromPlainText('Versão da Paula.') },
          { ifMatch: etag(1) },
        ),
        412,
        'SECTION_REVISION_CONFLICT',
      );
      const [paula, other] = await Promise.all([
        putSection(
          term.documentId,
          'OBJECT',
          { content: richTextFromPlainText('Objeto') },
          { ifMatch: etag(1) },
        ),
        putSection(
          term.documentId,
          'PAYMENT',
          { content: richTextFromPlainText('Pagamento em 30 dias.') },
          { ifMatch: etag(1), subject: BRUNO },
        ),
      ]);
      expect([paula.status, other.status]).toEqual([200, 200]);
    });

    it('Duas criações simultâneas: uma 201 e outra 409 DOCUMENT_ALREADY_EXISTS', async () => {
      const process = await background();
      const responses = await Promise.all([createTerm(process.id), createTerm(process.id)]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(termsOf(process.id)).toHaveLength(1);
    });

    it('Cabeçalho alterado por outra pessoa: 412 VERSION_CONFLICT com o TR atual', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      expect(
        (await patchTerm(term.id, { objectDefinition: 'Aquisição de notebooks A' })).status,
      ).toBe(200);
      const conflict = await patchTerm(term.id, { objectDefinition: 'Aquisição de notebooks B' });
      expectProblem(conflict, 412, 'VERSION_CONFLICT');
      expect(conflict.body).toMatchObject({
        meta: { current: { objectDefinition: 'Aquisição de notebooks A', version: 2 } },
      });
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na criação: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido nem numerado', async () => {
      const process = await background();
      const before = lastNumber();
      transactions.down = true;
      const response = await createTerm(process.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      transactions.down = false;
      expect(termsOf(process.id)).toEqual([]);
      expect(documentsOf(process.id).filter((doc) => doc.code?.startsWith('TR'))).toEqual([]);
      expect(auditOf(process.id, 'document.create')).toEqual([]);
      expect(lastNumber()).toBe(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 201 e o DocumentCreated fica no outbox (mesmo tx) uma única vez', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const events = eventsOf(process.id, 'DocumentCreated').filter(
        (row) => row.aggregateId === term.documentId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.routingKey).toBe('document.created.tr');
    });

    it('A leitura detalhada devolve o rascunho com a revisão de cada seção (TermDetail)', async () => {
      const process = await background();
      const { term } = await createOk(process.id);
      const { data: detail } = await detailOf(term.id);
      const sections: TermDetailDto['draftContent']['sections'] = detail.draftContent.sections;
      expect(Object.keys(sections)).toHaveLength(TR_SECTIONS.length);
      expect(detail.etpChangedSinceImport).toBe(false);
    });
  });
});

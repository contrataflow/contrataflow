import { randomUUID } from 'node:crypto';

import {
  etpListMetaSchema,
  etpMetaSchema,
  etpSchema,
  etpSummarySchema,
  problemDetailsSchema,
  richTextPlainText,
} from '@contrataflow/validation';
import type {
  DocumentSnapshot,
  EtpDto,
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
  buildVersion,
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
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { ETP_CLOCK, ETP_TRANSACTIONS } from '../application/ports.js';
import type { EtpTransactions } from '../application/ports.js';
import { InMemoryEtpRepository } from '../infrastructure/etp.repositories.js';

/*
 * US-019 — Criar ETP a partir de template com importação do DFD, pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, `Idempotency-Key`, filtro RFC 9457) com a identidade
 * fake, os seeders reais (catálogo, perfis, tipos de documento, biblioteca de templates e o workflow
 * padrão) e o processo do PRC-02 levado à etapa ESTUDOS_PRELIMINARES. As 8 categorias do Gherkin:
 * ETP-01/02. Lúcia recebe PLANEJAMENTO e a custódia do processo ("Carla"); Otávio recebe
 * SOMENTE_LEITURA (e não tem ETP_CREATE — "Bruno"); Ana (REQUISITANTE, com ETP_CREATE) é a
 * colaboradora sem custódia (RN-ETP-07). O DFD elegível é semeado FINALIZED/APPROVED com o snapshot
 * da versão (o ciclo do DFD é da US-016/065). Atomicidade com numeração, índice único sob
 * concorrência, RLS e FKs compostas no PostgreSQL: `test/tenant-leak/etps.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-18T15:00:00.000Z');
const SEQUENCE = (year = 2026) => `DOCUMENT:ETP:*:${String(year)}`;
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';

const UNITS_A = {
  organizationId: '0192d019-0000-7000-8000-0000000000a0',
  obras: '0192d019-0000-7000-8000-0000000000a1',
  manutencao: '0192d019-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d019-0000-7000-8000-0000000000a3',
  saude: '0192d019-0000-7000-8000-0000000000a4',
  posto: '0192d019-0000-7000-8000-0000000000a5',
};

const ETP_SECTIONS = [
  'NEED_DESCRIPTION',
  'PROBLEM',
  'OBJECTIVE',
  'PCA_ALIGNMENT',
  'REQUIREMENTS',
  'MARKET_SURVEY',
  'ALTERNATIVES',
  'ESTIMATES',
  'RECOMMENDED_SOLUTION',
  'PARCELING',
  'RELATED_CONTRACTS',
  'EXPECTED_RESULTS',
  'ENVIRONMENTAL_IMPACTS',
  'PRIOR_MEASURES',
  'RISKS',
  'CONCLUSION',
];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as do módulo) que podem simular o banco fora do ar. */
class FlakyTransactions implements EtpTransactions {
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

describe('Feature: Criar ETP a partir de template com importação do DFD (US-019)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let units: { un: string; cx: string };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = CARLA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const createEtp = (
    processId: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/etps`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const listEtps = (processId: string, subject = CARLA, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/etps`), subject, tenant);
  const addProcessItem = (processId: string, body: Record<string, unknown>) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/items`), 'sub-ana')
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', ...body });

  const etpsOf = (processId: string) =>
    api.app
      .get(InMemoryEtpRepository, { strict: false })
      .snapshot()
      .filter((etp) => etp.processId === processId);
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const etpDocumentOf = (etp: EtpDto) =>
    documentsOf(etp.processId).find((document) => document.id === etp.documentId);
  const itemsOf = (documentId: string) =>
    documentItemRepositoryOf(api)
      .snapshot()
      .filter((row) => row.documentId === documentId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const timelineOf = (processId: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId);
  const lastNumber = () => numberSequencesOf(api).valueOf(A, SEQUENCE());
  const typeOf = (code: string) =>
    documentTypeRepositoryOf(api)
      .snapshot()
      .find((type) => type.tenantId === A && type.code === code);
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

  /** Processo criado pelo PRC-02 (Ana), com dois itens, levado aos estudos preliminares (Carla). */
  async function background() {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana')
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Manutenção predial ${words(2)}`,
        object: `Contratação de manutenção predial preventiva ${words(2)}`,
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
    const items: ProcessItemDto[] = [];
    for (const [description, unitOfMeasureId] of [
      ['Tinta acrílica 18 L', units.un],
      ['Massa corrida 25 kg', units.cx],
    ] as const) {
      const item = await addProcessItem(created.id, { description, unitOfMeasureId });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
      items.push(data<ProcessItemDto>(item));
    }
    const process = moveTo(created, {
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stageId(created, 'ESTUDOS_PRELIMINARES'),
      currentResponsibleId: FAKE_USERS.lucia.id,
    });
    return { process, items };
  }

  /**
   * DFD 0005/2026 do processo com o snapshot da versão (cabeçalho, justificativa e itens): o que a
   * finalização (US-016/065) grava. `approved` cria também a versão aprovada (RN-ETP-04).
   */
  function seedDfd(
    process: Process,
    items: readonly ProcessItemDto[],
    options: {
      readonly status?: 'DRAFT' | 'FINALIZED' | 'APPROVED' | 'RETURNED' | 'CANCELED';
      readonly pcaStatus?: 'PLANNED' | 'NOT_PLANNED' | 'NOT_APPLICABLE';
      readonly objectSummary?: string;
    } = {},
  ) {
    const type = typeOf('DFD');
    const status = options.status ?? 'FINALIZED';
    const id = newId();
    const versioned = status !== 'DRAFT';
    const snapshotOf = (objectSummary: string): DocumentSnapshot => ({
      schemaVersion: 1,
      document: {
        id,
        code: 'DFD 0005/2026',
        title: 'DFD — Manutenção predial',
        typeCode: 'DFD',
        kind: 'STRUCTURED',
        confidentiality: 'INTERNAL',
        versionNumber: 1,
      },
      template: null,
      process: {
        id: process.id,
        code: process.code,
        title: process.title,
        object: process.object,
        organizationName: 'Prefeitura Municipal de São José',
        organizationCnpj: null,
        requestingSecretariatName: null,
        requestingDepartmentName: null,
        isBudgetConfidential: false,
      },
      header: {
        objectSummary,
        pcaStatus: options.pcaStatus ?? 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-17',
        pcaJustification: null,
      },
      sections: {
        JUSTIFICATION: {
          state: 'FILLED',
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Os prédios apresentam infiltrações.' }],
              },
            ],
          },
          justification: null,
        },
      },
      collections: {
        items: items.map((item, index) => ({
          processItemId: item.id,
          quantity: `${String((index + 1) * 10)}.0000`,
          notes: null,
          sortOrder: index,
        })),
      },
      generatedAt: NOW.toISOString(),
    });
    const document = buildDocument({
      id,
      tenantId: A,
      processId: process.id,
      documentTypeId: type?.id ?? newId(),
      code: 'DFD 0005/2026',
      title: 'DFD — Manutenção predial',
      status,
      singletonKey: type?.id ?? null,
    });
    const current = buildVersion(document, {
      versionNumber: status === 'APPROVED' ? 2 : 1,
      content: snapshotOf(options.objectSummary ?? 'Manutenção predial preventiva dos prédios'),
      statusAtCreation: status === 'APPROVED' ? 'IN_REVIEW' : 'FINALIZED',
    });
    const approved =
      status === 'APPROVED'
        ? buildVersion(document, {
            versionNumber: 1,
            reason: 'SUBMISSION',
            statusAtCreation: 'APPROVED',
            content: snapshotOf('Objeto aprovado pela autoridade'),
          })
        : null;
    const seeded = {
      ...document,
      currentVersionId: versioned ? current.id : null,
      currentVersionNumber: versioned ? current.versionNumber : null,
      approvedVersionId: approved?.id ?? null,
    };
    documentRepositoryOf(api).seed(seeded);
    if (versioned) void documentRepositoryOf(api).insertVersion({} as TenantTx, current);
    if (approved) void documentRepositoryOf(api).insertVersion({} as TenantTx, approved);
    return { document: seeded, current, approved };
  }

  async function createOk(processId: string, body: Record<string, unknown> = {}) {
    const response = await createEtp(processId, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { response, etp: etpSchema.parse(data(response)) };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: ETP_TRANSACTIONS, value: transactions },
        { token: ETP_CLOCK, value: () => NOW },
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
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    units = {
      un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
      cx: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'CX'),
    };
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
    it('Criar ETP importando o DFD finalizado: seções, itens, origem, auditoria, evento e 201 com Location/ETag', async () => {
      const { process, items } = await background();
      const { current } = seedDfd(process, items);
      const before = lastNumber();
      const { response, etp } = await createOk(process.id, { importFromDfd: true });

      expect(response.headers.location).toBe(`/api/v1/etps/${etp.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(etpMetaSchema.parse((response.body as { meta: unknown }).meta).allowedActions).toEqual(
        expect.arrayContaining(['UPDATE']),
      );
      expect(etp).toMatchObject({
        documentId: etp.id,
        processId: process.id,
        status: 'DRAFT',
        conclusion: 'PENDING',
        importedFromDfdVersionId: current.id,
        responsibleId: FAKE_USERS.lucia.id,
        title: `Estudo Técnico Preliminar — ${process.code ?? ''}`,
        itemsCount: 2,
        version: 1,
      });
      expect(etp.code).toMatch(/^ETP \d{4}\/2026$/);
      expect(lastNumber()).toBe(before + 1);

      const document = etpDocumentOf(etp);
      expect(document).toMatchObject({
        status: 'DRAFT',
        confidentiality: typeOf('ETP')?.defaultConfidentiality,
        singletonKey: typeOf('ETP')?.id,
        responsibleId: FAKE_USERS.lucia.id,
      });
      const sections = document?.draftContent.sections ?? {};
      expect(Object.keys(sections).sort()).toEqual([...ETP_SECTIONS].sort());
      expect(sections.NEED_DESCRIPTION?.state).toBe('FILLED');
      expect(richTextPlainText(sections.NEED_DESCRIPTION?.content)).toBe(
        'Manutenção predial preventiva dos prédios\nOs prédios apresentam infiltrações.',
      );
      expect(sections.PCA_ALIGNMENT?.state).toBe('FILLED');
      expect(richTextPlainText(sections.PCA_ALIGNMENT?.content)).toBe(
        'A contratação está prevista no Plano de Contratações Anual de 2026, item PCA-17.',
      );
      for (const key of ETP_SECTIONS.filter(
        (k) => !['NEED_DESCRIPTION', 'PCA_ALIGNMENT'].includes(k),
      )) {
        expect(sections[key]?.state, key).toBe('EMPTY');
      }

      const rows = itemsOf(etp.documentId);
      expect(rows.map((row) => [row.processItemId, row.quantity])).toEqual([
        [items[0]?.id, '10.0000'],
        [items[1]?.id, '20.0000'],
      ]);
      expect(etpsOf(process.id)).toEqual([
        expect.objectContaining({ id: etp.id, importedFromDfdVersionId: current.id }),
      ]);

      expect(auditOf(process.id, 'document.create').at(-1)).toMatchObject({
        entityId: etp.documentId,
        changes: [
          { path: 'documentTypeCode', old: null, new: 'ETP' },
          { path: 'importedFromDfdVersionId', old: null, new: current.id },
        ],
        metadata: expect.objectContaining({
          code: etp.code,
          documentTypeCode: 'ETP',
          importedFromDfd: true,
          importedItemsCount: 2,
          idempotencyKey: expect.any(String) as unknown,
        }) as unknown,
      });
      const [event] = eventsOf(process.id, 'DocumentCreated').filter(
        (row) => row.aggregateId === etp.documentId,
      );
      expect(event).toMatchObject({
        routingKey: 'document.created.etp',
        payload: expect.objectContaining({
          documentId: etp.documentId,
          documentTypeCode: 'ETP',
          kind: 'STRUCTURED',
          sourceDocumentId: null,
        }) as unknown,
      });
      expect(JSON.stringify(event?.payload)).not.toContain('infiltrações');
      expect(timelineOf(process.id).map((row) => row.type)).toContain('DOCUMENT_CREATED');
    });

    it('DFD aprovado: a importação usa a versão aprovada (approvedVersionId), não a atual', async () => {
      const { process, items } = await background();
      const { approved } = seedDfd(process, items, { status: 'APPROVED' });
      const { etp } = await createOk(process.id, { importFromDfd: true });
      expect(etp.importedFromDfdVersionId).toBe(approved?.id);
      expect(
        richTextPlainText(etpDocumentOf(etp)?.draftContent.sections.NEED_DESCRIPTION?.content),
      ).toContain('Objeto aprovado pela autoridade');
    });

    it('Situação no PCA "não se aplica" vira o texto correspondente em PCA_ALIGNMENT', async () => {
      const { process, items } = await background();
      seedDfd(process, items, { pcaStatus: 'NOT_APPLICABLE' });
      const { etp } = await createOk(process.id, { importFromDfd: true });
      expect(
        richTextPlainText(etpDocumentOf(etp)?.draftContent.sections.PCA_ALIGNMENT?.content),
      ).toBe('A contratação não se sujeita ao Plano de Contratações Anual (não se aplica).');
    });

    it('Criar ETP sem importação (FA-01): 16 seções EMPTY, sem itens e importedFromDfdVersionId vazio', async () => {
      const { process, items } = await background();
      seedDfd(process, items);
      for (const body of [{ importFromDfd: false }]) {
        const { etp } = await createOk(process.id, body);
        expect(etp).toMatchObject({ importedFromDfdVersionId: null, itemsCount: 0 });
        const sections = etpDocumentOf(etp)?.draftContent.sections ?? {};
        expect(Object.values(sections).map((section) => section.state)).toEqual(
          Array.from({ length: 16 }, () => 'EMPTY'),
        );
        expect(itemsOf(etp.documentId)).toEqual([]);
        expect(auditOf(process.id, 'document.create').at(-1)?.changes).toEqual([
          { path: 'documentTypeCode', old: null, new: 'ETP' },
          { path: 'importedFromDfdVersionId', old: null, new: null },
        ]);
      }
    });

    it('Corpo vazio equivale a criar sem importação', async () => {
      const { process } = await background();
      const { etp } = await createOk(process.id);
      expect(etp.importedFromDfdVersionId).toBeNull();
    });

    it('ETP-01: sem ETP lista vazia com o DFD elegível em meta; depois da criação, o ETP', async () => {
      const { process, items } = await background();
      const { document, current } = seedDfd(process, items);
      const empty = await listEtps(process.id);
      expect(empty.status, JSON.stringify(empty.body)).toBe(200);
      expect(data(empty)).toEqual([]);
      expect(etpListMetaSchema.parse((empty.body as { meta: unknown }).meta)).toEqual({
        importableDfd: {
          documentId: document.id,
          code: 'DFD 0005/2026',
          status: 'FINALIZED',
          versionId: current.id,
          versionNumber: 1,
          objectSummary: 'Manutenção predial preventiva dos prédios',
          itemsCount: 2,
          pcaStatus: 'PLANNED',
        },
      });
      const { etp } = await createOk(process.id, { importFromDfd: true });
      const listed = await listEtps(process.id, BRUNO);
      expect(listed.status).toBe(200);
      expect(z.array(etpSummarySchema).parse(data(listed))).toEqual([
        {
          id: etp.id,
          documentId: etp.documentId,
          code: etp.code,
          status: 'DRAFT',
          conclusion: 'PENDING',
          version: 1,
        },
      ]);
    });

    it('Colaboradora (participação COLLABORATOR) sem custódia cria o ETP (RN-ETP-07)', async () => {
      const { process } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const response = await createEtp(process.id, {}, { subject: 'sub-ana' });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(data<EtpDto>(response).responsibleId).toBe(FAKE_USERS.ana.id);
    });
  });

  describe('[Validação]', () => {
    it('Importação sem DFD elegível: 422 NOT_ALLOWED em importFromDfd e nada criado nem numerado', async () => {
      const { process, items } = await background();
      const before = lastNumber();
      const response = await createEtp(process.id, { importFromDfd: true });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'importFromDfd',
          code: 'NOT_ALLOWED',
          message: 'Não há um DFD finalizado neste processo para importar.',
        },
      ]);
      expect(etpsOf(process.id)).toEqual([]);
      expect(documentsOf(process.id)).toEqual([]);
      expect(lastNumber()).toBe(before);
      expect((await listEtps(process.id)).body).toMatchObject({ meta: { importableDfd: null } });

      for (const status of ['DRAFT', 'RETURNED', 'CANCELED'] as const) {
        const other = await background();
        seedDfd(other.process, other.items, { status });
        expectProblem(
          await createEtp(other.process.id, { importFromDfd: true }),
          422,
          'VALIDATION_ERROR',
        );
        expect((await listEtps(other.process.id)).body).toMatchObject({
          meta: { importableDfd: null },
        });
        expect(etpsOf(other.process.id)).toEqual([]);
      }
      expect(items).toHaveLength(2);
    });

    it('Campo desconhecido ou importFromDfd não booleano: 422 VALIDATION_ERROR', async () => {
      const { process } = await background();
      expectProblem(await createEtp(process.id, { importFromDfd: 'sim' }), 422, 'VALIDATION_ERROR');
      expectProblem(await createEtp(process.id, { templateId: newId() }), 422, 'VALIDATION_ERROR');
      expect(etpsOf(process.id)).toEqual([]);
    });

    it('Processo em status não editável (V-03): 409 DOCUMENT_NOT_EDITABLE', async () => {
      const { process } = await background();
      moveTo(process, { status: 'SUSPENDED' });
      const problem = expectProblem(await createEtp(process.id), 409, 'DOCUMENT_NOT_EDITABLE');
      expect(problem.detail).toBe('O processo não está em um status que permita criar documentos.');
      expect(etpsOf(process.id)).toEqual([]);
    });

    it('Tipo ETP não permitido na etapa atual (FA-05): 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', async () => {
      const { process } = await background();
      moveTo(process, { currentWorkflowStageId: stageId(process, 'ABERTURA') });
      const problem = expectProblem(
        await createEtp(process.id),
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
      );
      expect(problem.detail).toBe('Este documento não é permitido na etapa atual.');
      expect(etpsOf(process.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem ETP_CREATE (SOMENTE_LEITURA): 403 PERMISSION_DENIED com access.denied ETP_CREATE', async () => {
      const { process, items } = await background();
      seedDfd(process, items);
      expectProblem(
        await createEtp(process.id, { importFromDfd: true }, { subject: BRUNO }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'ETP_CREATE',
      });
      expect(etpsOf(process.id)).toEqual([]);
    });

    it('Sem permissão a importação inválida também responde 403 (autorização antes da validação)', async () => {
      const { process } = await background();
      expectProblem(
        await createEtp(process.id, { importFromDfd: true }, { subject: BRUNO }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('Com ETP_CREATE mas sem custódia nem participação: 403 PERMISSION_DENIED (POL-02)', async () => {
      const { process } = await background();
      expectProblem(
        await createEtp(process.id, {}, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-02',
      });
      expect(etpsOf(process.id)).toEqual([]);
    });

    it('Observador (participação OBSERVER) não cria', async () => {
      const { process } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'OBSERVER',
      });
      expectProblem(
        await createEtp(process.id, {}, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant: 404 NOT_FOUND no ETP-01/02 sem criar nem ler nada', async () => {
      const { process, items } = await background();
      seedDfd(process, items);
      // Fábio tem vínculo na Prefeitura B (CONSULTOR_EXTERNO).
      expectProblem(
        await createEtp(process.id, { importFromDfd: true }, { subject: 'sub-fabio', tenant: B }),
        404,
        'NOT_FOUND',
      );
      expectProblem(await listEtps(process.id, 'sub-fabio', B), 404, 'NOT_FOUND');
      expectProblem(await createEtp(newId()), 404, 'NOT_FOUND');
      expect(etpsOf(process.id)).toEqual([]);
      expect(documentsOf(process.id).filter((doc) => doc.code?.startsWith('ETP'))).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 201 com o mesmo ETP e Idempotent-Replayed; corpo diferente = IDEMPOTENCY_KEY_REUSED', async () => {
      const { process, items } = await background();
      seedDfd(process, items);
      const key = randomUUID();
      const first = await createEtp(process.id, { importFromDfd: true }, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const replay = await createEtp(process.id, { importFromDfd: true }, { key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<EtpDto>(replay).id).toBe(data<EtpDto>(first).id);
      expectProblem(
        await createEtp(process.id, { importFromDfd: false }, { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
      expect(etpsOf(process.id)).toHaveLength(1);
    });

    it('ETP já existe (V-01 · FA-03): 409 DOCUMENT_ALREADY_EXISTS com meta.existingEtpId', async () => {
      const { process } = await background();
      const { etp } = await createOk(process.id);
      const conflict = await createEtp(process.id);
      const problem = expectProblem(conflict, 409, 'DOCUMENT_ALREADY_EXISTS');
      expect(problem.detail).toBe('Este processo já tem um ETP. Abra o estudo existente.');
      expect(conflict.body).toMatchObject({ meta: { existingEtpId: etp.id, code: etp.code } });
      expect(etpsOf(process.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas criações simultâneas no mesmo processo: uma 201 e outra 409 DOCUMENT_ALREADY_EXISTS', async () => {
      const { process, items } = await background();
      seedDfd(process, items);
      const responses = await Promise.all([
        createEtp(process.id, { importFromDfd: true }),
        createEtp(process.id, { importFromDfd: true }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expectProblem(
        responses.find((response) => response.status === 409) as request.Response,
        409,
        'DOCUMENT_ALREADY_EXISTS',
      );
      expect(etpsOf(process.id)).toHaveLength(1);
      const [etp] = etpsOf(process.id);
      expect(itemsOf(etp?.documentId ?? '')).toHaveLength(2);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na criação: 503 DEPENDENCY_UNAVAILABLE e nada persistido nem numerado', async () => {
      const { process, items } = await background();
      seedDfd(process, items);
      const before = lastNumber();
      transactions.down = true;
      const response = await createEtp(process.id, { importFromDfd: true });
      const problem = expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(problem.correlationId).toEqual(expect.any(String));
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      transactions.down = false;
      expect(etpsOf(process.id)).toEqual([]);
      expect(documentsOf(process.id).filter((doc) => doc.code?.startsWith('ETP'))).toEqual([]);
      expect(auditOf(process.id, 'document.create')).toEqual([]);
      expect(lastNumber()).toBe(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 201 e o ETPCreated fica no outbox (gravado no mesmo tx) uma única vez', async () => {
      const { process } = await background();
      const { etp } = await createOk(process.id);
      const events = eventsOf(process.id, 'DocumentCreated').filter(
        (row) => row.aggregateId === etp.documentId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.routingKey).toBe('document.created.etp');
    });
  });
});

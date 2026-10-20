import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, processSchema } from '@contrataflow/validation';
import type { ActionEntry, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  createDocumentAs,
  documentRepositoryOf,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
import {
  attachmentsOf,
  CATALOG_CLOCK,
  catalogItemId,
  catalogItemRepositoryOf,
  getAs,
  numberSequencesOf,
  processRepositoryOf,
  runTenantSeeders,
  seedAvailableAttachment,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedCustomRole,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { ProcessItem } from '../domain/process-items.js';
import { InMemoryProcessItemRepository } from '../infrastructure/process-item.repositories.js';

/*
 * US-011 — PRC-27 (`POST /processes/{id}/duplicate`) pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, `PROCESS_DUPLICATE` com escopo do processo, idempotência, filtro RFC 9457) com a
 * identidade fake, os seeders reais (catálogos, perfis, workflow padrão DEC-015, tipos de
 * documento), a numeração, a auditoria, o outbox, a timeline e os adaptadores em memória. Os
 * cenários do Gherkin (8 categorias), o que a DEC-033 copia e o que nunca copia. Atomicidade, RLS e
 * FKs compostas no PostgreSQL: `test/tenant-leak/process-duplicate.spec.ts`.
 *
 * Personas: "Carla" do Gherkin = Lúcia (GESTOR_CONTRATACOES em todo o tenant); "Diego" = Otávio, com
 * um perfil só de PROCESS_VIEW + PROCESS_CREATE; a Ana do diretório é REQUISITANTE lotada no Setor
 * de Manutenção (escopo das próprias unidades).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');

const ORG_A = '0192d011-0000-7000-8000-0000000000a0';
const ORG_B = '0192d011-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d011-0000-7000-8000-0000000000a1',
  manutencao: '0192d011-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d011-0000-7000-8000-0000000000a3',
  saude: '0192d011-0000-7000-8000-0000000000a4',
  posto: '0192d011-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d011-0000-7000-8000-0000000000b1',
  manutencao: '0192d011-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d011-0000-7000-8000-0000000000b3',
  saude: '0192d011-0000-7000-8000-0000000000b4',
  posto: '0192d011-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** Transações do módulo que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements ProcessTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  longRead<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
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

describe('Feature: Duplicar processo (US-011)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let dfdTypeId: string;
  let despachoTypeId: string;
  let modalityId: string;

  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  /** Processo de origem na Secretaria de Obras / Setor de Manutenção, aberto por Lúcia. */
  async function newSource(subject = 'sub-lucia', tenant: string = A): Promise<ProcessDto> {
    const units = tenant === A ? UNITS_A : UNITS_B;
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Merenda ${words(2)}`,
        object: `Objeto ${words(3)}`,
        description: 'Fornecimento contínuo para as escolas da rede.',
        contractingTypeId: catalogItemId(api, tenant, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        modalityId: catalogItemId(api, tenant, 'MODALITY', 'PREGAO'),
        isPriceRegistration: true,
        requestingSecretariatId: units.obras,
        requestingDepartmentId: units.manutencao,
        originId: catalogItemId(api, tenant, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        priority: 'HIGH',
        targetDate: '2026-12-01',
        estimatedValue: '150000.00',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-77',
        internalCode: `PROT-${words(1)}`,
        notes: 'Contratação recorrente.',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessDto>(response);
  }

  const duplicate = (
    processId: string,
    payload: Record<string, unknown> = {},
    options: { subject?: string; tenant?: string; key?: string } = {},
  ) =>
    request(api.server)
      .post(`/api/v1/processes/${processId}/duplicate`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(payload);

  const items = () => api.app.get(InMemoryProcessItemRepository, { strict: false });
  const processesOf = (tenantId: string) =>
    processRepositoryOf(api)
      .allProcesses()
      .filter((process) => process.tenantId === tenantId);
  const duplicatesOf = (sourceId: string) =>
    processesOf(A).filter((process) => process.duplicatedFromId === sourceId);
  const auditOf = (action: string) => api.auditRecords().filter((row) => row.action === action);
  const activeItemsOf = (processId: string) =>
    items()
      .all()
      .filter((item) => item.processId === processId && item.deletedAt === null)
      .sort((a, b) => a.sequence - b.sequence);

  function seedItem(processId: string, sequence: number, extra: Partial<ProcessItem> = {}) {
    const item: ProcessItem = {
      id: newId(),
      tenantId: A,
      processId,
      sequence,
      lotNumber: 1,
      lotName: 'Gêneros',
      kind: 'GOOD',
      description: `Item ${String(sequence)} ${words(1)}`,
      unitOfMeasureId: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
      catalogSystem: null,
      catalogCode: null,
      notes: null,
      referenceQuantity: '100.0000',
      referenceQuantitySourceDocumentId: newId(),
      referenceUnitPrice: '12.5000',
      referenceUnitPriceSourceDocumentId: newId(),
      createdAt: NOW,
      updatedAt: NOW,
      createdById: FAKE_USERS.lucia.id,
      updatedById: null,
      version: 1,
      ...extra,
    };
    items().seed(item);
    return item;
  }

  function seedAttachment(
    processId: string,
    target: { targetType: 'PROCESS' | 'DOCUMENT'; targetId: string },
  ) {
    return seedAvailableAttachment(api, {
      tenantId: A,
      processId,
      ...target,
      uploadedById: FAKE_USERS.lucia.id,
      now: NOW,
    });
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    // "Diego": PROCESS_CREATE (e PROCESS_VIEW) em todo o tenant, mas não PROCESS_DUPLICATE.
    const creatorOnly = seedCustomRole(api, A, 'Abertura de processos', [
      'PROCESS_VIEW',
      'PROCESS_CREATE',
    ]);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: creatorOnly.id,
    });
    const typeId = (code: string) =>
      documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === code)?.id ?? '';
    dfdTypeId = typeId('DFD');
    despachoTypeId = typeId('DESPACHO');
    modalityId = catalogItemId(api, A, 'MODALITY', 'PREGAO');
    // Background: o processo de origem será o 0012/2026.
    numberSequencesOf(api).seed(A, 'PROCESS:*:2026', 11);
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
    it('Duplicar processo copiando itens: número próprio, duplicatedFromId e nada do que a DEC-033 veda', async () => {
      const source = await newSource();
      expect(source.code).toBe('0012/2026');
      const sourceItems = [1, 2, 3].map((sequence) => seedItem(source.id, sequence));

      const response = await duplicate(
        source.id,
        {},
        { key: 'a011a011-0000-4000-8000-000000000001' },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = processSchema.parse(data<ProcessDto>(response));
      expect(response.headers.location).toBe(`/api/v1/processes/${created.id}`);
      expect(response.headers.etag).toBe('"1"');
      // RN-PROC-118: metadados copiados; RN-PROC-119/122: número, workflow e etapa próprios.
      expect(created).toMatchObject({
        duplicatedFromId: source.id,
        code: '0013/2026',
        number: 13,
        status: 'DRAFT',
        title: source.title,
        object: source.object,
        description: source.description,
        contractingType: source.contractingType,
        modality: source.modality,
        origin: source.origin,
        isPriceRegistration: true,
        priority: 'HIGH',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-77',
        notes: 'Contratação recorrente.',
        requestingSecretariat: { id: UNITS_A.obras },
        requestingDepartment: { id: UNITS_A.manutencao },
        currentStage: { key: 'ABERTURA' },
        currentResponsible: { id: FAKE_USERS.lucia.id },
        creationChannel: 'DUPLICATION',
        version: 1,
        // Nunca copiados (RN-PROC-119).
        internalCode: null,
        targetDate: null,
        estimatedValue: null,
        estimatedValueSource: null,
      });

      // Itens: os mesmos 3, com sequência própria e sem os valores que vinham dos documentos.
      const copied = activeItemsOf(created.id);
      expect(copied.map((item) => [item.sequence, item.description, item.lotName])).toEqual(
        sourceItems.map((item) => [item.sequence, item.description, item.lotName]),
      );
      expect(copied.every((item) => !sourceItems.some((origin) => origin.id === item.id))).toBe(
        true,
      );
      expect(
        copied.map((item) => [item.referenceQuantity, item.referenceUnitPrice, item.version]),
      ).toEqual(Array(3).fill([null, null, 1]));

      // Sem aprovações, tramitações nem participantes da origem: só a abertura do novo.
      const repository = processRepositoryOf(api);
      expect(repository.stagesOf(created.id).map((stage) => stage.sequence)).toEqual([1]);
      expect(repository.movementsOf(created.id).map((movement) => movement.action)).toEqual([
        'CREATE',
      ]);
      expect(
        repository
          .accessOf(created.id)
          .map((row) => row.reason)
          .sort(),
      ).toEqual(['CREATOR', 'CURRENT', 'REQUESTING', 'REQUESTING', 'RESPONSIBLE']);

      // Eventos: ProcessCreated (novo, com duplicatedFromId) e ProcessDuplicated (origem).
      expect(api.outboxRows().filter((row) => row.aggregateId === created.id)).toEqual([
        expect.objectContaining({
          eventType: 'ProcessCreated',
          payload: expect.objectContaining({
            code: '0013/2026',
            creationChannel: 'DUPLICATION',
            duplicatedFromId: source.id,
          }) as unknown,
        }),
      ]);
      expect(
        api
          .outboxRows()
          .filter((row) => row.eventType === 'ProcessDuplicated' && row.aggregateId === source.id),
      ).toEqual([
        expect.objectContaining({
          routingKey: 'process.duplicated',
          processId: source.id,
          payload: {
            sourceProcessId: source.id,
            newProcessId: created.id,
            options: { copyDocuments: false, copyAttachments: false },
          },
        }),
      ]);

      // Auditoria: process.duplicate na origem e process.create (com duplicatedFromId) no novo.
      expect(auditOf('process.duplicate').at(-1)).toMatchObject({
        category: 'DATA_CHANGE',
        entityId: source.id,
        processId: source.id,
        changes: [{ path: 'newProcessId', old: null, new: created.id }],
        metadata: {
          copyDocuments: false,
          copyAttachments: false,
          itemsCopied: 3,
          idempotencyKey: 'a011a011-0000-4000-8000-000000000001',
        },
      });
      expect(auditOf('process.create').at(-1)).toMatchObject({
        entityId: created.id,
        metadata: { duplicatedFromId: source.id, code: '0013/2026' },
      });

      // Timeline na origem e no novo.
      const timeline = timelineRowsOf(api);
      expect(timeline.filter((row) => row.processId === source.id).map((row) => row.type)).toEqual([
        'PROCESS_CREATED',
        'PROCESS_DUPLICATED',
      ]);
      expect(timeline.find((row) => row.type === 'PROCESS_DUPLICATED')?.params).toEqual({
        newProcessId: created.id,
        newCode: '0013/2026',
      });
      expect(
        timeline
          .filter((row) => row.processId === created.id)
          .map((row) => [row.type, row.params.sourceCode ?? null]),
      ).toEqual([
        ['PROCESS_CREATED', null],
        ['PROCESS_DUPLICATED_FROM', '0012/2026'],
      ]);

      // A origem não muda (RN-PROC-125): versão e itens intactos.
      const after = await getAs(api, `/processes/${source.id}`, 'sub-lucia', A);
      expect(data<ProcessDto>(after)).toMatchObject({
        version: source.version,
        duplicatedFromId: null,
      });
      expect(activeItemsOf(source.id)).toEqual(
        sourceItems.map((item) => expect.objectContaining({ id: item.id }) as unknown),
      );
    });

    it('Duplicar copiando documentos estruturados como rascunho e anexos por cópia lógica, com título ajustado', async () => {
      const source = await newSource();
      const dfd = await createDocumentAs(api, LUCIA, {
        processId: source.id,
        documentTypeId: dfdTypeId,
        title: 'DFD da merenda escolar',
        templateVersionId: null,
        draftContent: {
          sections: {
            NECESSIDADE: {
              state: 'FILLED',
              content: { type: 'doc', content: [{ type: 'paragraph' }] },
              justification: null,
              revision: 4,
              updatedAt: NOW.toISOString(),
              updatedById: FAKE_USERS.lucia.id,
            },
          },
        },
      });
      // DFD aprovado na origem (versão e aprovação próprias).
      const approvedVersionId = newId();
      documentRepositoryOf(api).seed({
        ...dfd,
        status: 'APPROVED',
        currentVersionId: approvedVersionId,
        currentVersionNumber: 1,
        approvedVersionId,
        approvedAt: NOW,
        submittedAt: NOW,
        submittedById: FAKE_USERS.lucia.id,
      });
      // Despacho (texto livre) não é estruturado: nunca copiado.
      await createDocumentAs(api, LUCIA, {
        processId: source.id,
        documentTypeId: despachoTypeId,
        title: 'Despacho de encaminhamento',
        templateVersionId: null,
      });
      const ofProcess = seedAttachment(source.id, { targetType: 'PROCESS', targetId: source.id });
      const ofDfd = seedAttachment(source.id, { targetType: 'DOCUMENT', targetId: dfd.id });

      const response = await duplicate(source.id, {
        title: 'Merenda escolar 2027',
        copyDocuments: true,
        copyAttachments: true,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = data<ProcessDto>(response);
      expect(created.title).toBe('Merenda escolar 2027');
      const documents = documentRepositoryOf(api)
        .allDocuments()
        .filter((document) => document.processId === created.id);
      expect(documents).toHaveLength(1);
      const [copy] = documents;
      expect(copy).toMatchObject({
        documentTypeId: dfdTypeId,
        status: 'DRAFT',
        title: 'DFD da merenda escolar',
        sourceDocumentId: dfd.id,
        // Nenhuma versão nem aprovação do DFD original.
        currentVersionId: null,
        approvedVersionId: null,
        pendingApprovalId: null,
        approvedAt: null,
        submittedAt: null,
        responsibleId: FAKE_USERS.lucia.id,
      });
      expect(copy?.code).not.toBe(dfd.code);
      expect(copy?.draftContent.sections.NECESSIDADE).toMatchObject({
        state: 'FILLED',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        revision: 1,
      });
      expect(
        api
          .outboxRows()
          .filter((row) => row.eventType === 'DocumentCreated' && row.processId === created.id),
      ).toEqual([
        expect.objectContaining({
          aggregateId: copy?.id,
          payload: expect.objectContaining({ sourceDocumentId: dfd.id }) as unknown,
        }),
      ]);

      // Anexos: novos registros com o MESMO objeto de armazenamento.
      const copiedAttachments = attachmentsOf(api).filter((row) => row.processId === created.id);
      expect(
        copiedAttachments.map((row) => [row.targetType, row.targetId, row.sourceAttachmentId]),
      ).toEqual([
        ['PROCESS', created.id, ofProcess.id],
        ['DOCUMENT', copy?.id, ofDfd.id],
      ]);
      expect(copiedAttachments.map((row) => row.storageKey)).toEqual([
        ofProcess.storageKey,
        ofDfd.storageKey,
      ]);
      expect(auditOf('process.duplicate').at(-1)?.metadata).toMatchObject({
        copyDocuments: true,
        copyAttachments: true,
        documentsCopied: 1,
        attachmentsCopied: 2,
      });
    });

    it('Ajuste do setor solicitante no diálogo: workflow e concessões do novo setor', async () => {
      const source = await newSource();
      const response = await duplicate(source.id, {
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.pavimentacao,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = data<ProcessDto>(response);
      expect(created.requestingDepartment.id).toBe(UNITS_A.pavimentacao);
      expect(
        processRepositoryOf(api)
          .accessOf(created.id)
          .filter((row) => row.reason === 'REQUESTING')
          .map((row) => row.departmentId)
          .sort(),
      ).toEqual([UNITS_A.obras, UNITS_A.pavimentacao].sort());
    });
  });

  describe('[Validação]', () => {
    it('Referência inativa copiada da origem: 422 REFERENCE_INACTIVE em modalityId e nada criado', async () => {
      const source = await newSource();
      const catalog = catalogItemRepositoryOf(api);
      const modality = catalog.snapshot().find((item) => item.id === modalityId);
      if (!modality) throw new Error('modalidade ausente');
      catalog.seed({ ...modality, isActive: false });
      const total = processesOf(A).length;
      const before = numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026');
      try {
        const problem = expectProblem(await duplicate(source.id), 422, 'VALIDATION_ERROR');
        expect(problem.errors.map((error) => [error.field, error.code])).toEqual([
          ['modalityId', 'REFERENCE_INACTIVE'],
        ]);
        expect(processesOf(A)).toHaveLength(total);
        expect(numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026')).toBe(before);
      } finally {
        catalog.seed(modality);
      }
    });

    it('Título curto e setor fora da secretaria: VALIDATION_ERROR com os campos', async () => {
      const source = await newSource();
      const short = expectProblem(
        await duplicate(source.id, { title: 'Obra' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(short.errors.map((error) => error.field)).toEqual(['title']);
      const outside = expectProblem(
        await duplicate(source.id, {
          requestingSecretariatId: UNITS_A.saude,
          requestingDepartmentId: UNITS_A.manutencao,
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(outside.errors.map((error) => [error.field, error.code])).toEqual([
        ['requestingDepartmentId', 'DEPARTMENT_NOT_IN_SECRETARIAT'],
      ]);
      expect(duplicatesOf(source.id)).toHaveLength(0);
    });
  });

  describe('[Permissão]', () => {
    it('Usuária sem PROCESS_DUPLICATE na origem: 403, access.denied PROCESS_DUPLICATE e a ação some do menu', async () => {
      const source = await newSource();
      const response = await duplicate(source.id, {}, { subject: 'sub-otavio' });
      const problem = expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(problem.detail).toBe('Você não tem permissão para duplicar este processo.');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'PROCESS_DUPLICATE' });
      expect(duplicatesOf(source.id)).toHaveLength(0);

      const offered = async (subject: string) => {
        const actions = await getAs(api, `/processes/${source.id}/available-actions`, subject, A);
        expect(actions.status, JSON.stringify(actions.body)).toBe(200);
        return data<ActionEntry[]>(actions).filter((entry) => entry.action === 'DUPLICATE');
      };
      expect(await offered('sub-otavio')).toEqual([]);
      expect(await offered('sub-lucia')).toEqual([
        { action: 'DUPLICATE', label: 'Duplicar processo', enabled: true, reasons: [] },
      ]);
    });

    it('Sem PROCESS_CREATE no setor do novo processo (Ana fora da Pavimentação): 403 e nada criado', async () => {
      const source = await newSource();
      const before = numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026');
      const response = await duplicate(
        source.id,
        { requestingDepartmentId: UNITS_A.pavimentacao },
        { subject: 'sub-ana' },
      );
      const problem = expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(problem.detail).toBe('Você não pode abrir processos para este setor.');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'PROCESS_CREATE' });
      expect(duplicatesOf(source.id)).toHaveLength(0);
      expect(numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026')).toBe(before);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Duplicar processo de outro tenant: 404 PROCESS_NOT_FOUND, igual ao inexistente', async () => {
      const foreign = await newSource('sub-heitor', B);
      const totalA = processesOf(A).length;
      const totalB = processesOf(B).length;
      expectProblem(await duplicate(foreign.id), 404, 'PROCESS_NOT_FOUND');
      expectProblem(await duplicate(randomUUID()), 404, 'PROCESS_NOT_FOUND');
      expect(processesOf(A)).toHaveLength(totalA);
      expect(processesOf(B)).toHaveLength(totalB);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: mesmo processo, "Idempotent-Replayed: true" e uma única cópia', async () => {
      const source = await newSource();
      const key = randomUUID();
      const original = await duplicate(source.id, { copyDocuments: true }, { key });
      expect(original.status, JSON.stringify(original.body)).toBe(201);
      const replay = await duplicate(source.id, { copyDocuments: true }, { key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<ProcessDto>(replay).id).toBe(data<ProcessDto>(original).id);
      expect(duplicatesOf(source.id)).toHaveLength(1);
      expectProblem(
        await duplicate(source.id, { copyDocuments: false }, { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Duas duplicações simultâneas da mesma origem: números distintos, sem lacunas, mesma origem', async () => {
      const source = await newSource();
      const before = numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026');
      const responses = await Promise.all([
        duplicate(source.id).then((response) => response),
        duplicate(source.id, {}, { subject: 'sub-ana' }).then((response) => response),
      ]);
      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      const created = responses.map((response) => data<ProcessDto>(response));
      expect(created.map((process) => process.number).sort()).toEqual([before + 1, before + 2]);
      expect(created.map((process) => process.duplicatedFromId)).toEqual([source.id, source.id]);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      const source = await newSource();
      seedItem(source.id, 1);
      const events = api.outboxRows().length;
      const itemsBefore = items().all().length;
      transactions.down = true;
      const response = await duplicate(source.id, { copyDocuments: true, copyAttachments: true });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(duplicatesOf(source.id)).toHaveLength(0);
      expect(items().all()).toHaveLength(itemsBefore);
      expect(api.outboxRows()).toHaveLength(events);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 201 e os eventos ficam no outbox para publicar depois', async () => {
      // Sem relay no modo em memória: as linhas ficam como `PENDING` ficariam no PostgreSQL.
      const source = await newSource();
      const response = await duplicate(source.id);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = data<ProcessDto>(response);
      expect(processesOf(A).some((process) => process.id === created.id)).toBe(true);
      expect(
        api
          .outboxRows()
          .filter((row) => [created.id, source.id].includes(row.aggregateId))
          .map((row) => row.eventType),
      ).toEqual(expect.arrayContaining(['ProcessCreated', 'ProcessDuplicated']));
    });
  });
});

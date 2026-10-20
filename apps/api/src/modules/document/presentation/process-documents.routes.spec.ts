import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  processDocumentSchema,
  processDocumentsMetaSchema,
} from '@contrataflow/validation';
import type { ProcessDocumentDto, ProcessDocumentsMeta, Violation } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  buildDocument,
  createDocumentAs,
  documentFacadeOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  runAsUser,
  stageDocumentTypes,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  PROCESS_PREREQUISITE_SEEDERS,
  runTenantSeeders,
  seedProcessStructure,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { DocumentValidatorRegistry } from '../application/document.ports.js';
import type { DocumentValidator } from '../application/document.ports.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';

/*
 * US-062 — DOC-01 (`GET /processes/{id}/documents`) pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, `PROCESS_VIEW` com escopo de processo, filtro RFC 9457) com a identidade fake, os
 * seeders reais (tipos de documento, perfis, workflow padrão), o processo criado pelo PRC-02 e os
 * adaptadores em memória. Os cenários do Gherkin (8 categorias), a matriz de perfis do menu
 * "Criar documento" e POL-09 no resumo tipado. RLS e visibilidade no PostgreSQL:
 * `test/tenant-leak/process-documents.spec.ts`.
 *
 * Personas: "Ana" do Gherkin (vê o processo e é custodiante) = Lúcia (GESTOR_CONTRATACOES, cria o
 * processo e é a responsável); a Ana do diretório (REQUISITANTE lotada no setor solicitante) vê o
 * processo sem custódia nem orçamento sigiloso; "Bruno" sem `PROCESS_VIEW` = Otávio
 * (CONSULTOR_EXTERNO, sem participação).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');

const ORG_A = '0192d062-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d062-0000-7000-8000-0000000000a1',
  manutencao: '0192d062-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d062-0000-7000-8000-0000000000a3',
  saude: '0192d062-0000-7000-8000-0000000000a4',
  posto: '0192d062-0000-7000-8000-0000000000a5',
};

/** Etapa "Estudos preliminares" do Background: admite ETP, DESPACHO e OFICIO. */
const STAGE_CODES = ['ETP', 'DESPACHO', 'OFICIO'];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** Transações do módulo que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements DocumentTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }
}

/** Módulo tipado ETP simulado: o resumo do cartão traz o valor total (POL-09 · RN-DOC-17). */
class FakeEtpValidator implements DocumentValidator {
  readonly module = 'ETP' as const;

  validate(): Promise<readonly Violation[]> {
    return Promise.resolve([]);
  }

  typedSummary(): Promise<Readonly<Record<string, unknown>>> {
    return Promise.resolve({ estimatedTotalValue: '125000.00', solutionsCount: 2 });
  }
}

interface PanelBody {
  readonly data: ProcessDocumentDto[];
  readonly meta: ProcessDocumentsMeta;
}

function panelOf(response: request.Response): PanelBody {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const body = response.body as PanelBody;
  return {
    data: body.data.map((item) => processDocumentSchema.parse(item)),
    meta: processDocumentsMetaSchema.parse(body.meta),
  };
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Painel de documentos do processo (US-062)', () => {
  let api: TestApi;
  let cache: InMemoryCacheStore;
  const transactions = new FlakyTransactions();
  /** Processos na etapa do Background (os demais seguem o workflow padrão). */
  let stageCodes: Map<string, readonly string[]>;
  let types: Record<'dfd' | 'etp' | 'tr' | 'despacho' | 'oficio' | 'notaTecnica', string>;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  async function newProcess(codes: readonly string[] = STAGE_CODES): Promise<string> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    stageCodes.set(id, codes);
    return id;
  }

  const newDocument = (processId: string, documentTypeId: string, title: string) =>
    createDocumentAs(api, LUCIA, { processId, documentTypeId, title, templateVersionId: null });

  /** A tramitação (US-047/051) leva o documento à aprovação da etapa: selo "Em aprovação". */
  async function sendToApproval(documentId: string) {
    const approvalId = newId();
    const { documentVersionId } = await runAsUser(LUCIA, (tx) =>
      documentFacadeOf(api).enterApprovalStageIn(tx, { documentId, approvalId }),
    );
    return { approvalId, documentVersionId };
  }

  const panel = (
    processId: string,
    options: { subject?: string; tenant?: string; query?: string } = {},
  ) =>
    request(api.server)
      .get(`/api/v1/processes/${processId}/documents${options.query ?? ''}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);

  const stored = (id: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .find((row) => row.id === id);
  let logSpy: MockInstance;
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeAll(async () => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    cache = api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false });
    // US-063 · FA-05: o livre só entra no menu com template padrão publicado (biblioteca US-110).
    await runTenantSeeders(api, A, [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary']);
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
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    // A etapa atual do Background (`documentTypeCodes`) — a tramitação (US-047) ainda não move.
    stageCodes = stageDocumentTypes(api, 'Estudos preliminares');
    api.app.get(DocumentValidatorRegistry).override(new FakeEtpValidator());

    const seeded = documentTypeRepositoryOf(api)
      .snapshot()
      .filter((type) => type.tenantId === A);
    const idOf = (code: string) => seeded.find((type) => type.code === code)?.id ?? '';
    types = {
      dfd: idOf('DFD'),
      etp: idOf('ETP'),
      tr: idOf('TR'),
      despacho: idOf('DESPACHO'),
      oficio: idOf('OFICIO'),
      notaTecnica: idOf('NOTA_TECNICA'),
    };
    expect(Object.values(types).every((id) => id !== '')).toBe(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  describe('[Sucesso]', () => {
    it('Ver documentos agrupados por tipo com selo "Em aprovação"; o menu oferece Ofício e não ETP', async () => {
      const processId = await newProcess();
      const etp = await newDocument(processId, types.etp, 'Estudo Técnico Preliminar');
      const despacho = await newDocument(processId, types.despacho, 'Despacho de encaminhamento');
      const { approvalId } = await sendToApproval(etp.id);

      const { data, meta } = panelOf(await panel(processId));
      // RN-DOC-13: por `sortOrder` do tipo (ETP antes de DESPACHO no catálogo de sistema).
      expect(data.map((item) => item.documentType.code)).toEqual(['ETP', 'DESPACHO']);
      const [etpCard, despachoCard] = data;
      expect(etpCard).toMatchObject({
        id: etp.id,
        title: 'Estudo Técnico Preliminar',
        pendingApprovalId: approvalId,
        documentType: { code: 'ETP', kind: 'STRUCTURED' },
      });
      expect(despachoCard).toMatchObject({
        id: despacho.id,
        status: 'DRAFT',
        pendingApprovalId: null,
        responsibleId: FAKE_USERS.lucia.id,
        responsibleName: FAKE_USERS.lucia.name,
      });
      // O painel nunca carrega o rascunho de trabalho (DOC-03 é quem traz).
      expect(despachoCard).not.toHaveProperty('draftContent');
      // RN-DOC-18: a mesma função pura do DOC-03.
      const detail = await request(api.server)
        .get(`/api/v1/documents/${despacho.id}`)
        .set('Authorization', api.bearer('sub-lucia', { amr: ['pwd', 'otp'] }))
        .set('X-Tenant-Id', A);
      expect(despachoCard?.meta.allowedActions).toEqual(
        (detail.body as { meta: { allowedActions: string[] } }).meta.allowedActions,
      );
      expect(despachoCard?.meta.allowedActions).toEqual(
        expect.arrayContaining(['UPDATE', 'CANCEL', 'DELETE']),
      );

      // RN-DOC-16: tipos da etapa, com permissão; ETP singular já existe (FA-05: DFD/TR fora).
      expect(meta.currentStage).toMatchObject({
        name: 'Estudos preliminares',
        documentTypeCodes: STAGE_CODES,
      });
      expect(meta.creatableTypeIds).toEqual([types.despacho, types.oficio]);
      expect(meta.pendingTypeIds).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'document_panel.loaded',
          processId,
          documentCount: 2,
          durationMs: expect.any(Number) as number,
        }),
        'document_panel.loaded',
      );
      // Nunca loga título de documento.
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('Estudo Técnico Preliminar');
    });

    it('FA-01/FA-04: processo sem documentos → lista vazia, singular da etapa "Não iniciado" e menu completo', async () => {
      const processId = await newProcess();
      const { data, meta } = panelOf(await panel(processId));
      expect(data).toEqual([]);
      expect(meta.pendingTypeIds).toEqual([types.etp]);
      expect(meta.creatableTypeIds).toEqual([types.etp, types.despacho, types.oficio]);
    });

    it('FA-02: tipo desativado some do menu; o documento já criado continua visível', async () => {
      const processId = await newProcess();
      const oficio = await newDocument(processId, types.oficio, 'Ofício à secretaria');
      const repository = documentTypeRepositoryOf(api);
      const original = repository.snapshot().find((type) => type.id === types.oficio);
      expect(original).toBeDefined();
      if (original === undefined) return;
      repository.seed({ ...original, isActive: false });
      cache.entries.clear();
      try {
        const { data, meta } = panelOf(await panel(processId));
        expect(data.map((item) => item.id)).toEqual([oficio.id]);
        expect(meta.creatableTypeIds).not.toContain(types.oficio);
      } finally {
        repository.seed(original);
        cache.entries.clear();
      }
    });

    it('RN-DOC-19/20: cancelado permanece visível; filtros de status, tipo, responsável e busca sobre a lista', async () => {
      const processId = await newProcess();
      const first = await newDocument(processId, types.despacho, 'Despacho de abertura');
      const canceled = await newDocument(processId, types.despacho, 'Despacho substituído');
      documentRepositoryOf(api).seed({
        ...(stored(canceled.id) ?? canceled),
        status: 'CANCELED',
        cancellationReason: 'Substituído por outro despacho do setor.',
      });
      const oficio = await newDocument(processId, types.oficio, 'Ofício à secretaria de saúde');

      const all = panelOf(await panel(processId)).data;
      expect(all.map((item) => item.id)).toEqual([first.id, canceled.id, oficio.id]);
      expect(all.find((item) => item.id === canceled.id)?.status).toBe('CANCELED');

      const ids = async (query: string) =>
        panelOf(await panel(processId, { query })).data.map((item) => item.id);
      expect(await ids('?status=CANCELED')).toEqual([canceled.id]);
      expect(await ids('?status=DRAFT,CANCELED')).toEqual([first.id, canceled.id, oficio.id]);
      expect(await ids(`?type=${types.oficio}`)).toEqual([oficio.id]);
      expect(await ids('?q=saude')).toEqual([oficio.id]);
      expect(await ids(`?responsibleId=${FAKE_USERS.ana.id}`)).toEqual([]);
      expect(await ids(`?responsibleId=${FAKE_USERS.lucia.id}&q=abertura`)).toEqual([first.id]);
    });
  });

  describe('[Validação]', () => {
    it('Filtro de status inválido: 422 VALIDATION_ERROR com INVALID_ENUM no campo status', async () => {
      const processId = await newProcess();
      const body = expectProblem(
        await panel(processId, { query: '?status=NAO_EXISTE' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'status', code: 'INVALID_ENUM' }),
      ]);
    });

    it('Tipo fora do catálogo do tenant: 422 REFERENCE_NOT_FOUND no campo type; busca com 1 caractere: 422', async () => {
      const processId = await newProcess();
      const body = expectProblem(
        await panel(processId, { query: `?type=${newId()}` }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'type', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      const short = expectProblem(
        await panel(processId, { query: '?q=a' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(short.errors).toEqual([expect.objectContaining({ field: 'q' })]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem PROCESS_VIEW nem participação: 404 PROCESS_NOT_FOUND e access.denied auditado', async () => {
      const processId = await newProcess();
      await newDocument(processId, types.despacho, 'Despacho de encaminhamento');
      const response = await panel(processId, { subject: 'sub-otavio' });
      expectProblem(response, 404, 'PROCESS_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Despacho');
      expect(
        api
          .auditRecords()
          .filter((row) => row.action === 'access.denied')
          .at(-1),
      ).toMatchObject({ reasonCode: 'PROCESS_VIEW' });
    });

    it('Matriz do menu: quem vê sem custódia nem participação (POL-02) não recebe tipos para criar', async () => {
      const processId = await newProcess();
      const despacho = await newDocument(processId, types.despacho, 'Despacho de encaminhamento');
      const { data, meta } = panelOf(await panel(processId, { subject: 'sub-ana' }));
      expect(data.map((item) => item.id)).toEqual([despacho.id]);
      expect(data[0]?.meta.allowedActions).toEqual([]);
      expect(meta.creatableTypeIds).toEqual([]);
      // O pendente continua aparecendo (é situação do processo, não ação do usuário).
      expect(meta.pendingTypeIds).toEqual([types.etp]);
    });

    it('FA-03/RN-DOC-17: resumo de documento RESTRICTED mascarado para quem não atende POL-09', async () => {
      const processId = await newProcess();
      const etp = await newDocument(processId, types.etp, 'Estudo Técnico Preliminar');
      documentRepositoryOf(api).seed({
        ...(stored(etp.id) ?? etp),
        confidentiality: 'RESTRICTED',
      });
      const masked = panelOf(await panel(processId, { subject: 'sub-ana' })).data[0];
      expect(masked).toMatchObject({
        code: etp.code,
        title: 'Estudo Técnico Preliminar',
        status: 'DRAFT',
        summary: { estimatedTotalValue: null, estimatedTotalValueMasked: true, solutionsCount: 2 },
      });
      // A custodiante desmascara (POL-09 — custódia atual).
      const open = panelOf(await panel(processId)).data[0];
      expect(open?.summary).toEqual({ estimatedTotalValue: '125000.00', solutionsCount: 2 });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant: 404 PROCESS_NOT_FOUND sem revelar dados de B', async () => {
      const processId = await newProcess();
      const source = processRepositoryOf(api)
        .allProcesses()
        .find((process) => process.id === processId);
      expect(source).toBeDefined();
      if (source === undefined) return;
      const foreignId = newId();
      processRepositoryOf(api).seed({
        ...source,
        id: foreignId,
        tenantId: B,
        code: '0003/2026',
        title: 'Processo LEAK-B',
      });
      documentRepositoryOf(api).seed(
        buildDocument({
          tenantId: B,
          processId: foreignId,
          documentTypeId: newId(),
          title: 'Documento LEAK-B',
        }),
      );
      const response = await panel(foreignId);
      const leaked = expectProblem(response, 404, 'PROCESS_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      // Mesmo corpo do processo inexistente.
      const missing = expectProblem(await panel(newId()), 404, 'PROCESS_NOT_FOUND');
      expect(missing.detail).toBe(leaked.detail);
    });
  });

  describe('[Duplicidade]', () => {
    it('Tipo singular já existente: a opção ETP não aparece e a criação direta responde 409 DOCUMENT_ALREADY_EXISTS', async () => {
      const processId = await newProcess();
      const etp = await newDocument(processId, types.etp, 'Estudo Técnico Preliminar');
      documentRepositoryOf(api).seed({ ...(stored(etp.id) ?? etp), status: 'APPROVED' });

      const { meta } = panelOf(await panel(processId));
      expect(meta.creatableTypeIds).not.toContain(types.etp);
      expect(meta.pendingTypeIds).not.toContain(types.etp);
      // A fábrica única que o DOC-02 (US-063/064) e os módulos tipados chamam.
      await expect(newDocument(processId, types.etp, 'Outro ETP')).rejects.toMatchObject({
        code: 'DOCUMENT_ALREADY_EXISTS',
        status: 409,
      });

      // Cancelado libera a vaga: o tipo volta ao menu e fica "Não iniciado".
      documentRepositoryOf(api).seed({
        ...(stored(etp.id) ?? etp),
        status: 'CANCELED',
        cancellationReason: 'Estudo substituído por nova versão do setor.',
      });
      const after = panelOf(await panel(processId)).meta;
      expect(after.creatableTypeIds).toContain(types.etp);
      expect(after.pendingTypeIds).toEqual([types.etp]);
    });
  });

  describe('[Concorrência]', () => {
    it('Aprovação decidida por outra sessão: a nova consulta mostra "Aprovado" sem o selo', async () => {
      const processId = await newProcess();
      const etp = await newDocument(processId, types.etp, 'Estudo Técnico Preliminar');
      const { approvalId, documentVersionId } = await sendToApproval(etp.id);
      const before = panelOf(await panel(processId)).data[0];
      expect(before).toMatchObject({ status: 'IN_REVIEW', pendingApprovalId: approvalId });

      // "Carla" decide em outra sessão (US-052).
      await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).applyApprovalDecisionIn(tx, {
          documentId: etp.id,
          approvalId,
          outcome: 'APPROVED',
          analyzedVersionId: documentVersionId,
        }),
      );
      const after = panelOf(await panel(processId)).data[0];
      expect(after).toMatchObject({ status: 'APPROVED', pendingApprovalId: null });
      expect(after?.version).toBeGreaterThan(before?.version ?? 0);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After e error document_panel.load_failed', async () => {
      const processId = await newProcess();
      transactions.down = true;
      const response = await panel(processId);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'document_panel.load_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
          correlationId: expect.any(String) as string,
        }),
        'document_panel.load_failed',
      );
    });
  });

  describe('[Falha de integração]', () => {
    it('Cache de tipos (Redis) indisponível: tipos lidos do banco e warn document_type.cache_unavailable', async () => {
      const processId = await newProcess();
      await newDocument(processId, types.despacho, 'Despacho de encaminhamento');
      const failing = vi.spyOn(cache, 'get').mockRejectedValue(new Error('redis indisponível'));
      try {
        const { data, meta } = panelOf(await panel(processId));
        expect(data).toHaveLength(1);
        expect(meta.creatableTypeIds).toEqual([types.etp, types.despacho, types.oficio]);
      } finally {
        failing.mockRestore();
      }
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'document_type.cache_unavailable' }),
        'document_type.cache_unavailable',
      );
    });
  });
});

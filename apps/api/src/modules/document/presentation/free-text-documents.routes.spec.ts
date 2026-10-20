import { randomUUID } from 'node:crypto';

import {
  documentMetaSchema,
  documentSchema,
  documentSectionSavedSchema,
  problemDetailsSchema,
  processDocumentsMetaSchema,
  richTextFromPlainText,
  richTextPlainText,
} from '@contrataflow/validation';
import type { DocumentDto, DocumentMeta } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  buildDocumentType,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  openStageForAnyType,
  runAsUser,
  templateRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  PROCESS_PREREQUISITE_SEEDERS,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';

/*
 * US-063 — documento livre a partir do template (DOC-02 `FREE_TEXT` → SCR-105 → autosave DOC-05)
 * pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização, idempotência, `If-Match`
 * de seção, filtro RFC 9457) com a identidade fake, os seeders reais (inclusive a biblioteca de
 * templates — US-110: o DESPACHO nasce com o modelo padrão publicado, seção `CONTENT`) e os
 * adaptadores em memória. Os 8 cenários do Gherkin + V-01..V-09 e FA-05. RLS, numeração e outbox
 * `PENDING` sobre PostgreSQL: `test/tenant-leak/free-text-documents.spec.ts`.
 *
 * Personas: "Ana" do Gherkin (custodiante com DOCUMENT_CREATE/UPDATE) = Lúcia (GESTOR_CONTRATACOES,
 * cria o processo e fica responsável); "Bruno" (sem DOCUMENT_CREATE) = Marta (ADMIN_ORGAO, vê o
 * processo); "Carla" (edição simultânea) = Ana, REQUISITANTE do setor solicitante feita
 * COLLABORATOR do processo (POL-02).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');
const KEY = 'CONTENT';

const ORG_A = '0192d063-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d063-0000-7000-8000-0000000000a1',
  manutencao: '0192d063-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d063-0000-7000-8000-0000000000a3',
  saude: '0192d063-0000-7000-8000-0000000000a4',
  posto: '0192d063-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do `document` que podem simular o banco fora do ar (Falha de banco). */
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

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

function created(response: request.Response): { document: DocumentDto; meta: DocumentMeta } {
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const body = response.body as { data: unknown; meta: unknown };
  return { document: documentSchema.parse(body.data), meta: documentMetaSchema.parse(body.meta) };
}

describe('Feature: Criar documento livre a partir de template (US-063)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let openStages: Set<string>;
  let types: {
    despacho: string;
    dfd: string;
    semModelo: string;
    inativo: string;
    despachoB: string;
  };

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  /** Processo novo (PRC-02) criado por Lúcia, que fica responsável (custódia — POL-01). */
  async function newProcess(options: { openStage?: boolean } = {}): Promise<string> {
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
    if (options.openStage !== false) openStages.add(id);
    return id;
  }

  const call = (
    method: 'get' | 'post' | 'put',
    path: string,
    options: {
      subject?: string;
      tenant?: string;
      key?: string;
      ifMatch?: string;
      body?: object;
    } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method === 'post') pending = pending.set('Idempotency-Key', options.key ?? randomUUID());
    if (options.ifMatch !== undefined) pending = pending.set('If-Match', options.ifMatch);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  /** DOC-02. */
  const createDocument = (
    processId: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; tenant?: string; key?: string } = {},
  ) =>
    call('post', `/processes/${processId}/documents`, {
      ...options,
      body: {
        documentTypeId: types.despacho,
        title: 'Encaminhamento à Secretaria de Obras',
        ...body,
      },
    });

  /** DOC-05 com `If-Match: "s<revision>"`. */
  const saveSection = (
    documentId: string,
    revision: number,
    body: Record<string, unknown>,
    options: { subject?: string; key?: string } = {},
  ) =>
    call('put', `/documents/${documentId}/sections/${options.key ?? KEY}`, {
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ifMatch: `"s${String(revision)}"`,
      body,
    });

  const text = (value: string) => ({ content: richTextFromPlainText(value), notApplicable: false });

  const panelMeta = async (processId: string, subject = 'sub-lucia') => {
    const response = await call('get', `/processes/${processId}/documents`, { subject });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processDocumentsMetaSchema.parse((response.body as { meta: unknown }).meta);
  };

  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((row) => row.processId === processId);
  const storedDocument = (id: string) => {
    const row = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === id);
    if (!row) throw new Error(`documento ${id} não gravado`);
    return row;
  };
  const auditOf = (action: string, entityId: string) =>
    api.auditRecords().filter((row) => row.action === action && row.entityId === entityId);
  const eventsOf = (aggregateId: string, eventType: string) =>
    api
      .outboxRows()
      .filter((row) => row.aggregateId === aggregateId && row.eventType === eventType);

  /** A versão publicada do template padrão do DESPACHO semeado pela biblioteca (US-110). */
  async function despachoTemplateVersionId(): Promise<string> {
    const type = documentTypeRepositoryOf(api)
      .snapshot()
      .find((row) => row.id === types.despacho);
    const templates = templateRepositoryOf(api);
    const lucia = {
      tenantId: A,
      userId: FAKE_USERS.lucia.id,
      membershipId: membershipOf(FAKE_USERS.lucia.id),
    };
    const template = await runAsUser(lucia, (tx) =>
      templates.findById(tx, type?.defaultTemplateId ?? ''),
    );
    return template?.currentPublishedVersionId ?? '';
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary']);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    // FA-05 / V-02 / V-03: livre ativo sem template padrão e livre inativo, ambos do tenant A.
    const semModelo = buildDocumentType({
      tenantId: A,
      code: 'NOTA_SEM_MODELO',
      name: 'Nota sem modelo',
      sortOrder: 900,
    });
    const inativo = buildDocumentType({
      tenantId: A,
      code: 'DESPACHO_ANTIGO',
      name: 'Despacho antigo',
      isActive: false,
      sortOrder: 901,
    });
    documentTypeRepositoryOf(api).seed(semModelo, inativo);
    openStages = openStageForAnyType(api);
    const seeded = documentTypeRepositoryOf(api).snapshot();
    const idOf = (code: string, tenantId: string = A) =>
      seeded.find((type) => type.code === code && type.tenantId === tenantId)?.id ?? '';
    types = {
      despacho: idOf('DESPACHO'),
      dfd: idOf('DFD'),
      semModelo: semModelo.id,
      inativo: inativo.id,
      despachoB: idOf('DESPACHO', B),
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
  });

  describe('[Sucesso]', () => {
    it('Criar um despacho e salvar automaticamente a primeira seção: DRAFT numerado, evento, timeline, auditoria; autosave revision 2 sem versão', async () => {
      const processId = await newProcess();
      const process = processRepositoryOf(api)
        .allProcesses()
        .find((row) => row.id === processId);

      const response = await createDocument(processId);
      const { document, meta } = created(response);
      const templateVersionId = await despachoTemplateVersionId();
      expect(document).toMatchObject({
        processId,
        title: 'Encaminhamento à Secretaria de Obras',
        status: 'DRAFT',
        templateVersionId,
        currentVersionId: null,
        responsibleId: FAKE_USERS.lucia.id,
        createdById: FAKE_USERS.lucia.id,
        documentType: { id: types.despacho, kind: 'FREE_TEXT', code: 'DESPACHO' },
        version: 1,
      });
      // RN-DOC-24/25: código do sistema pela máscara do tipo, sequência por (tipo, ano).
      expect(document.code).toMatch(/^DESP \d{4}\/2026$/);
      expect(document.year).toBe(2026);
      expect(response.headers.location).toBe(`/api/v1/documents/${document.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(meta.allowedActions).toContain('UPDATE');
      // RN-DOC-23: uma seção por SectionDefinition; defaultContent com variáveis resolvidas.
      const section = document.draftContent.sections[KEY];
      expect(section).toMatchObject({ state: 'FILLED', revision: 1, justification: null });
      const initial = richTextPlainText(section?.content ?? { type: 'doc', content: [] });
      expect(initial).toContain(`Processo ${process?.code ?? '?'} — ${process?.title ?? '?'}.`);
      expect(initial).not.toContain('{{process.');
      expect(Object.keys(document.draftContent.sections)).toEqual([KEY]);
      // meta.template: a versão fixada, com orientação e base legal (SCR-105 sem TEMPLATE_VIEW).
      expect(meta.template).toMatchObject({
        versionId: templateVersionId,
        sections: [
          {
            key: KEY,
            title: 'Conteúdo do despacho',
            order: 1,
            requirement: 'REQUIRED',
            maxChars: 50_000,
          },
        ],
      });
      expect(meta.template?.sections[0]?.helpText).toBeTruthy();
      expect(meta.template?.sections[0]?.legalBasis).toContain('art. 40');

      expect(eventsOf(document.id, 'DocumentCreated')).toEqual([
        expect.objectContaining({
          routingKey: 'document.created.despacho',
          payload: expect.objectContaining({
            documentId: document.id,
            documentTypeCode: 'DESPACHO',
            kind: 'FREE_TEXT',
            code: document.code,
            title: document.title,
            templateVersionId,
          }) as unknown,
        }),
      ]);
      expect(auditOf('document.create', document.id)).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            documentTypeCode: 'DESPACHO',
            templateVersionId,
            code: document.code,
          }) as unknown,
        }),
      ]);
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === processId)
          .map((row) => row.type),
      ).toContain('DOCUMENT_CREATED');

      // Autosave (DOC-05 · RN-DOC-27): revisão da seção 1 → 2, sem DocumentVersion nem status novo.
      const saved = await saveSection(document.id, 1, text('Encaminhem-se os autos à Secretaria.'));
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(
        documentSectionSavedSchema.parse((saved.body as { data: unknown }).data),
      ).toMatchObject({ sectionKey: KEY, state: 'FILLED', revision: 2, draftRevision: 2 });
      expect(documentRepositoryOf(api).versionsOf(document.id)).toHaveLength(0);
      expect(storedDocument(document.id)).toMatchObject({
        status: 'DRAFT',
        version: 1,
        currentVersionId: null,
      });
      expect(eventsOf(document.id, 'DocumentVersionCreated')).toHaveLength(0);

      // DOC-03: o editor relê o rascunho e o template.
      const detail = await call('get', `/documents/${document.id}`);
      expect(detail.status).toBe(200);
      const body = detail.body as { data: DocumentDto; meta: DocumentMeta };
      expect(
        richTextPlainText(body.data.draftContent.sections[KEY]?.content ?? { type: 'doc' }),
      ).toBe('Encaminhem-se os autos à Secretaria.');
      expect(documentMetaSchema.parse(body.meta).template?.versionId).toBe(templateVersionId);
    });

    it('RN-DOC-24: cada criação avança a sequência do tipo; RN-DOC-26: responsável informado na criação', async () => {
      const processId = await newProcess();
      const first = created(await createDocument(processId)).document;
      const second = created(
        await createDocument(processId, {
          title: 'Despacho com outro responsável',
          responsibleId: FAKE_USERS.ana.id,
        }),
      ).document;
      expect((second.number ?? 0) - (first.number ?? 0)).toBe(1);
      expect(second.code).not.toBe(first.code);
      expect(second.responsibleId).toBe(FAKE_USERS.ana.id);
    });

    it('RN-DOC-28: "Não se aplica" com justificativa de 20+ caracteres grava NOT_APPLICABLE', async () => {
      const { document } = created(await createDocument(await newProcess()));
      const short = await saveSection(document.id, 1, {
        content: null,
        notApplicable: true,
        justification: 'curta demais',
      });
      expect(expectProblem(short, 422, 'VALIDATION_ERROR').errors[0]).toMatchObject({
        field: 'justification',
        code: 'TOO_SHORT',
      });
      const saved = await saveSection(document.id, 1, {
        content: null,
        notApplicable: true,
        justification: 'O encaminhamento consta do despacho anterior.',
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(storedDocument(document.id).draftContent.sections[KEY]).toMatchObject({
        state: 'NOT_APPLICABLE',
        revision: 2,
        content: null,
      });
    });
  });

  describe('[Validação]', () => {
    it('Seção excede o limite de caracteres: 422 VALIDATION_ERROR / TOO_LONG e nada gravado', async () => {
      const { document } = created(await createDocument(await newProcess()));
      const response = await saveSection(document.id, 1, text('a'.repeat(50_001)));
      expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors[0]).toMatchObject({
        field: 'content',
        code: 'TOO_LONG',
      });
      expect(storedDocument(document.id).draftContent.sections[KEY]?.revision).toBe(1);
    });

    it('V-05: conteúdo fora do schema do editor → 422 RICH_TEXT_INVALID', async () => {
      const { document } = created(await createDocument(await newProcess()));
      const response = await saveSection(document.id, 1, {
        content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] },
        notApplicable: false,
      });
      expectProblem(response, 422, 'RICH_TEXT_INVALID');
    });

    it('V-01: título fora de 5–250 caracteres → 422 no campo title, sem documento', async () => {
      const processId = await newProcess();
      for (const [title, code] of [
        ['abc', 'TOO_SHORT'],
        ['x'.repeat(251), 'TOO_LONG'],
      ] as const) {
        const problem = expectProblem(
          await createDocument(processId, { title }),
          422,
          'VALIDATION_ERROR',
        );
        expect(problem.errors[0]).toMatchObject({ field: 'title', code });
      }
      expect(documentsOf(processId)).toHaveLength(0);
    });

    it('V-02/V-03 · FA-05: tipo sem modelo publicado, inativo ou de outro kind → 422 em documentTypeId; o sem modelo não aparece no menu', async () => {
      const processId = await newProcess();
      const missing = expectProblem(
        await createDocument(processId, { documentTypeId: types.semModelo }),
        422,
        'VALIDATION_ERROR',
      );
      expect(missing.errors[0]).toEqual({
        field: 'documentTypeId',
        code: 'REFERENCE_INACTIVE',
        message: 'Este tipo de documento não tem um modelo publicado. Fale com o administrador.',
      });
      expect(
        expectProblem(
          await createDocument(processId, { documentTypeId: types.inativo }),
          422,
          'VALIDATION_ERROR',
        ).errors[0],
      ).toMatchObject({ field: 'documentTypeId', code: 'REFERENCE_INACTIVE' });
      expect(
        expectProblem(
          await createDocument(processId, { documentTypeId: types.dfd }),
          422,
          'VALIDATION_ERROR',
        ).errors[0],
      ).toMatchObject({ field: 'documentTypeId', code: 'REFERENCE_NOT_FOUND' });
      expect(documentsOf(processId)).toHaveLength(0);

      const meta = await panelMeta(processId);
      expect(meta.creatableTypeIds).toContain(types.despacho);
      expect(meta.creatableTypeIds).not.toContain(types.semModelo);
      expect(meta.creatableTypeIds).not.toContain(types.inativo);
    });

    it('V-04: tipo fora da etapa atual → 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', async () => {
      // O workflow padrão só admite o DFD na abertura.
      const processId = await newProcess({ openStage: false });
      expectProblem(await createDocument(processId), 422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE');
      expect(documentsOf(processId)).toHaveLength(0);
    });

    it('V-09: documento fora de DRAFT/RETURNED → 409 DOCUMENT_NOT_EDITABLE no autosave', async () => {
      const { document } = created(await createDocument(await newProcess()));
      const finalized = await call('post', `/documents/${document.id}/finalize`, {
        ifMatch: '"1"',
        body: {},
      });
      expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
      expectProblem(
        await saveSection(document.id, 1, text('Texto depois de finalizar.')),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem DOCUMENT_CREATE: o DESPACHO não aparece no menu e o DOC-02 responde 403 PERMISSION_DENIED', async () => {
      const processId = await newProcess();
      // Marta (ADMIN_ORGAO) vê o processo, mas não tem DOCUMENT_CREATE.
      const meta = await panelMeta(processId, 'sub-marta');
      expect(meta.creatableTypeIds).not.toContain(types.despacho);
      expectProblem(
        await createDocument(processId, {}, { subject: 'sub-marta' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(documentsOf(processId)).toHaveLength(0);
    });

    it('POL-02: sem custódia nem participação → 403 na criação e no autosave', async () => {
      const processId = await newProcess();
      const { document } = created(await createDocument(processId));
      // Ana vê o processo (setor solicitante) e tem DOCUMENT_CREATE/UPDATE, mas não é custodiante.
      expectProblem(
        await createDocument(processId, {}, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      const denied = await saveSection(document.id, 1, text('Tentativa sem custódia.'), {
        subject: 'sub-ana',
      });
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(storedDocument(document.id).draftContent.sections[KEY]?.revision).toBe(1);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Tipo de documento de outro tenant → 422 VALIDATION_ERROR / REFERENCE_NOT_FOUND em documentTypeId', async () => {
      const processId = await newProcess();
      const problem = expectProblem(
        await createDocument(processId, { documentTypeId: types.despachoB }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors[0]).toMatchObject({
        field: 'documentTypeId',
        code: 'REFERENCE_NOT_FOUND',
      });
      expect(documentsOf(processId)).toHaveLength(0);
    });

    it('Processo e documento de A chamados de B → 404, sem revelar nem alterar nada', async () => {
      const processId = await newProcess();
      const { document } = created(await createDocument(processId));
      const asHeitor = { subject: 'sub-heitor', tenant: B };
      for (const response of [
        await createDocument(processId, { documentTypeId: types.despachoB }, asHeitor),
        await call('get', `/documents/${document.id}`, asHeitor),
        await call('put', `/documents/${document.id}/sections/${KEY}`, {
          ...asHeitor,
          ifMatch: '"s1"',
          body: text('Intruso'),
        }),
      ]) {
        expect(response.status, JSON.stringify(response.body)).toBe(404);
        expect(JSON.stringify(response.body)).not.toContain('Encaminhamento');
      }
      expect(storedDocument(document.id).draftContent.sections[KEY]?.revision).toBe(1);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da criação com a mesma chave: 201 com o mesmo documento, Idempotent-Replayed: true e um só documento', async () => {
      const processId = await newProcess();
      const key = randomUUID();
      const first = created(await createDocument(processId, {}, { key })).document;
      const replay = await createDocument(processId, {}, { key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((replay.body as { data: { id: string; code: string } }).data).toMatchObject({
        id: first.id,
        code: first.code,
      });
      expect(documentsOf(processId)).toHaveLength(1);
      expect(eventsOf(first.id, 'DocumentCreated')).toHaveLength(1);
      expect(auditOf('document.create', first.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas edições simultâneas da mesma seção a partir da revisão 3: uma vira a 4, a outra recebe 412 SECTION_REVISION_CONFLICT', async () => {
      const processId = await newProcess();
      seedParticipant(api, {
        tenantId: A,
        processId,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const { document } = created(await createDocument(processId));
      expect((await saveSection(document.id, 1, text('Rascunho dois.'))).status).toBe(200);
      expect((await saveSection(document.id, 2, text('Rascunho três.'))).status).toBe(200);

      const responses = await Promise.all([
        saveSection(document.id, 3, text('Versão da Lúcia.')),
        saveSection(document.id, 3, text('Versão da Ana.'), { subject: 'sub-ana' }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
      const loser = responses.find((response) => response.status === 412);
      expect(problemDetailsSchema.parse(loser?.body).code).toBe('SECTION_REVISION_CONFLICT');
      expect(storedDocument(document.id).draftContent.sections[KEY]?.revision).toBe(4);
    });

    it('Duas criações simultâneas com a mesma Idempotency-Key: um só documento', async () => {
      const processId = await newProcess();
      const key = randomUUID();
      const responses = await Promise.all([
        createDocument(processId, {}, { key }),
        createDocument(processId, {}, { key }),
      ]);
      expect(responses.some((response) => response.status === 201)).toBe(true);
      for (const response of responses) expect([201, 409]).toContain(response.status);
      expect(documentsOf(processId)).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao criar: 503 DEPENDENCY_UNAVAILABLE e nenhum documento, auditoria ou evento', async () => {
      const processId = await newProcess();
      const audits = api.auditRecords().length;
      const events = api.outboxRows().length;
      transactions.down = true;
      expectProblem(await createDocument(processId), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(documentsOf(processId)).toHaveLength(0);
      expect(api.auditRecords().length).toBe(audits);
      expect(api.outboxRows().length).toBe(events);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: a criação responde 201 e o DocumentCreated fica gravado para publicar', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const { document } = created(await createDocument(await newProcess()));
      expect(eventsOf(document.id, 'DocumentCreated')).toHaveLength(1);
    });
  });
});

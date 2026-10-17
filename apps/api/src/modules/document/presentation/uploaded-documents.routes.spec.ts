import { createHash, randomUUID } from 'node:crypto';

import {
  attachmentDownloadSchema,
  attachmentIntentResponseSchema,
  documentMetaSchema,
  documentSchema,
  documentVersionSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { DocumentDto, DocumentVersionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { InMemoryObjectStorage } from '#shared/storage/in-memory-object-storage.js';
import { OBJECT_STORAGE } from '#shared/storage/storage.service.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { jobQueueOf } from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  createDocumentAs,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  openStageForAnyType,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
import {
  ANTIVIRUS,
  ATTACHMENT_REPOSITORY,
  AntivirusCircuit,
  FILES_CLOCK,
  FakeAntivirus,
  ScanDeferredError,
  ScanFileJob,
  createAttachment,
} from '../../../../test/support/files-fixtures.js';
import type { InMemoryAttachmentRepository } from '../../../../test/support/files-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedCustomRole,
} from '../../../../test/support/structure-fixtures.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';

/*
 * US-064 — documento externo (DOC-02 casca `UPLOADED` → ATT-02/03 + `file-scan` → DOC-19 → ATT-05
 * para a prévia) pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização,
 * idempotência, `If-Match`, filtro RFC 9457) com a identidade fake, os seeders reais e os
 * adaptadores em memória (documentos, anexos, storage, antivírus, fila, auditoria, outbox e
 * timeline). Os 8 cenários do Gherkin + FA-01..05. RLS, `FOR UPDATE` e falha induzida no banco
 * sobre PostgreSQL: `test/tenant-leak/uploaded-documents.spec.ts`.
 *
 * Personas: "Ana" do Gherkin (custodiante com DOCUMENT_CREATE/ATTACHMENT_UPLOAD) = Lúcia
 * (GESTOR_CONTRATACOES, cria o processo e fica responsável); "Bruno" (DOCUMENT_CREATE sem
 * ATTACHMENT_UPLOAD) = Otávio (ADMIN_ORGAO + perfil customizado), feito responsável do processo;
 * leitora não custodiante = Ana (REQUISITANTE do setor solicitante); sem DOCUMENT_UPDATE = Marta
 * (ADMIN_ORGAO); Heitor é da Prefeitura B.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MB = 1024 * 1024;

const ORG_A = '0192d064-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d064-0000-7000-8000-0000000000a1',
  manutencao: '0192d064-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d064-0000-7000-8000-0000000000a3',
  saude: '0192d064-0000-7000-8000-0000000000a4',
  posto: '0192d064-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** PDF mínimo válido (`%PDF-` nos primeiros bytes). */
function pdfBytes(size = 2048, seed = 'a'): Buffer {
  const head = Buffer.from(`%PDF-1.7\n% ${seed}\n1 0 obj << /Type /Catalog >> endobj\n`, 'latin1');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
}

/** Arquivo de teste EICAR montado em tempo de execução (nunca gravado em disco). */
function eicarPdf(): Buffer {
  const marker = ['EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE'].join('-');
  return Buffer.concat([pdfBytes(256), Buffer.from(`X5O!P%@AP $${marker}!$H+H*`, 'latin1')]);
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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

function versionOf(response: request.Response): DocumentVersionDto {
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return documentVersionSchema.parse((response.body as { data: unknown }).data);
}

describe('Feature: Incluir documento externo (upload) com versões (US-064)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  const antivirus = new FakeAntivirus();
  let openStages: Set<string>;
  let types: { externo: string; despacho: string; dfd: string };

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  /** Processo novo (PRC-02) criado por Lúcia, que fica responsável (custódia — POL-01). */
  async function newProcess(): Promise<string> {
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
    openStages.add(id);
    return id;
  }

  function patchProcess(processId: string, patch: Record<string, unknown>) {
    const repository = processRepositoryOf(api);
    const process = repository.allProcesses().find((row) => row.id === processId);
    if (process === undefined) throw new Error('processo não encontrado');
    repository.seed({ ...process, ...patch });
  }

  const call = (
    method: 'get' | 'post',
    path: string,
    options: {
      subject?: string;
      tenant?: string;
      key?: string | null;
      ifMatch?: string;
      body?: object;
    } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method === 'post' && options.key !== null)
      pending = pending.set('Idempotency-Key', options.key ?? randomUUID());
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
      body: { documentTypeId: types.externo, title: 'Parecer jurídico sobre a minuta', ...body },
    });

  async function newUploadedDocument(processId?: string): Promise<DocumentDto> {
    const response = await createDocument(processId ?? (await newProcess()));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return documentSchema.parse((response.body as { data: unknown }).data);
  }

  /** ATT-02 → PUT na quarentena → ATT-03 (202). */
  async function uploadFile(
    documentId: string,
    bytes: Buffer,
    options: { fileName?: string; subject?: string } = {},
  ) {
    const intent = await call('post', '/attachments', {
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      body: {
        targetType: 'DOCUMENT',
        targetId: documentId,
        fileName: options.fileName ?? 'parecer.pdf',
        declaredMimeType: 'application/pdf',
        sizeBytes: bytes.length,
      },
    });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const { data } = attachmentIntentResponseSchema.parse(intent.body);
    storage.put({ bucket: 'quarantine', key: `tenants/${A}/uploads/${data.id}` }, bytes);
    const confirmation = await call('post', `/attachments/${data.id}/confirm`);
    expect(confirmation.status, JSON.stringify(confirmation.body)).toBe(202);
    return data;
  }

  /** Executa o `file-scan` como o worker. */
  function runScan(id: string, attempt = 1) {
    const job = jobQueueOf(api).find('file-scan', id);
    if (job === undefined) throw new Error(`file-scan de ${id} não enfileirado`);
    return api.app.get(ScanFileJob).process({
      id: job.jobId,
      queue: job.queue,
      name: job.name,
      attempt,
      data: job.data,
    });
  }

  /** Arquivo enviado e varrido (`AVAILABLE`). */
  async function availableFile(documentId: string, bytes = pdfBytes(2 * MB)) {
    const attachment = await uploadFile(documentId, bytes);
    await expect(runScan(attachment.id)).resolves.toBe('completed');
    expect(attachmentRows().get(attachment.id)?.status).toBe('AVAILABLE');
    return attachment;
  }

  /** DOC-19. */
  const uploadVersion = (
    documentId: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string; key?: string; subject?: string; tenant?: string } = {},
  ) =>
    call('post', `/documents/${documentId}/upload-version`, {
      ifMatch: options.ifMatch ?? `"${String(storedDocument(documentId).version)}"`,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
      body,
    });

  const attachmentRows = () =>
    api.app.get<InMemoryAttachmentRepository>(ATTACHMENT_REPOSITORY, { strict: false }).rows;
  const storedDocument = (id: string) => {
    const row = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === id);
    if (!row) throw new Error(`documento ${id} não gravado`);
    return row;
  };
  const versionsOf = (id: string) => documentRepositoryOf(api).versionsOf(id);
  const auditOf = (action: string, entityId: string) =>
    api.auditRecords().filter((row) => row.action === action && row.entityId === entityId);
  const eventsOf = (aggregateId: string, eventType: string) =>
    api
      .outboxRows()
      .filter((row) => row.aggregateId === aggregateId && row.eventType === eventType);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: FILES_CLOCK, value: () => NOW },
        { token: OBJECT_STORAGE, value: storage },
        { token: ANTIVIRUS, value: antivirus },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    // "Bruno": DOCUMENT_CREATE/DOCUMENT_UPDATE (e PROCESS_VIEW) no tenant, sem ATTACHMENT_UPLOAD.
    const documentsOnly = seedCustomRole(api, A, 'Redação sem anexos', [
      'PROCESS_VIEW',
      'DOCUMENT_CREATE',
      'DOCUMENT_UPDATE',
    ]);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: documentsOnly.id,
    });
    openStages = openStageForAnyType(api);
    const seeded = documentTypeRepositoryOf(api)
      .snapshot()
      .filter((type) => type.tenantId === A);
    const idOf = (code: string) => seeded.find((type) => type.code === code)?.id ?? '';
    types = { externo: idOf('DOCUMENTO_EXTERNO'), despacho: idOf('DESPACHO'), dfd: idOf('DFD') };
    expect(Object.values(types).every((id) => id !== '')).toBe(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    storage.failing = null;
    antivirus.failing = false;
    api.app.get(AntivirusCircuit).recordSuccess();
  });

  describe('[Sucesso]', () => {
    it('Criar documento externo e enviar o arquivo: DRAFT sem versão → AVAILABLE → v1 UPLOAD, evento, auditoria, timeline e prévia', async () => {
      const processId = await newProcess();

      // DOC-02: a casca nasce DRAFT, sem versão, com Location e ETag.
      const created = await createDocument(processId);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const document = documentSchema.parse((created.body as { data: unknown }).data);
      const meta = documentMetaSchema.parse((created.body as { meta: unknown }).meta);
      expect(document).toMatchObject({
        processId,
        title: 'Parecer jurídico sobre a minuta',
        status: 'DRAFT',
        templateVersionId: null,
        currentVersionId: null,
        currentVersionNumber: null,
        responsibleId: FAKE_USERS.lucia.id,
        documentType: { id: types.externo, kind: 'UPLOADED' },
        version: 1,
      });
      expect(created.headers.location).toBe(`/api/v1/documents/${document.id}`);
      expect(created.headers.etag).toBe('"1"');
      expect(meta.allowedActions).toContain('UPDATE');
      expect(eventsOf(document.id, 'DocumentCreated')[0]).toMatchObject({
        routingKey: 'document.created.documento_externo',
        payload: {
          documentId: document.id,
          kind: 'UPLOADED',
          documentTypeCode: 'DOCUMENTO_EXTERNO',
        },
      });
      expect(auditOf('document.create', document.id)).toHaveLength(1);

      // RN-DOC-40: sem arquivo, não pode avançar.
      const pending = await call('get', `/documents/${document.id}/validation`);
      expect(JSON.stringify(pending.body)).toContain('currentVersionId');

      // ATT-02/03 + file-scan: o arquivo só fica disponível depois da varredura.
      const bytes = pdfBytes(2 * MB);
      const attachment = await uploadFile(document.id, bytes);
      expectProblem(
        await uploadVersion(document.id, { attachmentId: attachment.id }),
        409,
        'ATTACHMENT_NOT_AVAILABLE',
      );
      await expect(runScan(attachment.id)).resolves.toBe('completed');

      // DOC-19.
      const response = await uploadVersion(
        document.id,
        { attachmentId: attachment.id, changeSummary: 'Versão assinada' },
        { ifMatch: '"1"' },
      );
      const version = versionOf(response);
      expect(response.headers.location).toBe(`/api/v1/document-versions/${version.id}`);
      expect(version).toMatchObject({
        documentId: document.id,
        processId,
        versionNumber: 1,
        reason: 'UPLOAD',
        statusAtCreation: 'DRAFT',
        content: null,
        kind: 'UPLOADED',
        attachmentId: attachment.id,
        contentHash: sha256(bytes),
        changeSummary: 'Versão assinada',
        createdById: FAKE_USERS.lucia.id,
        createdAt: NOW.toISOString(),
      });
      expect(storedDocument(document.id)).toMatchObject({
        status: 'DRAFT',
        currentVersionId: version.id,
        currentVersionNumber: 1,
        version: 2,
      });

      const [event] = eventsOf(document.id, 'DocumentVersionCreated');
      expect(event).toMatchObject({ routingKey: 'document.version_created.documento_externo' });
      expect(event?.payload).toEqual({
        documentId: document.id,
        documentTypeCode: 'DOCUMENTO_EXTERNO',
        documentVersionId: version.id,
        versionNumber: 1,
        reason: 'UPLOAD',
        contentHash: sha256(bytes),
      });
      const [audit] = auditOf('document.version_create', document.id);
      expect(audit?.metadata).toMatchObject({
        versionNumber: 1,
        reason: 'UPLOAD',
        attachmentId: attachment.id,
        sha256: sha256(bytes),
      });
      // O resumo e o nome do arquivo nunca vão para a auditoria nem o evento.
      expect(JSON.stringify([audit, event])).not.toContain('Versão assinada');
      expect(JSON.stringify([audit, event])).not.toContain('parecer.pdf');
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === processId)
          .map((row) => row.type),
      ).toEqual(expect.arrayContaining(['DOCUMENT_CREATED', 'DOCUMENT_VERSION_CREATED']));

      // A versão é a corrente e o documento passa na completude de arquivo.
      const detail = await call('get', `/documents/${document.id}`);
      expect((detail.body as { data: DocumentDto }).data.currentVersionNumber).toBe(1);
      const validation = await call('get', `/documents/${document.id}/validation`);
      expect(JSON.stringify(validation.body)).not.toContain('currentVersionId');

      // Prévia inline (RN-DOC-36): URL assinada do arquivo da versão atual, auditada.
      const download = await call('get', `/attachments/${attachment.id}/download`);
      expect(download.status, JSON.stringify(download.body)).toBe(200);
      const signed = attachmentDownloadSchema.parse((download.body as { data: unknown }).data);
      expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(auditOf('attachment.download', attachment.id)[0]?.metadata).toMatchObject({
        sizeBytes: bytes.length,
        targetType: 'DOCUMENT',
        targetId: document.id,
      });
    });

    it('FA-03: nova versão substitui a atual (v2) e a v1 continua íntegra no histórico', async () => {
      const document = await newUploadedDocument();
      const first = await availableFile(document.id, pdfBytes(4096, 'v1'));
      const v1 = versionOf(await uploadVersion(document.id, { attachmentId: first.id }));
      const secondBytes = pdfBytes(4096, 'v2');
      const second = await availableFile(document.id, secondBytes);
      const v2 = versionOf(await uploadVersion(document.id, { attachmentId: second.id }));

      expect(v2).toMatchObject({
        versionNumber: 2,
        attachmentId: second.id,
        contentHash: sha256(secondBytes),
      });
      expect(storedDocument(document.id).currentVersionId).toBe(v2.id);
      const history = versionsOf(document.id);
      expect(history.map((row) => row.versionNumber).sort()).toEqual([1, 2]);
      expect(history.find((row) => row.id === v1.id)).toMatchObject({
        attachmentId: first.id,
        contentHash: v1.contentHash,
      });
      const list = await call('get', `/documents/${document.id}/versions`);
      expect(
        (list.body as { data: { versionNumber: number; reason: string }[] }).data.map(
          (row) => `${String(row.versionNumber)}:${row.reason}`,
        ),
      ).toEqual(['2:UPLOAD', '1:UPLOAD']);
    });

    it('FA-04: casca abandonada fica DRAFT sem versão e não pode ser finalizada', async () => {
      const document = await newUploadedDocument();
      const finalize = await call('post', `/documents/${document.id}/finalize`, {
        ifMatch: '"1"',
        body: {},
      });
      expect(finalize.status).toBe(422);
      expect(JSON.stringify(finalize.body)).toContain('currentVersionId');
      expect(storedDocument(document.id)).toMatchObject({
        status: 'DRAFT',
        currentVersionId: null,
      });
    });

    it('a versão enviada é a congelada na finalização (UPLOADED congela o arquivo corrente)', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      const uploaded = versionOf(await uploadVersion(document.id, { attachmentId: file.id }));
      const finalize = await call('post', `/documents/${document.id}/finalize`, {
        ifMatch: `"${String(storedDocument(document.id).version)}"`,
        body: {},
      });
      expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
      const finalVersion = versionsOf(document.id).find((row) => row.reason === 'FINALIZATION');
      expect(finalVersion).toMatchObject({
        attachmentId: file.id,
        contentHash: uploaded.contentHash,
        content: null,
      });
    });
  });

  describe('[Validação]', () => {
    it('Extensão de arquivo não permitida: script.exe → 415 FILE_TYPE_NOT_ALLOWED e nenhuma versão', async () => {
      const document = await newUploadedDocument();
      const response = await call('post', '/attachments', {
        body: {
          targetType: 'DOCUMENT',
          targetId: document.id,
          fileName: 'script.exe',
          declaredMimeType: 'application/octet-stream',
          sizeBytes: 1024,
        },
      });
      expectProblem(response, 415, 'FILE_TYPE_NOT_ALLOWED');
      expect(versionsOf(document.id)).toHaveLength(0);
      expect(storedDocument(document.id).currentVersionId).toBeNull();
    });

    it('V-05: arquivo acima de uploads.maxFileSizeMb → 413 FILE_TOO_LARGE', async () => {
      const document = await newUploadedDocument();
      const response = await call('post', '/attachments', {
        body: {
          targetType: 'DOCUMENT',
          targetId: document.id,
          fileName: 'parecer.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: 500 * MB,
        },
      });
      expectProblem(response, 413, 'FILE_TOO_LARGE');
    });

    it('V-01/V-02 (DOC-02): título fora de 5–250, tipo de outro kind, inexistente → 422', async () => {
      const processId = await newProcess();
      const shortTitle = expectProblem(
        await createDocument(processId, { title: 'abc' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(shortTitle)).toContain('title');
      const longTitle = await createDocument(processId, { title: 'x'.repeat(251) });
      expectProblem(longTitle, 422, 'VALIDATION_ERROR');
      for (const documentTypeId of [types.dfd, randomUUID()]) {
        const body = expectProblem(
          await createDocument(processId, { documentTypeId }),
          422,
          'VALIDATION_ERROR',
        );
        expect(body.errors[0]).toMatchObject({
          field: 'documentTypeId',
          code: 'REFERENCE_NOT_FOUND',
        });
      }
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .filter((row) => row.processId === processId),
      ).toEqual([]);
    });

    it('V-03: tipo não permitido na etapa atual → 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE (criação e nova versão)', async () => {
      const processId = await newProcess();
      const document = await newUploadedDocument(processId);
      const file = await availableFile(document.id);
      // Fora do conjunto aberto, a etapa de ABERTURA do workflow padrão só admite o DFD.
      openStages.delete(processId);
      try {
        expectProblem(await createDocument(processId), 422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE');
        expectProblem(
          await uploadVersion(document.id, { attachmentId: file.id }),
          422,
          'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
        );
      } finally {
        openStages.add(processId);
      }
      expect(versionsOf(document.id)).toHaveLength(0);
    });

    it('DOC-19: resumo acima de 500 → 422; sem attachmentId → 422; tipo FREE_TEXT → 422 NOT_ALLOWED; sem If-Match → 428', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      expectProblem(
        await uploadVersion(document.id, { attachmentId: file.id, changeSummary: 'x'.repeat(501) }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(await uploadVersion(document.id, {}), 422, 'VALIDATION_ERROR');
      const noIfMatch = await call('post', `/documents/${document.id}/upload-version`, {
        body: { attachmentId: file.id },
      });
      expect(noIfMatch.status).toBe(428);

      const freeText = await call('post', `/processes/${document.processId}/documents`, {
        body: { documentTypeId: types.despacho, title: 'Despacho de encaminhamento' },
      });
      // Texto livre é da US-063: até lá, DOC-02 só aceita o tipo externo.
      expectProblem(freeText, 422, 'VALIDATION_ERROR');
      const despacho = await createDocumentAs(api, LUCIA, {
        processId: document.processId,
        documentTypeId: types.despacho,
        title: 'Despacho de encaminhamento',
        templateVersionId: null,
      });
      const body = expectProblem(
        await uploadVersion(despacho.id, { attachmentId: file.id }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors[0]).toMatchObject({ field: 'kind', code: 'NOT_ALLOWED' });
      expect(versionsOf(despacho.id)).toHaveLength(0);
      expect(versionsOf(document.id)).toHaveLength(0);
    });

    it('V-08: documento fora de DRAFT/RETURNED → 409 DOCUMENT_NOT_EDITABLE', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      versionOf(await uploadVersion(document.id, { attachmentId: file.id }));
      const finalize = await call('post', `/documents/${document.id}/finalize`, {
        ifMatch: `"${String(storedDocument(document.id).version)}"`,
        body: {},
      });
      expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
      expectProblem(
        await uploadVersion(document.id, { attachmentId: file.id }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(versionsOf(document.id).filter((row) => row.reason === 'UPLOAD')).toHaveLength(1);
    });

    it('V-09: If-Match divergente → 412 VERSION_CONFLICT com a versão atual', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      const body = expectProblem(
        await uploadVersion(document.id, { attachmentId: file.id }, { ifMatch: '"7"' }),
        412,
        'VERSION_CONFLICT',
      );
      expect(body).toMatchObject({ currentVersion: 1 });
      expect(versionsOf(document.id)).toHaveLength(0);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem ATTACHMENT_UPLOAD cria a casca, mas POST /attachments → 403 PERMISSION_DENIED', async () => {
      const processId = await newProcess();
      patchProcess(processId, { currentResponsibleId: FAKE_USERS.otavio.id });
      const created = await createDocument(processId, {}, { subject: 'sub-otavio' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const document = documentSchema.parse((created.body as { data: unknown }).data);
      const response = await call('post', '/attachments', {
        subject: 'sub-otavio',
        body: {
          targetType: 'DOCUMENT',
          targetId: document.id,
          fileName: 'parecer.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: 2048,
        },
      });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect([...attachmentRows().values()].filter((row) => row.targetId === document.id)).toEqual(
        [],
      );
    });

    it('POL-02: sem custódia nem participação → 403 na criação e no envio de versão; sem DOCUMENT_UPDATE → 403', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      // Ana vê o processo (setor solicitante) e tem DOCUMENT_CREATE/UPDATE, mas não é custodiante.
      expectProblem(
        await createDocument(document.processId, {}, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await uploadVersion(document.id, { attachmentId: file.id }, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      // Marta (ADMIN_ORGAO) vê o processo, mas não tem DOCUMENT_UPDATE nem DOCUMENT_CREATE.
      expectProblem(
        await uploadVersion(document.id, { attachmentId: file.id }, { subject: 'sub-marta' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await createDocument(document.processId, {}, { subject: 'sub-marta' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(versionsOf(document.id)).toHaveLength(0);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('attachmentId de outro tenant em upload-version → 422 REFERENCE_NOT_FOUND em attachmentId', async () => {
      const document = await newUploadedDocument();
      const id = randomUUID();
      const foreign = createAttachment({
        id,
        tenantId: B,
        processId: null,
        targetType: 'DOCUMENT',
        targetId: document.id,
        categoryId: null,
        fileName: 'parecer.pdf',
        extension: 'pdf',
        declaredMimeType: 'application/pdf',
        sizeBytes: 2048,
        storageKey: `tenants/${B}/documents/${id}/parecer.pdf`,
        quarantineKey: `tenants/${B}/uploads/${id}`,
        description: null,
        uploadedById: FAKE_USERS.heitor.id,
        now: NOW,
      });
      attachmentRows().set(id, {
        ...foreign,
        status: 'AVAILABLE',
        sha256: 'ab'.repeat(32),
        detectedMimeType: 'application/pdf',
        scannedAt: NOW,
      });
      const body = expectProblem(
        await uploadVersion(document.id, { attachmentId: id }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors[0]).toMatchObject({ field: 'attachmentId', code: 'REFERENCE_NOT_FOUND' });
      expect(versionsOf(document.id)).toHaveLength(0);
    });

    it('anexo de OUTRO documento do mesmo tenant → 422 REFERENCE_NOT_FOUND', async () => {
      const document = await newUploadedDocument();
      const other = await newUploadedDocument(document.processId);
      const file = await availableFile(other.id);
      const body = expectProblem(
        await uploadVersion(document.id, { attachmentId: file.id }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors[0]).toMatchObject({ field: 'attachmentId', code: 'REFERENCE_NOT_FOUND' });
    });

    it('DOC-02/DOC-19/ATT-05 com ids do tenant A chamados de B → 404 sem vazar dados', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      const asHeitor = { subject: 'sub-heitor', tenant: B };
      for (const response of [
        await createDocument(document.processId, {}, asHeitor),
        await uploadVersion(document.id, { attachmentId: file.id }, asHeitor),
        await call('get', `/attachments/${file.id}/download`, asHeitor),
      ]) {
        expect(response.status, JSON.stringify(response.body)).toBe(404);
        expect(JSON.stringify(response.body)).not.toContain('Parecer jurídico');
      }
      expect(versionsOf(document.id)).toHaveLength(0);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do DOC-19 com a mesma chave: mesmo resultado, Idempotent-Replayed: true e uma só versão', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      const key = randomUUID();
      const first = versionOf(
        await uploadVersion(document.id, { attachmentId: file.id }, { key, ifMatch: '"1"' }),
      );
      const replay = await uploadVersion(
        document.id,
        { attachmentId: file.id },
        { key, ifMatch: '"1"' },
      );
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((replay.body as { data: { id: string } }).data.id).toBe(first.id);
      expect(versionsOf(document.id)).toHaveLength(1);
      expect(eventsOf(document.id, 'DocumentVersionCreated')).toHaveLength(1);
    });

    it('Reenvio do DOC-02 com a mesma chave não cria outra casca', async () => {
      const processId = await newProcess();
      const key = randomUUID();
      const first = await createDocument(processId, {}, { key });
      const replay = await createDocument(processId, {}, { key });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .filter((row) => row.processId === processId),
      ).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Dois DOC-19 quase simultâneos com arquivos diferentes: versões sequenciais (2 e 3), sem colisão', async () => {
      const document = await newUploadedDocument();
      const base = await availableFile(document.id, pdfBytes(4096, 'v1'));
      versionOf(await uploadVersion(document.id, { attachmentId: base.id }));
      const ana = await availableFile(document.id, pdfBytes(4096, 'ana'));
      const carla = await availableFile(document.id, pdfBytes(4096, 'carla'));
      const ifMatch = `"${String(storedDocument(document.id).version)}"`;

      // A linha travada serializa: um vence com a versão lida; o outro recebe 412 (If-Match).
      const responses = await Promise.all([
        uploadVersion(document.id, { attachmentId: ana.id }, { ifMatch }),
        uploadVersion(document.id, { attachmentId: carla.id }, { ifMatch }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
      const loser = responses.find((response) => response.status === 412);
      const loserAttachment = loser === responses[0] ? ana.id : carla.id;
      // Quem perdeu recarrega o ETag e reenvia: vira a versão seguinte.
      const retry = versionOf(await uploadVersion(document.id, { attachmentId: loserAttachment }));

      expect(retry.versionNumber).toBe(3);
      expect(
        versionsOf(document.id)
          .map((row) => row.versionNumber)
          .sort(),
      ).toEqual([1, 2, 3]);
      expect(storedDocument(document.id).currentVersionId).toBe(retry.id);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao confirmar a versão → 503 DEPENDENCY_UNAVAILABLE e nenhuma versão', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      transactions.down = true;
      expectProblem(
        await uploadVersion(document.id, { attachmentId: file.id }, { ifMatch: '"1"' }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(versionsOf(document.id)).toHaveLength(0);
      expect(storedDocument(document.id)).toMatchObject({ version: 1, currentVersionId: null });
      expect(eventsOf(document.id, 'DocumentVersionCreated')).toHaveLength(0);
    });
  });

  describe('[Falha de integração]', () => {
    it('ClamAV indisponível: o anexo fica SCANNING, DOC-19 → 409 e o arquivo nunca fica acessível', async () => {
      const document = await newUploadedDocument();
      const attachment = await uploadFile(document.id, pdfBytes(4096));
      antivirus.failing = true;
      await expect(runScan(attachment.id)).rejects.toBeInstanceOf(ScanDeferredError);
      expect(attachmentRows().get(attachment.id)?.status).toBe('SCANNING');

      expectProblem(
        await uploadVersion(document.id, { attachmentId: attachment.id }),
        409,
        'ATTACHMENT_NOT_AVAILABLE',
      );
      expectProblem(
        await call('get', `/attachments/${attachment.id}/download`),
        409,
        'ATTACHMENT_NOT_AVAILABLE',
      );
      expect(versionsOf(document.id)).toHaveLength(0);
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(0);
    });

    it('FA-01: arquivo infectado nunca vira versão nem tem URL de download', async () => {
      const document = await newUploadedDocument();
      const attachment = await uploadFile(document.id, eicarPdf());
      await runScan(attachment.id);
      expect(attachmentRows().get(attachment.id)?.status).toBe('INFECTED');
      expectProblem(
        await uploadVersion(document.id, { attachmentId: attachment.id }),
        409,
        'ATTACHMENT_NOT_AVAILABLE',
      );
      expectProblem(
        await call('get', `/attachments/${attachment.id}/download`),
        409,
        'ATTACHMENT_NOT_AVAILABLE',
      );
      expect(versionsOf(document.id)).toHaveLength(0);
    });

    it('Storage indisponível ao assinar a URL da prévia → 503 DEPENDENCY_UNAVAILABLE', async () => {
      const document = await newUploadedDocument();
      const file = await availableFile(document.id);
      storage.failing = new Error('ECONNREFUSED');
      expectProblem(
        await call('get', `/attachments/${file.id}/download`),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
    });
  });
});

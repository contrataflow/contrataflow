import { createHash, randomUUID } from 'node:crypto';

import {
  attachmentConfirmationSchema,
  attachmentIntentResponseSchema,
  attachmentSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
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
  CATALOG_CLOCK,
  catalogItemId,
  runTenantSeeders,
  seedProcessStructure,
  tenantSettingsOf,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { AntivirusCircuit } from '../application/antivirus-circuit.js';
import {
  ANTIVIRUS,
  ATTACHMENT_REPOSITORY,
  FILES_CLOCK,
  FILES_SETTINGS,
  FILES_TRANSACTIONS,
} from '../application/files-ports.js';
import type { FilesSettings, FilesTransactions } from '../application/files-ports.js';
import { ScanFileJob } from '../application/scan-file.job.js';
import { ScanDeferredError } from '../application/scan-file.processor.js';
import { FakeAntivirus } from '../infrastructure/fake-antivirus.js';
import type { InMemoryAttachmentRepository } from '../infrastructure/in-memory-attachment.repository.js';

/*
 * US-068 — ATT-02/03/04/06 e o `file-scan` pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, idempotência, `If-Match`, rate limit, filtro RFC 9457) com a identidade
 * fake, os seeders reais, o processo do PRC-02, o documento da fábrica única e os adaptadores em
 * memória (anexos, storage, antivírus, fila, auditoria, outbox e timeline). Cenários do Gherkin (8
 * categorias) + FA-01..07. RLS e a guarda de chave no PostgreSQL: `test/tenant-leak/attachments.spec.ts`.
 *
 * Personas: o usuário do Gherkin = Lúcia (GESTOR_CONTRATACOES, cria o processo e o documento —
 * custódia; tem ATTACHMENT_UPLOAD e ATTACHMENT_DELETE); "Bruno" sem ATTACHMENT_UPLOAD = Marta
 * (ADMIN_ORGAO, que não anexa); Ana (REQUISITANTE do setor solicitante) vê o processo e tem ATTACHMENT_UPLOAD, mas não é
 * custodiante nem tem ATTACHMENT_DELETE; Heitor é da Prefeitura B.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MB = 1024 * 1024;

const ORG_A = '0192d068-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d068-0000-7000-8000-0000000000a1',
  manutencao: '0192d068-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d068-0000-7000-8000-0000000000a3',
  saude: '0192d068-0000-7000-8000-0000000000a4',
  posto: '0192d068-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** PDF mínimo válido (`%PDF-` nos primeiros bytes). */
function pdfBytes(size = 2048): Buffer {
  const head = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n', 'latin1');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
}

/** Arquivo de teste EICAR montado em tempo de execução (nunca gravado em disco). */
function eicarPdf(): Buffer {
  const marker = ['EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE'].join('-');
  return Buffer.concat([pdfBytes(256), Buffer.from(`X5O!P%@AP $${marker}!$H+H*`, 'latin1')]);
}

/** Transações do módulo que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements FilesTransactions {
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

describe('Feature: Upload seguro de anexos (US-068)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  const antivirus = new FakeAntivirus();
  const settings: { -readonly [K in keyof FilesSettings]: FilesSettings[K] } = {
    tenantQuotaBytes: 50 * 1024 * MB,
    scanAttempts: 5,
    scanBackoffMs: 5_000,
    scanLeaseMs: 90_000,
  };
  let openStages: Set<string>;
  let despachoTypeId: string;
  let processId: string;
  let documentId: string;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

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

  async function newDocument(inProcess: string): Promise<string> {
    const document = await createDocumentAs(api, LUCIA, {
      processId: inProcess,
      documentTypeId: despachoTypeId,
      title: 'ETP 0003/2026',
      templateVersionId: null,
    });
    return document.id;
  }

  const call = (
    method: 'get' | 'post' | 'delete',
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
    if (options.key !== null) pending = pending.set('Idempotency-Key', options.key ?? randomUUID());
    if (options.ifMatch !== undefined) pending = pending.set('If-Match', options.ifMatch);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  const intentBody = (overrides: Record<string, unknown> = {}) => ({
    targetType: 'DOCUMENT',
    targetId: documentId,
    fileName: 'comprovante.pdf',
    declaredMimeType: 'application/pdf',
    sizeBytes: 2 * MB,
    ...overrides,
  });

  async function intent(overrides: Record<string, unknown> = {}, subject = 'sub-lucia') {
    const response = await call('post', '/attachments', { subject, body: intentBody(overrides) });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return attachmentIntentResponseSchema.parse(response.body);
  }

  const quarantineKeyOf = (id: string) => `tenants/${A}/uploads/${id}`;
  const upload = (id: string, bytes: Buffer) => {
    storage.put({ bucket: 'quarantine', key: quarantineKeyOf(id) }, bytes);
  };
  const confirm = (id: string, options: { key?: string; subject?: string } = {}) =>
    call('post', `/attachments/${id}/confirm`, options);

  /** Executa o `file-scan` como o worker: o job enfileirado (meta da confirmação) na tentativa. */
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

  /** Intenção → PUT → confirmação (202 UPLOADED) com o conteúdo informado. */
  async function uploaded(bytes: Buffer, overrides: Record<string, unknown> = {}) {
    const { data } = await intent({ sizeBytes: bytes.length, ...overrides });
    upload(data.id, bytes);
    const response = await confirm(data.id);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return data;
  }

  const repository = () =>
    api.app.get<InMemoryAttachmentRepository>(ATTACHMENT_REPOSITORY, { strict: false });
  const stored = (id: string) => repository().rows.get(id);
  const auditOf = (action: string, entityId: string) =>
    api.auditRecords().filter((row) => row.action === action && row.entityId === entityId);
  const eventsOf = (aggregateId: string) =>
    api.outboxRows().filter((row) => row.aggregateId === aggregateId);
  const getAttachment = async (id: string, subject = 'sub-lucia') => {
    const response = await call('get', `/attachments/${id}`, { subject, key: null });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return attachmentSchema.parse((response.body as { data: unknown }).data);
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: FILES_TRANSACTIONS, value: transactions },
        { token: FILES_CLOCK, value: () => NOW },
        { token: FILES_SETTINGS, value: settings },
        { token: OBJECT_STORAGE, value: storage },
        { token: ANTIVIRUS, value: antivirus },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    openStages = openStageForAnyType(api);
    despachoTypeId =
      documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === 'DESPACHO')?.id ?? '';
    expect(despachoTypeId).not.toBe('');
    processId = await newProcess();
    documentId = await newDocument(processId);
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
    settings.tenantQuotaBytes = 50 * 1024 * MB;
    api.app.get(AntivirusCircuit).recordSuccess();
  });

  describe('[Sucesso]', () => {
    it('Enviar um PDF válido: PENDING_UPLOAD com URL ≤ 300 s → UPLOADED → AVAILABLE, evento, auditoria e timeline', async () => {
      const bytes = pdfBytes(2 * MB);
      const response = await call('post', '/attachments', {
        body: intentBody({ fileName: 'Comprovante Água (v2).pdf', sizeBytes: bytes.length }),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const { data, upload: put } = attachmentIntentResponseSchema.parse(response.body);
      expect(data).toMatchObject({
        status: 'PENDING_UPLOAD',
        processId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        fileName: 'Comprovante Água (v2).pdf',
        extension: 'pdf',
        sizeBytes: bytes.length,
        uploadedById: FAKE_USERS.lucia.id,
        version: 1,
      });
      expect(response.headers.location).toBe(`/api/v1/attachments/${data.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(put.method).toBe('PUT');
      expect(put.url).toContain(quarantineKeyOf(data.id));
      expect(put.headers).toEqual({ 'Content-Type': 'application/pdf' });
      const ttl = Date.parse(put.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300_000);
      // Nenhuma chave de storage sai na resposta (RN-DOC-77).
      expect(JSON.stringify(response.body)).not.toContain('storageKey');
      expect(auditOf('attachment.upload_intent', data.id)[0]?.metadata).toMatchObject({
        targetType: 'DOCUMENT',
        targetId: documentId,
        fileName: 'Comprovante Água (v2).pdf',
        sizeBytes: bytes.length,
      });
      expect(stored(data.id)?.storageKey).toBe(
        `tenants/${A}/processes/${processId}/attachments/${data.id}/comprovante-agua-v2.pdf`,
      );

      upload(data.id, bytes);
      const confirmed = await confirm(data.id);
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(202);
      expect(
        attachmentConfirmationSchema.parse((confirmed.body as { data: unknown }).data),
      ).toEqual({ status: 'UPLOADED' });
      expect(auditOf('attachment.confirm', data.id)).toHaveLength(1);
      const job = jobQueueOf(api).find('file-scan', data.id);
      expect(job).toMatchObject({
        name: 'scan',
        jobId: data.id,
        options: { attempts: 5, backoffMs: 5_000 },
      });
      expect(job?.data.payload).toEqual({ attachmentId: data.id });
      expect(job?.data.meta).toMatchObject({
        tenantId: A,
        actor: { type: 'USER', userId: FAKE_USERS.lucia.id },
      });

      await expect(runScan(data.id)).resolves.toBe('completed');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const available = await getAttachment(data.id);
      expect(available).toMatchObject({ status: 'AVAILABLE', sha256, reasonCode: null });
      expect(stored(data.id)).toMatchObject({
        detectedMimeType: 'application/pdf',
        scanResult: { engine: 'fake', engineVersion: 'fake/1', signature: null },
      });
      const promoted = storage.get({ bucket: 'documents', key: stored(data.id)?.storageKey ?? '' });
      expect(promoted?.body.equals(bytes)).toBe(true);
      expect(promoted?.metadata).toEqual({
        'cf-tenant-id': A,
        'cf-attachment-id': data.id,
        'cf-sha256': sha256,
        'cf-schema': '1',
      });
      expect(storage.get({ bucket: 'quarantine', key: quarantineKeyOf(data.id) })).toBeUndefined();
      expect(eventsOf(data.id).map((row) => row.eventType)).toEqual(['AttachmentUploaded']);
      expect(eventsOf(data.id)[0]?.payload).toEqual({
        attachmentId: data.id,
        targetType: 'DOCUMENT',
        targetId: documentId,
        fileName: 'Comprovante Água (v2).pdf',
        sizeBytes: bytes.length,
        sha256,
      });
      expect(auditOf('attachment.scan_result', data.id)[0]).toMatchObject({
        category: 'SYSTEM',
        metadata: { status: 'AVAILABLE', sha256 },
      });
      expect(
        timelineRowsOf(api).some(
          (row) => row.type === 'ATTACHMENT_ADDED' && row.entityId === data.id,
        ),
      ).toBe(true);
    });

    it('Anexar ao próprio processo (alvo PROCESS)', async () => {
      const { data } = await intent({ targetType: 'PROCESS', targetId: processId });
      expect(data).toMatchObject({ processId, targetType: 'PROCESS', targetId: processId });
    });

    it('Excluir o próprio anexo com motivo: DELETED lógico, evento, auditoria sem o texto e timeline', async () => {
      const attachment = await uploaded(pdfBytes(1024));
      await runScan(attachment.id);
      const reason = 'Arquivo duplicado, enviado por engano.';
      const missing = await call('delete', `/attachments/${attachment.id}`, {
        ifMatch: '"4"',
        body: {},
      });
      expectProblem(missing, 422, 'VALIDATION_ERROR');
      const stale = await call('delete', `/attachments/${attachment.id}`, {
        ifMatch: '"1"',
        body: { deletionReason: reason },
      });
      expectProblem(stale, 412, 'VERSION_CONFLICT');

      const current = await getAttachment(attachment.id);
      const response = await call('delete', `/attachments/${attachment.id}`, {
        ifMatch: `"${current.version}"`,
        body: { deletionReason: reason },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect(stored(attachment.id)).toMatchObject({
        status: 'DELETED',
        deletionReason: reason,
        deletedById: FAKE_USERS.lucia.id,
      });
      const audit = auditOf('attachment.delete', attachment.id)[0];
      expect(audit?.metadata).toMatchObject({
        deletionReason: {
          sha256: createHash('sha256').update(reason).digest('hex'),
          length: reason.length,
        },
      });
      expect(JSON.stringify(audit)).not.toContain(reason);
      expect(eventsOf(attachment.id).at(-1)).toMatchObject({
        eventType: 'AttachmentDeleted',
        payload: { attachmentId: attachment.id, hasReason: true },
      });
      expect(
        timelineRowsOf(api).some(
          (row) => row.type === 'ATTACHMENT_REMOVED' && row.entityId === attachment.id,
        ),
      ).toBe(true);
      // Excluído some da API (404); o binário segue retido no bucket (PEND-07).
      const after = await call('get', `/attachments/${attachment.id}`, { key: null });
      expectProblem(after, 404, 'NOT_FOUND');
      expect(
        storage.get({ bucket: 'documents', key: stored(attachment.id)?.storageKey ?? '' }),
      ).toBeDefined();
    });
  });

  describe('[Validação]', () => {
    it('Extensão não permitida: 415 FILE_TYPE_NOT_ALLOWED sem URL e sem anexo', async () => {
      const before = repository().rows.size;
      const response = await call('post', '/attachments', {
        body: intentBody({ fileName: 'script.exe', declaredMimeType: 'application/x-msdownload' }),
      });
      const problem = expectProblem(response, 415, 'FILE_TYPE_NOT_ALLOWED');
      expect(problem.detail).toContain('pdf');
      expect(JSON.stringify(response.body)).not.toContain('upload');
      expect(repository().rows.size).toBe(before);
    });

    it('MIME declarado incoerente com a extensão → 415; extensão fora da lista do tenant → 415', async () => {
      expectProblem(
        await call('post', '/attachments', { body: intentBody({ declaredMimeType: 'image/png' }) }),
        415,
        'FILE_TYPE_NOT_ALLOWED',
      );
      tenantSettingsOf(api).seed(A, 'uploads.allowedExtensions', ['docx']);
      try {
        expectProblem(
          await call('post', '/attachments', { body: intentBody() }),
          415,
          'FILE_TYPE_NOT_ALLOWED',
        );
      } finally {
        tenantSettingsOf(api).seed(A, 'uploads.allowedExtensions', ['pdf', 'docx', 'png']);
      }
    });

    it('Acima de uploads.maxFileSizeMb → 413; vazio → 422; chave de storage no corpo → 422', async () => {
      const tooLarge = await call('post', '/attachments', {
        body: intentBody({ sizeBytes: 50 * MB + 1 }),
      });
      expect(expectProblem(tooLarge, 413, 'FILE_TOO_LARGE').detail).toContain('50 MB');
      expectProblem(
        await call('post', '/attachments', { body: intentBody({ sizeBytes: 0 }) }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await call('post', '/attachments', {
          body: intentBody({ storageKey: `tenants/${A}/uploads/x` }),
        }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('Confirmação sem upload → 409 UPLOAD_NOT_RECEIVED (FA-02)', async () => {
      const { data } = await intent();
      expectProblem(await confirm(data.id), 409, 'UPLOAD_NOT_RECEIVED');
      expect(stored(data.id)?.status).toBe('PENDING_UPLOAD');
    });

    it('Tamanho confirmado diverge do declarado → 202 REJECTED SIZE_MISMATCH, sem varredura', async () => {
      const { data } = await intent({ sizeBytes: 4096 });
      upload(data.id, pdfBytes(1000));
      const response = await confirm(data.id);
      expect(response.status).toBe(202);
      expect((response.body as { data: unknown }).data).toEqual({
        status: 'REJECTED',
        reasonCode: 'SIZE_MISMATCH',
      });
      expect(jobQueueOf(api).find('file-scan', data.id)).toBeUndefined();
      expect(eventsOf(data.id)[0]).toMatchObject({
        eventType: 'AttachmentRejected',
        payload: { attachmentId: data.id, status: 'REJECTED', reasonCode: 'SIZE_MISMATCH' },
      });
    });

    it('Arquivo infectado (EICAR) → INFECTED + AttachmentRejected, sem a assinatura na API (FA-03)', async () => {
      const bytes = eicarPdf();
      const attachment = await uploaded(bytes);
      await runScan(attachment.id);
      const view = await getAttachment(attachment.id);
      expect(view).toMatchObject({ status: 'INFECTED', reasonCode: 'INFECTED' });
      expect(stored(attachment.id)?.scanResult?.signature).toBe('Eicar-Test-Signature');
      expect(JSON.stringify(view)).not.toContain('Eicar');
      expect(eventsOf(attachment.id).at(-1)).toMatchObject({
        eventType: 'AttachmentRejected',
        payload: { attachmentId: attachment.id, status: 'INFECTED', reasonCode: 'INFECTED' },
      });
      expect(JSON.stringify(eventsOf(attachment.id))).not.toContain('Eicar');
      expect(
        storage.get({ bucket: 'documents', key: stored(attachment.id)?.storageKey ?? '' }),
      ).toBe(undefined);
      // Não chega a AVAILABLE e não pode ser excluído pela API.
      expectProblem(
        await call('delete', `/attachments/${attachment.id}`, {
          ifMatch: `"${view.version}"`,
          body: { deletionReason: 'limpeza' },
        }),
        409,
        'ATTACHMENT_NOT_AVAILABLE',
      );
    });

    it('Tipo real diverge do declarado (.pdf com bytes de executável) → REJECTED TYPE_MISMATCH (FA-04)', async () => {
      const executable = Buffer.concat([
        Buffer.from('MZ\x90\x00', 'latin1'),
        Buffer.alloc(4000, 1),
      ]);
      const attachment = await uploaded(executable);
      await runScan(attachment.id);
      expect(await getAttachment(attachment.id)).toMatchObject({
        status: 'REJECTED',
        reasonCode: 'TYPE_MISMATCH',
      });
    });

    it('Categoria fora do catálogo ATTACHMENT_CATEGORY → 422', async () => {
      const wrong = catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA');
      expectProblem(
        await call('post', '/attachments', { body: intentBody({ categoryId: wrong }) }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('Quota do tenant atingida → 422 STORAGE_QUOTA_EXCEEDED (RN-DOC-80)', async () => {
      settings.tenantQuotaBytes = 1;
      expectProblem(
        await call('post', '/attachments', { body: intentBody() }),
        422,
        'STORAGE_QUOTA_EXCEEDED',
      );
    });

    it('Documento não editável → 409 DOCUMENT_NOT_EDITABLE (V-04)', async () => {
      const otherDocument = await newDocument(await newProcess());
      const current = documentRepositoryOf(api)
        .allDocuments()
        .find((row) => row.id === otherDocument);
      if (current === undefined) throw new Error('documento não criado');
      documentRepositoryOf(api).seed({ ...current, status: 'FINALIZED' });
      expectProblem(
        await call('post', '/attachments', { body: intentBody({ targetId: otherDocument }) }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem ATTACHMENT_UPLOAD → 403 PERMISSION_DENIED', async () => {
      const response = await call('post', '/attachments', {
        subject: 'sub-marta',
        body: intentBody(),
      });
      expectProblem(response, 403, 'PERMISSION_DENIED');
    });

    it('Com ATTACHMENT_UPLOAD mas sem poder editar o alvo (POL-02) → 403', async () => {
      const response = await call('post', '/attachments', {
        subject: 'sub-ana',
        body: intentBody(),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
    });

    it('Só quem enviou confirma; anexo de terceiro sem ATTACHMENT_DELETE não é excluído (FA-07)', async () => {
      const attachment = await uploaded(pdfBytes(1024));
      await runScan(attachment.id);
      const view = await getAttachment(attachment.id, 'sub-ana');
      expectProblem(await confirm(attachment.id, { subject: 'sub-ana' }), 403, 'PERMISSION_DENIED');
      expectProblem(
        await call('delete', `/attachments/${attachment.id}`, {
          subject: 'sub-ana',
          ifMatch: `"${view.version}"`,
          body: { deletionReason: 'Não é meu, mas quero excluir.' },
        }),
        403,
        'PERMISSION_DENIED',
      );
      expect(stored(attachment.id)?.status).toBe('AVAILABLE');
    });
  });

  describe('[Permissão] exclusão de terceiro (FA-07)', () => {
    it('anexo de Ana excluído por quem tem ATTACHMENT_DELETE; Ana exclui o próprio sem ela', async () => {
      const bytes = pdfBytes(1024);
      const fromAna = async () => {
        const { data } = await intent(
          { targetType: 'PROCESS', targetId: processId, sizeBytes: bytes.length },
          'sub-ana',
        );
        upload(data.id, bytes);
        expect((await confirm(data.id, { subject: 'sub-ana' })).status).toBe(202);
        await runScan(data.id);
        return getAttachment(data.id, 'sub-ana');
      };
      const first = await fromAna();
      const byLucia = await call('delete', `/attachments/${first.id}`, {
        ifMatch: `"${first.version}"`,
        body: { deletionReason: 'Duplicado no processo.' },
      });
      expect(byLucia.status, JSON.stringify(byLucia.body)).toBe(204);
      expect(auditOf('attachment.delete', first.id)[0]?.metadata).toMatchObject({
        ownAttachment: false,
      });

      const second = await fromAna();
      const own = await call('delete', `/attachments/${second.id}`, {
        subject: 'sub-ana',
        ifMatch: `"${second.version}"`,
        body: { deletionReason: 'Arquivo errado.' },
      });
      expect(own.status, JSON.stringify(own.body)).toBe(204);
      expect(stored(second.id)?.deletedById).toBe(FAKE_USERS.ana.id);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Alvo de outro tenant → 404 e nenhum anexo criado; anexo de outro tenant → 404', async () => {
      const before = repository().rows.size;
      const response = await call('post', '/attachments', {
        subject: 'sub-heitor',
        tenant: B,
        body: intentBody(),
      });
      expectProblem(response, 404, 'NOT_FOUND');
      expect(repository().rows.size).toBe(before);

      const { data } = await intent();
      const foreign = await call('get', `/attachments/${data.id}`, {
        subject: 'sub-heitor',
        tenant: B,
        key: null,
      });
      expectProblem(foreign, 404, 'NOT_FOUND');
      expectProblem(
        await confirm(data.id, { subject: 'sub-heitor' }).set('X-Tenant-Id', B),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da confirmação com a mesma chave → 202 igual e Idempotent-Replayed: true', async () => {
      const bytes = pdfBytes(1024);
      const { data } = await intent({ sizeBytes: bytes.length });
      upload(data.id, bytes);
      const k1 = randomUUID();
      const first = await confirm(data.id, { key: k1 });
      expect(first.status).toBe(202);
      const second = await confirm(data.id, { key: k1 });
      expect(second.status).toBe(202);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
      // Outra chave: devolve o estado atual, sem nova auditoria (storage.md §5.3).
      const third = await confirm(data.id);
      expect((third.body as { data: unknown }).data).toEqual({ status: 'UPLOADED' });
      expect(auditOf('attachment.confirm', data.id)).toHaveLength(1);
      expect(
        jobQueueOf(api)
          .all()
          .filter((job) => job.jobId === data.id),
      ).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas varreduras simultâneas do mesmo anexo: só uma processa, sem promoção duplicada', async () => {
      const attachment = await uploaded(pdfBytes(1024));
      const scansBefore = antivirus.scans;
      const results = await Promise.all([runScan(attachment.id), runScan(attachment.id)]);
      expect(results).toEqual(['completed', 'completed']);
      expect(antivirus.scans - scansBefore).toBe(1);
      expect(stored(attachment.id)?.status).toBe('AVAILABLE');
      expect(
        eventsOf(attachment.id).filter((row) => row.eventType === 'AttachmentUploaded'),
      ).toHaveLength(1);
      expect(auditOf('attachment.scan_result', attachment.id)).toHaveLength(1);
    });

    it('Duas intenções simultâneas não colidem (attachmentId distintos)', async () => {
      const [first, second] = await Promise.all([intent(), intent()]);
      expect(first.data.id).not.toBe(second.data.id);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na intenção → 503 DEPENDENCY_UNAVAILABLE e nenhum anexo criado', async () => {
      const before = repository().rows.size;
      transactions.down = true;
      const response = await call('post', '/attachments', { body: intentBody() });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(repository().rows.size).toBe(before);
    });

    it('Storage indisponível ao assinar → 503 e a intenção é desfeita', async () => {
      storage.failing = new Error('ECONNREFUSED');
      const response = await call('post', '/attachments', { body: intentBody() });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    });
  });

  describe('[Falha de integração]', () => {
    it('ClamAV fora do ar: pausa sem consumir tentativa, fica SCANNING e conclui quando volta (FA-05)', async () => {
      const attachment = await uploaded(pdfBytes(1024));
      antivirus.failing = true;
      await expect(runScan(attachment.id)).rejects.toBeInstanceOf(ScanDeferredError);
      await expect(runScan(attachment.id)).rejects.toMatchObject({ consumesAttempt: false });
      expect(stored(attachment.id)?.status).toBe('SCANNING');
      expect((await getAttachment(attachment.id)).status).toBe('SCANNING');

      antivirus.failing = false;
      // Mesma tentativa (a pausa não consumiu): a varredura assume de novo e conclui.
      await expect(runScan(attachment.id)).resolves.toBe('completed');
      expect(stored(attachment.id)?.status).toBe('AVAILABLE');
    });

    it('Storage fora na leitura: o job falha para nova tentativa e o anexo segue SCANNING', async () => {
      const attachment = await uploaded(pdfBytes(1024));
      storage.failing = new Error('ECONNRESET');
      await expect(runScan(attachment.id)).rejects.toThrow('ECONNRESET');
      expect(stored(attachment.id)?.status).toBe('SCANNING');
      storage.failing = null;
      await expect(runScan(attachment.id, 2)).resolves.toBe('completed');
      expect(stored(attachment.id)?.status).toBe('AVAILABLE');
    });

    it('Objeto expirado na quarentena antes da varredura → REJECTED, nada liberado', async () => {
      const attachment = await uploaded(pdfBytes(1024));
      await storage.delete({ bucket: 'quarantine', key: quarantineKeyOf(attachment.id) });
      await runScan(attachment.id);
      expect(await getAttachment(attachment.id)).toMatchObject({
        status: 'REJECTED',
        reasonCode: 'EMPTY_FILE',
      });
    });

    it('Disjuntor aberto após falhas seguidas: nem lê a quarentena e nunca libera', async () => {
      const attachment = await uploaded(pdfBytes(1024));
      antivirus.failing = true;
      for (let i = 0; i < 5; i += 1) {
        await expect(runScan(attachment.id)).rejects.toBeInstanceOf(ScanDeferredError);
      }
      expect(api.app.get(AntivirusCircuit).state).toBe('OPEN');
      antivirus.failing = false;
      const scans = antivirus.scans;
      await expect(runScan(attachment.id)).rejects.toBeInstanceOf(ScanDeferredError);
      expect(antivirus.scans).toBe(scans);
      expect(stored(attachment.id)?.status).toBe('SCANNING');
    });
  });
});

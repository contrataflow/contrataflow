import { randomUUID } from 'node:crypto';

import {
  attachmentDownloadSchema,
  attachmentIntentResponseSchema,
  attachmentSchema,
  pageMetaSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { AttachmentDto } from '@contrataflow/validation';
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
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { AntivirusCircuit } from '../application/antivirus-circuit.js';
import {
  ANTIVIRUS,
  ATTACHMENT_REPOSITORY,
  FILES_CLOCK,
  FILES_TRANSACTIONS,
} from '../application/files-ports.js';
import type { FilesTransactions } from '../application/files-ports.js';
import { ScanFileJob } from '../application/scan-file.job.js';
import { FakeAntivirus } from '../infrastructure/fake-antivirus.js';
import type { InMemoryAttachmentRepository } from '../infrastructure/in-memory-attachment.repository.js';

/*
 * US-069 — ATT-01 (lista), ATT-04 (detalhe) e ATT-05 (download) pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, rate limit, filtro RFC 9457) com a identidade fake,
 * os seeders reais, o processo do PRC-02, o documento da fábrica única e os adaptadores em memória.
 * Os 8 cenários do Gherkin + FA-01/FA-02 e a herança de POL-09 (RN-DOC-86). RLS no PostgreSQL:
 * `test/tenant-leak/attachment-download.spec.ts`.
 *
 * Personas: o usuário do Gherkin = Lúcia (GESTOR_CONTRATACOES, cria o processo e o documento —
 * custódia, POL-09 pela custódia); "Bruno" sem PROCESS_VIEW = Otávio; Ana (REQUISITANTE do setor
 * solicitante) vê o processo mas não atende POL-09; Heitor é da Prefeitura B.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');

const ORG_A = '0192d069-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d069-0000-7000-8000-0000000000a1',
  manutencao: '0192d069-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d069-0000-7000-8000-0000000000a3',
  saude: '0192d069-0000-7000-8000-0000000000a4',
  posto: '0192d069-0000-7000-8000-0000000000a5',
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

describe('Feature: Visualizar e baixar anexos (US-069)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  const antivirus = new FakeAntivirus();
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

  async function newDocument(inProcess: string, title = 'ETP 0003/2026'): Promise<string> {
    const document = await createDocumentAs(api, LUCIA, {
      processId: inProcess,
      documentTypeId: despachoTypeId,
      title,
      templateVersionId: null,
    });
    return document.id;
  }

  const call = (
    method: 'get' | 'post' | 'delete',
    path: string,
    options: { subject?: string; tenant?: string; ifMatch?: string; body?: object } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method !== 'get') pending = pending.set('Idempotency-Key', randomUUID());
    if (options.ifMatch !== undefined) pending = pending.set('If-Match', options.ifMatch);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  /** ATT-02 → PUT na quarentena → ATT-03 (sem varredura): anexo `UPLOADED`. */
  async function uploaded(
    target: { targetType: 'DOCUMENT' | 'PROCESS'; targetId: string },
    fileName = 'parecer.pdf',
    extra: Record<string, unknown> = {},
  ): Promise<AttachmentDto> {
    const bytes = pdfBytes(4096);
    const intent = await call('post', '/attachments', {
      body: {
        ...target,
        fileName,
        declaredMimeType: 'application/pdf',
        sizeBytes: bytes.length,
        ...extra,
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
  function runScan(id: string) {
    const job = jobQueueOf(api).find('file-scan', id);
    if (job === undefined) throw new Error(`file-scan de ${id} não enfileirado`);
    return api.app.get(ScanFileJob).process({
      id: job.jobId,
      queue: job.queue,
      name: job.name,
      attempt: 1,
      data: job.data,
    });
  }

  /** Anexo enviado e varrido (`AVAILABLE`). */
  async function available(
    target: { targetType: 'DOCUMENT' | 'PROCESS'; targetId: string } = {
      targetType: 'DOCUMENT',
      targetId: documentId,
    },
    fileName = 'parecer.pdf',
    extra: Record<string, unknown> = {},
  ): Promise<AttachmentDto> {
    const attachment = await uploaded(target, fileName, extra);
    await expect(runScan(attachment.id)).resolves.toBe('completed');
    return attachment;
  }

  const repository = () =>
    api.app.get<InMemoryAttachmentRepository>(ATTACHMENT_REPOSITORY, { strict: false });
  const auditOf = (action: string, entityId: string) =>
    api.auditRecords().filter((row) => row.action === action && row.entityId === entityId);

  const download = (id: string, options: { subject?: string; tenant?: string } = {}) =>
    call('get', `/attachments/${id}/download`, options);
  const list = (
    inProcess: string,
    query = '',
    options: { subject?: string; tenant?: string } = {},
  ) => call('get', `/processes/${inProcess}/attachments${query}`, options);
  const listed = (response: request.Response) => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: unknown[]; meta: unknown };
    return {
      data: body.data.map((item) => attachmentSchema.parse(item)),
      meta: pageMetaSchema.parse(body.meta),
    };
  };

  function restrictDocument(id: string, confidentiality: 'RESTRICTED' | 'INTERNAL'): void {
    const document = documentRepositoryOf(api)
      .allDocuments()
      .find((row) => row.id === id);
    if (document === undefined) throw new Error('documento não encontrado');
    documentRepositoryOf(api).seed({ ...document, confidentiality });
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: FILES_TRANSACTIONS, value: transactions },
        { token: FILES_CLOCK, value: () => NOW },
        { token: OBJECT_STORAGE, value: storage },
        { token: ANTIVIRUS, value: antivirus },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    // "Bruno": PROCESS_VIEW só na Saúde — o processo da Manutenção (Obras) não é visível a ele.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('REQUISITANTE')?.id ?? '',
      scopeType: 'DEPARTMENT',
      scopeDepartmentId: UNITS_A.saude,
      includeSubtree: false,
    });
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
    restrictDocument(documentId, 'INTERNAL');
    api.app.get(AntivirusCircuit).recordSuccess();
  });

  describe('[Sucesso]', () => {
    it('Baixar anexo disponível: 200 com URL de 300 s e auditoria anterior à assinatura', async () => {
      const attachment = await available(undefined, 'Parecer Jurídico (versão 2).pdf');
      const events: string[] = [];
      const presign = vi.spyOn(InMemoryObjectStorage.prototype, 'presignGet');
      presign.mockImplementationOnce((input) => {
        events.push(`presign:${auditOf('attachment.download', attachment.id).length}`);
        return Promise.resolve({
          url: `https://storage.test/${input.ref.bucket}/${input.ref.key}?X-Amz-Signature=test`,
          method: 'GET',
          headers: {},
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        });
      });

      const response = await download(attachment.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const signed = attachmentDownloadSchema.parse((response.body as { data: unknown }).data);
      const ttl = Date.parse(signed.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300_000);
      // RN-DOC-85: a trilha já existia quando a URL foi assinada.
      expect(events).toEqual(['presign:1']);
      expect(presign).toHaveBeenCalledWith(
        expect.objectContaining({
          downloadFileName: 'Parecer Jurídico (versão 2).pdf',
          contentType: 'application/pdf',
          expiresInSeconds: 300,
        }),
      );
      presign.mockRestore();
      expect(auditOf('attachment.download', attachment.id)[0]).toMatchObject({
        category: 'EXPORT',
        metadata: {
          fileName: 'Parecer Jurídico (versão 2).pdf',
          targetType: 'DOCUMENT',
          targetId: documentId,
        },
      });
    });

    it('ATT-01: lista metadados por -createdAt, sem chaves de storage nem URL', async () => {
      const inProcess = await newProcess();
      const doc = await newDocument(inProcess);
      const first = await available({ targetType: 'DOCUMENT', targetId: doc }, 'um.pdf');
      const second = await available({ targetType: 'PROCESS', targetId: inProcess }, 'dois.pdf');
      const { data, meta } = listed(await list(inProcess));
      expect(data.map((item) => item.id)).toEqual([second.id, first.id]);
      expect(meta).toMatchObject({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
      expect(data[0]).toMatchObject({ processId: inProcess, status: 'AVAILABLE' });
      const raw = JSON.stringify((await list(inProcess)).body);
      expect(raw).not.toMatch(/storageKey|quarantineKey|https?:\/\//);
    });

    it('ATT-01: filtra por alvo, exclui os excluídos e pagina', async () => {
      const inProcess = await newProcess();
      const doc = await newDocument(inProcess);
      const onDocument = await available({ targetType: 'DOCUMENT', targetId: doc }, 'doc.pdf');
      const onProcess = await available({ targetType: 'PROCESS', targetId: inProcess }, 'proc.pdf');
      const removed = await available({ targetType: 'PROCESS', targetId: inProcess }, 'fora.pdf');
      const current = attachmentSchema.parse(
        ((await call('get', `/attachments/${removed.id}`)).body as { data: unknown }).data,
      );
      expect(
        (
          await call('delete', `/attachments/${removed.id}`, {
            ifMatch: `"${current.version}"`,
            body: { deletionReason: 'Enviado por engano.' },
          })
        ).status,
      ).toBe(204);

      expect(
        listed(await list(inProcess))
          .data.map((item) => item.id)
          .sort(),
      ).toEqual([onDocument.id, onProcess.id].sort());
      expect(
        listed(await list(inProcess, `?targetType=DOCUMENT&targetId=${doc}`)).data.map(
          (item) => item.id,
        ),
      ).toEqual([onDocument.id]);
      expect(
        listed(await list(inProcess, '?targetType=PROCESS')).data.map((item) => item.id),
      ).toEqual([onProcess.id]);
      const page = listed(await list(inProcess, '?page=2&pageSize=1'));
      expect(page.data).toHaveLength(1);
      expect(page.meta).toMatchObject({ page: 2, pageSize: 1, totalItems: 2, totalPages: 2 });
    });

    it('ATT-04: detalhe só com metadados (sem URL, sem chaves de storage)', async () => {
      const attachment = await available();
      const response = await call('get', `/attachments/${attachment.id}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(attachmentSchema.parse((response.body as { data: unknown }).data)).toMatchObject({
        id: attachment.id,
        status: 'AVAILABLE',
        fileName: 'parecer.pdf',
      });
      expect(JSON.stringify(response.body)).not.toMatch(/storageKey|quarantineKey|https?:\/\//);
    });
  });

  describe('[Validação]', () => {
    it('Anexo ainda em verificação (UPLOADED/SCANNING): 409 ATTACHMENT_NOT_AVAILABLE e nenhuma URL', async () => {
      const pending = await uploaded(
        { targetType: 'DOCUMENT', targetId: documentId },
        'planilha.pdf',
      );
      const response = await download(pending.id);
      expectProblem(response, 409, 'ATTACHMENT_NOT_AVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain('X-Amz-Signature');
      expect(auditOf('attachment.download', pending.id)).toHaveLength(0);
    });

    it('V-01: filtro ou página inválidos → 422 VALIDATION_ERROR', async () => {
      expectProblem(await list(processId, '?targetType=INEXISTENTE'), 422, 'VALIDATION_ERROR');
      expectProblem(await list(processId, `?targetId=${documentId}`), 422, 'VALIDATION_ERROR');
      expectProblem(await list(processId, '?categoryId=abc'), 422, 'VALIDATION_ERROR');
      expectProblem(await list(processId, '?page=0'), 422, 'VALIDATION_ERROR');
      expectProblem(await list(processId, '?pageSize=101'), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('Sem acesso ao processo: 404 em ATT-01/04/05, sem revelar que o anexo existe', async () => {
      const attachment = await available();
      const unknown = await download(randomUUID(), { subject: 'sub-otavio' });
      const denied = await download(attachment.id, { subject: 'sub-otavio' });
      expectProblem(denied, 404, 'NOT_FOUND');
      expect(denied.body).toMatchObject({
        code: 'NOT_FOUND',
        detail: (unknown.body as { detail: string }).detail,
      });
      expectProblem(
        await call('get', `/attachments/${attachment.id}`, { subject: 'sub-otavio' }),
        404,
        'NOT_FOUND',
      );
      const foreignList = await list(processId, '', { subject: 'sub-otavio' });
      expectProblem(foreignList, 404, 'NOT_FOUND');
      expect(JSON.stringify(foreignList.body)).not.toContain('parecer');
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(0);
    });

    it('POL-09: alvo RESTRICTED sem a política → 403 (reasonCode POL-09); custodiante baixa', async () => {
      const attachment = await available();
      restrictDocument(documentId, 'RESTRICTED');

      const detail = await call('get', `/attachments/${attachment.id}`, { subject: 'sub-ana' });
      expectProblem(detail, 403, 'PERMISSION_DENIED');
      const denied = await download(attachment.id, { subject: 'sub-ana' });
      const body = expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(body.detail).toBe('Você não tem permissão para baixar este arquivo.');
      expect((denied.body as { reasonCode?: string }).reasonCode).toBe('POL-09');
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(0);
      expect(
        api
          .auditRecords()
          .filter((row) => row.action === 'access.denied')
          .at(-1),
      ).toMatchObject({ reasonCode: 'POL-09' });

      // A custodiante atende POL-09 e baixa o arquivo, sem mascaramento.
      expect((await download(attachment.id)).status).toBe(200);
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(1);
      // Documento não sigiloso: Ana também baixa.
      restrictDocument(documentId, 'INTERNAL');
      expect((await download(attachment.id, { subject: 'sub-ana' })).status).toBe(200);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Anexo e processo de outro tenant: 404 sem ler dados da Prefeitura A', async () => {
      const attachment = await available();
      const foreign = { subject: 'sub-heitor', tenant: B };
      expectProblem(await download(attachment.id, foreign), 404, 'NOT_FOUND');
      expectProblem(await call('get', `/attachments/${attachment.id}`, foreign), 404, 'NOT_FOUND');
      const foreignList = await list(processId, '', foreign);
      expectProblem(foreignList, 404, 'NOT_FOUND');
      expect(JSON.stringify(foreignList.body)).not.toContain('parecer');
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(0);
    });
  });

  describe('[Duplicidade]', () => {
    it('Dois pedidos em seguida: 200 nas duas vezes, cada uma com sua auditoria', async () => {
      const attachment = await available();
      const first = await download(attachment.id);
      const second = await download(attachment.id);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(2);
    });

    it('FA-02: URL vencida → nova solicitação gera nova URL e novo registro de auditoria', async () => {
      const attachment = await available();
      await download(attachment.id);
      const again = await download(attachment.id);
      expect(
        attachmentDownloadSchema.parse((again.body as { data: unknown }).data).expiresAt,
      ).toBeDefined();
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(2);
    });
  });

  describe('[Concorrência]', () => {
    it('Anexo excluído entre a listagem e o download: 409 ATTACHMENT_NOT_AVAILABLE', async () => {
      const inProcess = await newProcess();
      const doc = await newDocument(inProcess);
      const attachment = await available({ targetType: 'DOCUMENT', targetId: doc });
      // A listagem do usuário ainda o mostra como AVAILABLE...
      expect(listed(await list(inProcess)).data[0]).toMatchObject({ status: 'AVAILABLE' });
      // ...e outro usuário o exclui logo em seguida (marca no repositório, como o ATT-06 gravaria).
      const row = repository().rows.get(attachment.id);
      if (row === undefined) throw new Error('anexo não encontrado');
      repository().rows.set(attachment.id, {
        ...row,
        status: 'REJECTED',
        version: row.version + 1,
      });
      expectProblem(await download(attachment.id), 409, 'ATTACHMENT_NOT_AVAILABLE');
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(0);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao gravar a auditoria: 503 DEPENDENCY_UNAVAILABLE e nenhuma URL', async () => {
      const attachment = await available();
      const presign = vi.spyOn(InMemoryObjectStorage.prototype, 'presignGet');
      transactions.down = true;
      const response = await download(attachment.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain('X-Amz-Signature');
      expect(presign).not.toHaveBeenCalled();
      presign.mockRestore();
      transactions.down = false;
      expect(auditOf('attachment.download', attachment.id)).toHaveLength(0);
    });
  });

  describe('[Falha de integração]', () => {
    it('Object storage indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After', async () => {
      const attachment = await available();
      storage.failing = new Error('ECONNREFUSED');
      const response = await download(attachment.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
    });
  });
});

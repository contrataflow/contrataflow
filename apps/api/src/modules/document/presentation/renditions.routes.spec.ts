import { createHash, randomUUID } from 'node:crypto';

import {
  documentRenditionSchema,
  problemDetailsSchema,
  RENDITION_MESSAGES,
  renditionDownloadSchema,
} from '@contrataflow/validation';
import type { DocumentRenditionDto, DocumentVersionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { InMemoryObjectStorage } from '#shared/storage/in-memory-object-storage.js';
import { OBJECT_STORAGE } from '#shared/storage/storage.service.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { jobQueueOf } from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  createDocumentAs,
  documentTypeRepositoryOf,
  openStageForAnyType,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
} from '../../../../test/support/process-fixtures.js';
import {
  FakePdfRenderer,
  renditionRepositoryOf,
  runRender,
} from '../../../../test/support/rendition-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { DocumentValidatorRegistry } from '../application/document.ports.js';
import type { DocumentValidator, TypedSnapshotParts } from '../application/document.ports.js';
import { PdfRendererCircuit } from '../application/pdf-renderer-circuit.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import {
  RenderDeferredError,
  RenderFailedError,
  RenderRetryableError,
} from '../application/render-document.processor.js';
import { PDF_RENDERER } from '../application/rendition.ports.js';
import { requestPreview, startProcessing } from '../domain/document-rendition.js';

/*
 * US-067 — DOC-20/21/22/23 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização,
 * rate limit, filtro RFC 9457) com a identidade fake, os seeders reais e os adaptadores em memória;
 * o `document-render` roda como o worker (job enfileirado → `RenderDocumentJob`), com o Gotenberg
 * falso. Os 8 cenários do Gherkin, POL-09, validade da prévia e os casos de erro da story. Gatilho,
 * índices únicos e RLS no PostgreSQL: `test/tenant-leak/document-renditions.spec.ts`.
 *
 * Personas: redatora custodiante = Lúcia (GESTOR_CONTRATACOES, cria o processo); leitora sem POL-09
 * = Ana lotada no setor solicitante (vê o processo, sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`); "Bruno"
 * sem `PROCESS_VIEW` sobre o processo = Ana diante de um processo de outra secretaria (não o vê);
 * Otávio = sem `PROCESS_VIEW` em escopo nenhum.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');

const ORG_A = '0192d067-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d067-0000-7000-8000-0000000000a1',
  manutencao: '0192d067-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d067-0000-7000-8000-0000000000a3',
  saude: '0192d067-0000-7000-8000-0000000000a4',
  posto: '0192d067-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

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

/** Módulo tipado DFD simulado: cabeçalho e itens com valores monetários (POL-09). */
class FakeDfdValidator implements DocumentValidator {
  readonly module = 'DFD' as const;
  parts: TypedSnapshotParts = { header: {}, collections: {} };

  validate() {
    return Promise.resolve([]);
  }

  snapshotParts(): Promise<TypedSnapshotParts> {
    return Promise.resolve(this.parts);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

function renditionOf(response: request.Response, status = 202): DocumentRenditionDto {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return documentRenditionSchema.parse((response.body as { data: unknown }).data);
}

describe('Feature: Gerar PDF de documentos (US-067)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const storage = new InMemoryObjectStorage();
  const renderer = new FakePdfRenderer();
  const dfdValidator = new FakeDfdValidator();
  let now = NOW;
  let openStages: Set<string>;
  let types: { despacho: string; dfd: string; externo: string };

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  /** Processo novo (PRC-02) criado por Lúcia; por padrão na secretaria de Ana (que o vê). */
  async function newProcess(
    units = { secretariat: UNITS_A.obras, department: UNITS_A.manutencao },
  ) {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: units.secretariat,
        requestingDepartmentId: units.department,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    openStages.add(id);
    return id;
  }

  const newDocument = (processId: string, typeId = types.despacho, title = 'ETP 0003/2026') =>
    createDocumentAs(api, LUCIA, {
      processId,
      documentTypeId: typeId,
      title,
      templateVersionId: null,
    });

  function patchProcess(processId: string, patch: Record<string, unknown>) {
    const repository = processRepositoryOf(api);
    const process = repository.allProcesses().find((row) => row.id === processId);
    if (process === undefined) throw new Error('processo não encontrado');
    repository.seed({ ...process, ...patch });
  }

  const call = (
    method: 'get' | 'post',
    path: string,
    options: { subject?: string; tenant?: string; body?: object; key?: string } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.key !== undefined) pending = pending.set('Idempotency-Key', options.key);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  /** DOC-16: "Salvar versão" (cria a versão N com o rascunho atual). */
  async function saveVersion(documentId: string): Promise<DocumentVersionDto> {
    const response = await call('post', `/documents/${documentId}/versions`, {
      key: randomUUID(),
      body: {},
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: DocumentVersionDto }).data;
  }

  /** "ETP 0003/2026" com a versão 2 finalizada (Background do Gherkin). */
  async function documentWithVersion2(processId?: string, typeId?: string) {
    const document = await newDocument(processId ?? (await newProcess()), typeId);
    await saveVersion(document.id);
    const v2 = await saveVersion(document.id);
    return { document, v2 };
  }

  const requestContent = (versionId: string, subject?: string) =>
    call('post', `/document-versions/${versionId}/renditions`, {
      body: { kind: 'CONTENT' },
      ...(subject === undefined ? {} : { subject }),
    });
  const requestPreviewOf = (documentId: string, subject?: string) =>
    call('post', `/documents/${documentId}/preview`, {
      ...(subject === undefined ? {} : { subject }),
    });
  const status = (id: string, subject?: string) =>
    call('get', `/document-renditions/${id}`, {
      ...(subject === undefined ? {} : { subject }),
    });
  const download = (id: string, subject?: string) =>
    call('get', `/document-renditions/${id}/download`, {
      ...(subject === undefined ? {} : { subject }),
    });

  const stored = (id: string) => renditionRepositoryOf(api).rows.get(id);
  const auditOf = (action: string, entityId?: string) =>
    api
      .auditRecords()
      .filter(
        (row) => row.action === action && (entityId === undefined || row.entityId === entityId),
      );
  const eventsOf = (aggregateId: string, eventType: string) =>
    api
      .outboxRows()
      .filter((row) => row.aggregateId === aggregateId && row.eventType === eventType);
  const renderJobs = () =>
    jobQueueOf(api)
      .all()
      .filter((job) => job.queue === 'document-render');

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DOCUMENT_CLOCK, value: () => now },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: OBJECT_STORAGE, value: storage },
        { token: PDF_RENDERER, value: renderer },
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
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    openStages = openStageForAnyType(api);
    api.app.get(DocumentValidatorRegistry).override(dfdValidator);
    const seeded = documentTypeRepositoryOf(api)
      .snapshot()
      .filter((type) => type.tenantId === A);
    const idOf = (code: string) => seeded.find((type) => type.code === code)?.id ?? '';
    types = { despacho: idOf('DESPACHO'), dfd: idOf('DFD'), externo: idOf('DOCUMENTO_EXTERNO') };
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
    renderer.failing = null;
    jobQueueOf(api).down = false;
    dfdValidator.parts = { header: {}, collections: {} };
    now = NOW;
    api.app.get(PdfRendererCircuit).recordSuccess();
  });

  describe('[Sucesso]', () => {
    it('Gerar o PDF oficial da versão 2: 202 PENDING CONTENT → worker → READY, SHA-256, evento e hash no rodapé', async () => {
      const { document, v2 } = await documentWithVersion2();

      const response = await requestContent(v2.id);
      const pending = renditionOf(response, 202);
      expect(pending).toMatchObject({
        documentId: document.id,
        documentVersionId: v2.id,
        draftRevision: null,
        kind: 'CONTENT',
        status: 'PENDING',
        masked: false,
        attempts: 0,
        requestedById: FAKE_USERS.lucia.id,
        requestedAt: NOW.toISOString(),
        expiresAt: null,
      });
      expect(JSON.stringify(response.body)).not.toContain('storageKey');
      // Padrão B: depois do commit, `jobId = renditionId`, prioridade da versão (5).
      const job = jobQueueOf(api).find('document-render', pending.id);
      expect(job).toMatchObject({
        name: 'render',
        options: { jobId: pending.id, attempts: 5, backoffMs: 5_000, priority: 5 },
      });
      expect(job?.data.payload).toEqual({
        renditionId: pending.id,
        documentId: document.id,
        kind: 'CONTENT',
        documentVersionId: v2.id,
      });
      expect(auditOf('document.render_request', pending.id)[0]).toMatchObject({
        category: 'DATA_CHANGE',
        metadata: expect.objectContaining({
          kind: 'CONTENT',
          documentVersionId: v2.id,
          reused: false,
        }) as unknown,
      });

      await runRender(api, pending.id);

      const ready = renditionOf(await status(pending.id), 200);
      const key = `tenants/${A}/processes/${document.processId}/documents/${document.id}/versions/2/renditions/content.pdf`;
      const object = storage.get({ bucket: 'renditions', key });
      expect(object).toBeDefined();
      const sha256 = createHash('sha256')
        .update(object?.body ?? Buffer.alloc(0))
        .digest('hex');
      expect(ready).toMatchObject({
        status: 'READY',
        sha256,
        sizeBytes: object?.body.length,
        pageCount: 2,
        attempts: 1,
        readyAt: NOW.toISOString(),
      });
      expect(object).toMatchObject({
        contentType: 'application/pdf',
        tags: { 'cf-retention': 'evidence' },
        metadata: { 'cf-rendition-id': pending.id, 'cf-sha256': sha256, 'cf-tenant-id': A },
      });
      const [event] = eventsOf(pending.id, 'DocumentRenditionReady');
      expect(event).toMatchObject({ routingKey: 'document.rendition_ready' });
      expect(event?.payload).toEqual({
        documentId: document.id,
        documentVersionId: v2.id,
        renditionId: pending.id,
        kind: 'CONTENT',
        sha256,
        pageCount: 2,
      });
      // O rodapé leva o hash da versão (showDocumentHashInFooter = true por padrão).
      expect(renderer.requests.at(-1)?.footerHtml).toContain(
        `Hash SHA-256 da versão: ${v2.contentHash}`,
      );
      expect(renderer.lastHtml()).not.toContain('RASCUNHO');

      const link = await download(pending.id);
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      const signed = renditionDownloadSchema.parse((link.body as { data: unknown }).data);
      expect(signed.url).toContain(key);
      const ttl = Date.parse(signed.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300_000);
      expect(auditOf('document.download', pending.id)[0]).toMatchObject({
        category: 'EXPORT',
        metadata: expect.objectContaining({ renditionId: pending.id, kind: 'CONTENT' }) as unknown,
      });
    });

    it('Gerar prévia do rascunho: PREVIEW pela revisão, validade de 24 h, prioridade 1 e marca d’água', async () => {
      const document = await newDocument(await newProcess());
      const preview = renditionOf(await requestPreviewOf(document.id));
      expect(preview).toMatchObject({
        kind: 'PREVIEW',
        status: 'PENDING',
        documentVersionId: null,
        draftRevision: document.draftRevision,
        expiresAt: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
      });
      expect(jobQueueOf(api).find('document-render', preview.id)?.options.priority).toBe(1);
      expect(auditOf('document.render_request', preview.id)[0]?.metadata).toMatchObject({
        kind: 'PREVIEW',
        draftRevision: document.draftRevision,
        renditionId: preview.id,
        reused: false,
      });

      await runRender(api, preview.id);
      expect(renderer.lastHtml()).toContain('class="cf-watermark"');
      expect(renderer.lastHtml()).toContain('RASCUNHO');
      expect(renderer.requests.at(-1)?.footerHtml).not.toContain('Hash SHA-256');
      const key = `tenants/${A}/previews/${document.id}/${preview.id}.pdf`;
      expect(storage.get({ bucket: 'renditions', key })?.tags).toEqual({
        'cf-retention': 'ephemeral',
      });
      expect(renditionOf(await status(preview.id), 200).status).toBe('READY');
      expect((await download(preview.id)).status).toBe(200);
    });
  });

  describe('[Validação]', () => {
    it('Baixar PDF antes de ficar pronto (PROCESSING): 409 RENDITION_NOT_READY', async () => {
      const { v2 } = await documentWithVersion2();
      const pending = renditionOf(await requestContent(v2.id));
      expect(expectProblem(await download(pending.id), 409, 'RENDITION_NOT_READY').detail).toBe(
        RENDITION_MESSAGES.notReady,
      );
      // Falha transitória na 1ª tentativa: a rendition fica PROCESSING ("Gerando PDF…").
      renderer.failing = 'unavailable';
      await expect(runRender(api, pending.id, 1)).rejects.toBeInstanceOf(RenderRetryableError);
      expect(stored(pending.id)?.status).toBe('PROCESSING');
      expectProblem(await download(pending.id), 409, 'RENDITION_NOT_READY');
      expect(auditOf('document.download', pending.id)).toEqual([]);
    });

    it('Prévia expirada (FA-04): 409 RENDITION_NOT_READY com "Esta prévia expirou"', async () => {
      const document = await newDocument(await newProcess());
      const preview = renditionOf(await requestPreviewOf(document.id));
      await runRender(api, preview.id);
      now = new Date(NOW.getTime() + 24 * 3_600_000);
      const problem = expectProblem(await download(preview.id), 409, 'RENDITION_NOT_READY');
      expect(problem.detail).toBe(RENDITION_MESSAGES.previewExpired);
    });

    it('Corpo do DOC-21: kind obrigatório, approvalId só no selo e deve cobrir a versão', async () => {
      const { v2 } = await documentWithVersion2();
      const path = `/document-versions/${v2.id}/renditions`;
      expectProblem(await call('post', path, { body: {} }), 422, 'VALIDATION_ERROR');
      expectProblem(
        await call('post', path, { body: { kind: 'SIGNED' } }),
        422,
        'VALIDATION_ERROR',
      );
      const noApproval = expectProblem(
        await call('post', path, { body: { kind: 'APPROVAL_STAMPED' } }),
        422,
        'VALIDATION_ERROR',
      );
      expect(noApproval.errors[0]).toMatchObject({ field: 'approvalId' });
      const uncovered = expectProblem(
        await call('post', path, { body: { kind: 'APPROVAL_STAMPED', approvalId: newId() } }),
        422,
        'VALIDATION_ERROR',
      );
      expect(uncovered.errors[0]).toMatchObject({
        field: 'approvalId',
        code: 'REFERENCE_NOT_FOUND',
      });
      expectProblem(await requestContent(newId()), 404, 'NOT_FOUND');
    });

    it('Documento externo: prévia recusada com 422 NOT_ALLOWED (o arquivo é o documento)', async () => {
      const document = await newDocument(await newProcess(), types.externo, 'Ofício do TCE');
      const problem = expectProblem(await requestPreviewOf(document.id), 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ field: 'kind', code: 'NOT_ALLOWED' });
    });

    it('Conversor recusa o conteúdo (4xx — V-04): FAILED sem nova tentativa e DocumentRenditionFailed', async () => {
      const { v2 } = await documentWithVersion2();
      const pending = renditionOf(await requestContent(v2.id));
      renderer.failing = 'rejected';
      await expect(runRender(api, pending.id, 1)).rejects.toBeInstanceOf(RenderFailedError);
      const failed = renditionOf(await status(pending.id), 200);
      expect(failed).toMatchObject({
        status: 'FAILED',
        errorCode: 'RENDERER_REJECTED',
        attempts: 1,
      });
      expect(JSON.stringify(failed)).not.toContain('errorMessage');
      expect(eventsOf(pending.id, 'DocumentRenditionFailed')[0]?.payload).toMatchObject({
        errorCode: 'RENDERER_REJECTED',
        attempts: 1,
      });
      // PDF inválido devolvido pelo conversor também é permanente.
      renderer.failing = 'invalid';
      const retry = renditionOf(await requestContent(v2.id));
      await expect(runRender(api, retry.id, 1)).rejects.toBeInstanceOf(RenderFailedError);
      expect(stored(retry.id)).toMatchObject({ status: 'FAILED', errorCode: 'INVALID_PDF' });
    });
  });

  describe('[Permissão]', () => {
    it('"Bruno" sem PROCESS_VIEW sobre o processo: 404 nas quatro rotas e nada criado', async () => {
      const processId = await newProcess({ secretariat: UNITS_A.saude, department: UNITS_A.posto });
      const { document, v2 } = await documentWithVersion2(processId);
      const own = renditionOf(await requestContent(v2.id));
      const before = renditionRepositoryOf(api).all().length;

      expectProblem(await requestContent(v2.id, 'sub-ana'), 404, 'NOT_FOUND');
      expectProblem(await requestPreviewOf(document.id, 'sub-ana'), 404, 'NOT_FOUND');
      expectProblem(await status(own.id, 'sub-ana'), 404, 'NOT_FOUND');
      expectProblem(await download(own.id, 'sub-ana'), 404, 'NOT_FOUND');
      expect(renditionRepositoryOf(api).all()).toHaveLength(before);
    });

    it('Sem PROCESS_VIEW em escopo nenhum: 403 PERMISSION_DENIED na rota', async () => {
      const { v2 } = await documentWithVersion2();
      expectProblem(await requestContent(v2.id, 'sub-otavio'), 403, 'PERMISSION_DENIED');
    });

    it('POL-09 (FA-05): quem não vê o orçamento sigiloso recebe o PDF mascarado; o completo exige POL-09', async () => {
      const processId = await newProcess();
      patchProcess(processId, { isBudgetConfidential: true });
      dfdValidator.parts = {
        header: { objective: 'Pavimentar', estimatedValue: '1000.00' },
        collections: {
          items: [{ processItemId: 'i1', description: 'Cimento', unitPrice: '10.00' }],
        },
      };
      const { v2 } = await documentWithVersion2(processId, types.dfd);

      const masked = renditionOf(await requestContent(v2.id, 'sub-ana'));
      expect(masked.masked).toBe(true);
      await runRender(api, masked.id);
      expect(renderer.lastHtml()).toContain('Valor sigiloso');
      expect(renderer.lastHtml()).not.toMatch(/1000\.00|10\.00/);
      expect((await download(masked.id, 'sub-ana')).status).toBe(200);

      // A custodiante (POL-09 por custódia) gera o PDF completo — outro, não o mascarado.
      const full = renditionOf(await requestContent(v2.id));
      expect(full.id).not.toBe(masked.id);
      expect(full.masked).toBe(false);
      await runRender(api, full.id);
      expect(renderer.lastHtml()).toContain('1000.00');
      expect(stored(full.id)?.storageKey).toMatch(/\/content\.pdf$/);
      expect(stored(masked.id)?.storageKey).toMatch(/\/content-masked\.pdf$/);
      // Quem não atende POL-09 nunca baixa o completo.
      const denied = expectProblem(await download(full.id, 'sub-ana'), 403, 'PERMISSION_DENIED');
      expect(denied.detail).toBe(RENDITION_MESSAGES.confidential);
      expect(auditOf('document.download', full.id)).toEqual([]);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Rendition "R9" da Prefeitura B: 404 em DOC-22/23 sem revelar nenhum dado', async () => {
      const foreign = startProcessing(
        requestPreview({
          id: newId(),
          tenantId: B,
          processId: newId(),
          documentId: newId(),
          draftRevision: 3,
          masked: false,
          requestedById: FAKE_USERS.ana.id,
          now: NOW,
        }),
        1,
        NOW,
      );
      renditionRepositoryOf(api).rows.set(foreign.id, foreign);
      for (const response of [await status(foreign.id), await download(foreign.id)]) {
        const problem = expectProblem(response, 404, 'NOT_FOUND');
        expect(JSON.stringify(problem)).not.toContain(foreign.documentId);
      }
      expect(stored(foreign.id)?.status).toBe('PROCESSING');
    });
  });

  describe('[Duplicidade]', () => {
    it('Pedido repetido para a versão 2 com CONTENT READY: 200 com a existente e nenhum novo job', async () => {
      const { v2 } = await documentWithVersion2();
      const first = renditionOf(await requestContent(v2.id));
      await runRender(api, first.id);
      const jobs = renderJobs().length;
      const renders = renderer.requests.length;

      const again = renditionOf(await requestContent(v2.id), 200);
      expect(again).toMatchObject({ id: first.id, status: 'READY' });
      expect(renderJobs()).toHaveLength(jobs);
      expect(renderer.requests).toHaveLength(renders);
      expect(auditOf('document.render_request', first.id).at(-1)?.metadata).toMatchObject({
        reused: true,
      });
    });

    it('"Tentar novamente" depois de FAILED: nova rendition (202) e novo job', async () => {
      const { v2 } = await documentWithVersion2();
      const first = renditionOf(await requestContent(v2.id));
      renderer.failing = 'rejected';
      await expect(runRender(api, first.id)).rejects.toBeInstanceOf(RenderFailedError);
      renderer.failing = null;
      const retry = renditionOf(await requestContent(v2.id), 202);
      expect(retry.id).not.toBe(first.id);
      await runRender(api, retry.id);
      expect(stored(retry.id)?.status).toBe('READY');
    });
  });

  describe('[Concorrência]', () => {
    it('Duas prévias em sequência rápida na revisão 5: duas renditions independentes', async () => {
      const document = await newDocument(await newProcess());
      const [one, two] = await Promise.all([
        requestPreviewOf(document.id),
        requestPreviewOf(document.id),
      ]);
      const first = renditionOf(one);
      const second = renditionOf(two);
      expect(first.id).not.toBe(second.id);
      expect(first.draftRevision).toBe(second.draftRevision);
      await Promise.all([runRender(api, first.id), runRender(api, second.id)]);
      const [a, b] = [stored(first.id), stored(second.id)];
      expect(a?.status).toBe('READY');
      expect(b?.status).toBe('READY');
      expect(a?.storageKey).not.toBe(b?.storageKey);
      expect(a?.sha256).not.toBe(b?.sha256);
      // Mesma entrega processada de novo (redelivery): sem efeito sobre o estado.
      await expect(runRender(api, first.id)).resolves.toBe('completed');
      expect(stored(first.id)).toEqual(a);
    });

    it('Dois pedidos simultâneos de CONTENT para a mesma versão: uma única rendition gerada (FA-01)', async () => {
      const { v2 } = await documentWithVersion2();
      const responses = await Promise.all([requestContent(v2.id), requestContent(v2.id)]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 202]);
      const ids = new Set(
        responses.map((response) => (response.body as { data: { id: string } }).data.id),
      );
      expect(ids.size).toBe(1);
      const contents = renditionRepositoryOf(api)
        .all()
        .filter((row) => row.documentVersionId === v2.id && row.kind === 'CONTENT');
      expect(contents).toHaveLength(1);
      expect(renderJobs().filter((job) => job.jobId === contents[0]?.id)).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao registrar o pedido: 503 DEPENDENCY_UNAVAILABLE e nenhuma rendition', async () => {
      const { document, v2 } = await documentWithVersion2();
      const before = renditionRepositoryOf(api).all().length;
      const jobs = renderJobs().length;
      transactions.down = true;
      expectProblem(await requestContent(v2.id), 503, 'DEPENDENCY_UNAVAILABLE');
      expectProblem(await requestPreviewOf(document.id), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(renditionRepositoryOf(api).all()).toHaveLength(before);
      expect(renderJobs()).toHaveLength(jobs);
    });
  });

  describe('[Falha de integração]', () => {
    it('Gotenberg fora: pausa sem consumir tentativa com o circuito aberto; esgotadas as tentativas → FAILED + DocumentRenditionFailed', async () => {
      const { document, v2 } = await documentWithVersion2();
      const pending = renditionOf(await requestContent(v2.id));
      const circuit = api.app.get(PdfRendererCircuit);
      for (let index = 0; index < circuit.policy.failureThreshold; index += 1) {
        circuit.recordFailure();
      }
      expect(circuit.state).toBe('OPEN');
      const renders = renderer.requests.length;
      await expect(runRender(api, pending.id, 1)).rejects.toBeInstanceOf(RenderDeferredError);
      // Sem tocar a linha nem chamar o conversor: segue "Gerando PDF…".
      expect(stored(pending.id)).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect(renderer.requests).toHaveLength(renders);
      expect(renditionOf(await status(pending.id), 200).status).toBe('PENDING');

      // O circuito fecha e o Gotenberg volta a falhar: 4 tentativas com retry, a 5ª encerra.
      circuit.recordSuccess();
      renderer.failing = 'unavailable';
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(runRender(api, pending.id, attempt)).rejects.toBeInstanceOf(
          RenderRetryableError,
        );
        expect(stored(pending.id)).toMatchObject({ status: 'PROCESSING', attempts: attempt });
      }
      await expect(runRender(api, pending.id, 5)).rejects.toBeInstanceOf(RenderFailedError);
      expect(stored(pending.id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'RENDERER_UNAVAILABLE',
        attempts: 5,
      });
      const [event] = eventsOf(pending.id, 'DocumentRenditionFailed');
      expect(event).toMatchObject({ routingKey: 'document.rendition_failed' });
      expect(event?.payload).toEqual({
        documentId: document.id,
        renditionId: pending.id,
        kind: 'CONTENT',
        errorCode: 'RENDERER_UNAVAILABLE',
        attempts: 5,
      });
      expect(eventsOf(pending.id, 'DocumentRenditionReady')).toEqual([]);
    });

    it('Fila indisponível no pedido: 202 mesmo assim; a rendition fica PENDING para o reconciliador', async () => {
      const { v2 } = await documentWithVersion2();
      jobQueueOf(api).down = true;
      const pending = renditionOf(await requestContent(v2.id));
      jobQueueOf(api).down = false;
      expect(stored(pending.id)?.status).toBe('PENDING');
      expect(jobQueueOf(api).find('document-render', pending.id)).toBeUndefined();
      // Novo pedido equivalente reaproveita a PENDING e reenfileira (o `jobId` deduplica).
      const again = renditionOf(await requestContent(v2.id), 200);
      expect(again.id).toBe(pending.id);
      expect(jobQueueOf(api).find('document-render', pending.id)).toBeDefined();
    });

    it('Storage fora ao gravar o PDF: retry; na última tentativa FAILED (STORAGE_UNAVAILABLE)', async () => {
      const { v2 } = await documentWithVersion2();
      const pending = renditionOf(await requestContent(v2.id));
      storage.failing = new Error('S3 503');
      await expect(runRender(api, pending.id, 1)).rejects.toBeInstanceOf(RenderRetryableError);
      await expect(runRender(api, pending.id, 5)).rejects.toBeInstanceOf(RenderFailedError);
      expect(stored(pending.id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'STORAGE_UNAVAILABLE',
      });
    });

    it('Storage fora ao assinar o download: 503 DEPENDENCY_UNAVAILABLE', async () => {
      const { v2 } = await documentWithVersion2();
      const pending = renditionOf(await requestContent(v2.id));
      await runRender(api, pending.id);
      storage.failing = new Error('S3 503');
      expectProblem(await download(pending.id), 503, 'DEPENDENCY_UNAVAILABLE');
    });

    it('Limite de renderização (20 req/min por usuário + tenant): 429 RATE_LIMITED', async () => {
      const document = await newDocument(await newProcess());
      let last: request.Response | null = null;
      for (let index = 0; index < 21; index += 1) last = await requestPreviewOf(document.id);
      if (last === null) throw new Error('sem resposta');
      expectProblem(last, 429, 'RATE_LIMITED');
      expect(last.headers['retry-after']).toBeDefined();
    });
  });
});

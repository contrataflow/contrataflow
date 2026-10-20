import { createHash, randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  renditionDownloadSchema,
  templatePreviewRequestedSchema,
  templatePreviewSchema,
} from '@contrataflow/validation';
import type { TemplateDto, TemplatePreviewDto, TemplateVersionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { InMemoryObjectStorage } from '#shared/storage/in-memory-object-storage.js';
import { OBJECT_STORAGE } from '#shared/storage/storage.service.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { jobQueueOf } from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  ATTACHMENT_REPOSITORY,
  createAttachment,
} from '../../../../test/support/files-fixtures.js';
import type { InMemoryAttachmentRepository } from '../../../../test/support/files-fixtures.js';
import {
  FakePdfRenderer,
  runTemplatePreview,
} from '../../../../test/support/rendition-fixtures.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import { PDF_RENDERER } from '../application/rendition.ports.js';
import { TEMPLATE_REPOSITORY } from '../application/template.ports.js';
import { buildSystemDocumentTypes } from '../domain/system-document-types.js';
import { SECTION_PLACEHOLDER } from '../domain/template-preview.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';
import type { InMemoryTemplateRepository } from '../infrastructure/in-memory-template.repository.js';

/*
 * US-109 — TPL-08 (`layout`), TPL-09/12/13 (prévia efêmera) e o logo `TENANT_ASSET` (ATT-02) pelo
 * pipeline HTTP completo (autenticação, tenant, vínculo, If-Match, rate limit, Zod, RFC 9457) com a
 * identidade fake, a auditoria real e os adaptadores em memória (Redis do cache, fila, storage); o
 * `document-render/template-preview` roda como o worker, com o Gotenberg falso. Os 10 cenários do
 * Gherkin, FA-01..04 e os casos de erro. O logo de outro tenant sobre o PostgreSQL (RLS) está em
 * `test/tenant-leak/template-layout.spec.ts`; o TTL de 24 h no Redis real, em
 * `test/document/template-previews.spec.ts`.
 *
 * Personagens: Marta (ADMIN_ORGAO — "Felipe" da story), Otávio (ADMIN_ORGAO — a segunda pessoa com
 * TEMPLATE_MANAGE da concorrência), Lúcia (GESTOR_CONTRATACOES — envia o logo: TEMPLATE_MANAGE +
 * ATTACHMENT_UPLOAD), Ana (só TEMPLATE_VIEW — "Marina") e Heitor (Prefeitura B).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const ANA = FAKE_USERS.ana;
const HEITOR = FAKE_USERS.heitor;
/** GESTOR_CONTRATACOES: TEMPLATE_MANAGE + ATTACHMENT_UPLOAD (o ADM não tem ATTACHMENT_UPLOAD). */
const LUCIA = FAKE_USERS.lucia;
const NOW = new Date('2026-10-17T12:00:00.000Z');
const MFA = ['pwd', 'otp'];
/** PNG mínimo (assinatura + IHDR): o suficiente para o `data:` URI. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

interface User {
  subject: string;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- leitura tipada do envelope
const dataOf = <T>(response: request.Response): T => (response.body as { data: T }).data;

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Feature: Layout de impressão (timbre, cabeçalho, rodapé) (US-109)', () => {
  let api: TestApi;
  let types: InMemoryDocumentTypeRepository;
  let templates: InMemoryTemplateRepository;
  let attachments: InMemoryAttachmentRepository;
  const storage = new InMemoryObjectStorage();
  const renderer = new FakePdfRenderer();
  let now = NOW;
  let brasaoId: string;
  let logoOfB: string;

  /** Anexo `AVAILABLE` gravado direto no repositório e no bucket `documents`. */
  async function seedAsset(
    tenantId: string,
    overrides: { targetType?: 'TENANT_ASSET' | 'PROCESS'; status?: 'AVAILABLE' | 'SCANNING' } = {},
  ): Promise<string> {
    const id = newId();
    const storageKey = `tenants/${tenantId}/assets/${id}/brasao.png`;
    const base = createAttachment({
      id,
      tenantId,
      processId: overrides.targetType === 'PROCESS' ? newId() : null,
      targetType: overrides.targetType ?? 'TENANT_ASSET',
      targetId: newId(),
      categoryId: null,
      fileName: 'brasao.png',
      extension: 'png',
      declaredMimeType: 'image/png',
      sizeBytes: PNG.length,
      storageKey,
      quarantineKey: `tenants/${tenantId}/uploads/${id}`,
      description: null,
      uploadedById: MARTA.id,
      now: NOW,
    });
    const status = overrides.status ?? 'AVAILABLE';
    attachments.rows.set(id, {
      ...base,
      status,
      sha256: status === 'AVAILABLE' ? createHash('sha256').update(PNG).digest('hex') : null,
      detectedMimeType: status === 'AVAILABLE' ? 'image/png' : null,
    });
    await storage.putObject({
      ref: { bucket: 'documents', key: storageKey },
      body: PNG,
      contentType: 'image/png',
      sha256: createHash('sha256').update(PNG).digest('hex'),
      metadata: {},
      tags: {},
    });
    return id;
  }

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_CLOCK, value: () => now },
        { token: OBJECT_STORAGE, value: storage },
        { token: PDF_RENDERER, value: renderer },
      ],
    });
    types = api.app.get(InMemoryDocumentTypeRepository, { strict: false });
    templates = api.app.get(TEMPLATE_REPOSITORY, { strict: false });
    attachments = api.app.get(ATTACHMENT_REPOSITORY, { strict: false });
    // Background: tenants A ("Prefeitura de São José") e B ativos com os tipos de sistema; o
    // anexo "brasao.png" disponível (TENANT_ASSET) em A e "logo-b.png" em B.
    await types.insertMissing({} as never, buildSystemDocumentTypes(A, NOW, newId));
    await types.insertMissing({} as never, buildSystemDocumentTypes(B, NOW, newId));
    brasaoId = await seedAsset(A);
    logoOfB = await seedAsset(B);
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    renderer.failing = null;
    jobQueueOf(api).down = false;
    now = NOW;
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const withAuth = (test: request.Test, user: User, tenant: string = A) =>
    test.set('Authorization', api.bearer(user.subject, { amr: MFA })).set('X-Tenant-Id', tenant);

  const typeId = (code: string, tenantId: string = A): string => {
    const type = types.snapshot().find((row) => row.code === code && row.tenantId === tenantId);
    if (!type) throw new Error(`tipo ${code} inexistente`);
    return type.id;
  };

  /** "Ofício padrão" com o rascunho em `DRAFT` e uma seção (sem conteúdo padrão). */
  async function newTemplate(user: User = MARTA, tenant: string = A) {
    const created = await withAuth(request(api.server).post('/api/v1/templates'), user, tenant)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Ofício padrão ${randomUUID().slice(0, 8)}`,
        documentTypeId: typeId('OFICIO', tenant),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const template = dataOf<TemplateDto>(created);
    const versionId = template.draftVersion?.id ?? '';
    const sections = await patch(
      versionId,
      {
        sections: [
          { key: 'ASSUNTO', title: 'Assunto', order: 1, defaultContent: doc('Ao {{user.name}}') },
          { key: 'CORPO', title: 'Corpo', order: 2 },
        ],
      },
      '"1"',
      user,
      tenant,
    );
    expect(sections.status, JSON.stringify(sections.body)).toBe(200);
    return { template, versionId, etag: String(sections.headers.etag) };
  }

  const patch = (
    versionId: string,
    body: Record<string, unknown>,
    ifMatch: string,
    user: User = MARTA,
    tenant: string = A,
  ) =>
    withAuth(request(api.server).patch(`/api/v1/template-versions/${versionId}`), user, tenant)
      .set('If-Match', ifMatch)
      .send(body);
  const patchLayout = (
    versionId: string,
    layout: Record<string, unknown>,
    ifMatch: string,
    user: User = MARTA,
  ) => patch(versionId, { layout }, ifMatch, user);
  const getVersion = (versionId: string) =>
    withAuth(request(api.server).get(`/api/v1/template-versions/${versionId}`), MARTA);
  const requestPreview = (versionId: string, user: User = MARTA, tenant: string = A) =>
    withAuth(
      request(api.server).post(`/api/v1/template-versions/${versionId}/preview`),
      user,
      tenant,
    ).send();
  const getPreview = (
    versionId: string,
    renditionId: string,
    user: User = MARTA,
    tenant: string = A,
  ) =>
    withAuth(
      request(api.server).get(`/api/v1/template-versions/${versionId}/preview/${renditionId}`),
      user,
      tenant,
    );
  const download = (versionId: string, renditionId: string) =>
    withAuth(
      request(api.server).get(
        `/api/v1/template-versions/${versionId}/preview/${renditionId}/download`,
      ),
      MARTA,
    );

  function renditionIdOf(response: request.Response): string {
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return templatePreviewRequestedSchema.parse(dataOf(response)).renditionId;
  }

  function previewOf(response: request.Response): TemplatePreviewDto {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return templatePreviewSchema.parse(dataOf(response));
  }

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);

  describe('[Sucesso]', () => {
    it('configura cabeçalho, rodapé, margens, fonte e o logo: 200 com novo ETag e auditoria template.update', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { versionId, etag } = await newTemplate();
      const audits = auditOf('template.update').length;

      const response = await patchLayout(
        versionId,
        {
          marginsMm: { top: 25, right: 25, bottom: 25, left: 25 },
          fontFamily: 'Times New Roman',
          fontSizePt: 12,
          header: doc('{{organization.name}}'),
          footer: doc('Página {{page}} de {{pages}} · {{document.hash}} · {{document.version}}'),
          logo: { attachmentId: brasaoId, position: 'center' },
        },
        etag,
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).not.toBe(etag);
      const { layout } = dataOf<TemplateVersionDto>(response);
      expect(layout).toMatchObject({
        pageSize: 'A4',
        orientation: 'portrait',
        marginsMm: { top: 25, right: 25, bottom: 25, left: 25 },
        fontFamily: 'Times New Roman',
        fontSizePt: 12,
        lineHeight: 1.15,
        header: doc('{{organization.name}}'),
        logo: { attachmentId: brasaoId, position: 'center', maxHeightMm: 15 },
        showPageNumbers: true,
        showDocumentHashInFooter: true,
        draftWatermark: true,
      });
      expect(dataOf<TemplateVersionDto>(await getVersion(versionId)).layout).toEqual(layout);

      const records = auditOf('template.update');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({ category: 'CONFIGURATION' });
      expect(records.at(-1)?.changes).toEqual([
        {
          path: 'layoutChangedFields',
          old: null,
          new: [
            'fontFamily',
            'fontSizePt',
            'marginsMm.top',
            'marginsMm.right',
            'marginsMm.bottom',
            'marginsMm.left',
            'header',
            'footer',
            'logo.attachmentId',
            'logo.position',
            'logo.maxHeightMm',
          ],
        },
      ]);
      const layoutLog = log.mock.calls.find(
        (call) => call[1] === 'template_version.layout_updated',
      );
      expect(layoutLog?.[0]).toMatchObject({ templateVersionId: versionId });
      // Nunca logar o conteúdo do cabeçalho/rodapé.
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/organization\.name|Página/);
    });

    it('PATCH parcial muda só o enviado; FA-02 remove o logo; sem mudança = mesmo ETag e sem auditoria', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const first = await patchLayout(
        versionId,
        {
          logo: { attachmentId: brasaoId, position: 'right', maxHeightMm: 12 },
          marginsMm: { top: 30 },
        },
        etag,
      );
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(dataOf<TemplateVersionDto>(first).layout.marginsMm).toEqual({
        top: 30,
        right: 20,
        bottom: 20,
        left: 20,
      });

      const audits = auditOf('template.update').length;
      const same = await patchLayout(
        versionId,
        { marginsMm: { top: 30 } },
        String(first.headers.etag),
      );
      expect(same.status).toBe(200);
      expect(same.headers.etag).toBe(first.headers.etag);
      expect(auditOf('template.update')).toHaveLength(audits);

      const removed = await patchLayout(versionId, { logo: null }, String(first.headers.etag));
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(dataOf<TemplateVersionDto>(removed).layout.logo).toBeUndefined();
      expect(auditOf('template.update').at(-1)?.changes).toEqual([
        {
          path: 'layoutChangedFields',
          old: null,
          new: ['logo.attachmentId', 'logo.position', 'logo.maxHeightMm'],
        },
      ]);
    });

    it('gera a prévia: 202 com renditionId e, quando o worker conclui, PDF com "RASCUNHO", logo e variáveis resolvidas', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      await patchLayout(
        versionId,
        {
          header: doc('{{organization.name}} — {{process.code}}'),
          logo: { attachmentId: brasaoId, position: 'center' },
          draftWatermark: false,
        },
        etag,
      );
      const audits = api.auditRecords().length;
      const requests = renderer.requests.length;

      const renditionId = renditionIdOf(await requestPreview(versionId));
      expect(previewOf(await getPreview(versionId, renditionId))).toMatchObject({
        renditionId,
        templateVersionId: versionId,
        status: 'PENDING',
        pageCount: null,
      });
      expectProblem(await download(versionId, renditionId), 409, 'RENDITION_NOT_READY');
      const job = jobQueueOf(api).find('document-render', renditionId);
      expect(job).toMatchObject({
        name: 'template-preview',
        options: { priority: 1, attempts: 1 },
      });

      await runTemplatePreview(api, renditionId);

      const ready = previewOf(await getPreview(versionId, renditionId));
      expect(ready).toMatchObject({ status: 'READY', pageCount: 2, errorCode: null });
      expect(ready.expiresAt).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
      expect(renderer.requests).toHaveLength(requests + 1);
      const sent = renderer.requests.at(-1);
      // RN-TPL-25: marca d'água sempre, mesmo com `draftWatermark = false`.
      expect(sent?.indexHtml).toContain('RASCUNHO');
      expect(sent?.indexHtml).toContain(SECTION_PLACEHOLDER);
      expect(sent?.indexHtml).toContain(`Ao ${MARTA.name}`);
      expect(sent?.headerHtml).toContain('data:image/png;base64,');
      expect(sent?.headerHtml).toContain('text-align:center');
      expect(sent?.headerHtml).toContain('PROC 0001/2026');
      // RN-TPL-24: sem hash no rodapé da prévia de template.
      expect(sent?.footerHtml).not.toContain('Hash SHA-256');

      const object = [...storage.buckets.renditions.keys()].find((key) =>
        key.endsWith(`${renditionId}.pdf`),
      );
      expect(object).toBe(`tenants/${A}/template-previews/${versionId}/${renditionId}.pdf`);
      const link = await download(versionId, renditionId);
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      renditionDownloadSchema.parse(dataOf(link));
      // Prévia não gera auditoria nem documento.
      expect(api.auditRecords()).toHaveLength(audits);
    });

    it('FA-04 / RN-TPL-27: editar o layout depois da prévia exige nova prévia (a anterior segue disponível)', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const first = renditionIdOf(await requestPreview(versionId));
      await runTemplatePreview(api, first);
      const edited = await patchLayout(versionId, { fontFamily: 'Arial' }, etag);
      expect(edited.status).toBe(200);
      const second = renditionIdOf(await requestPreview(versionId));
      expect(second).not.toBe(first);
      expect(previewOf(await getPreview(versionId, first)).status).toBe('READY');
      await runTemplatePreview(api, second);
      expect(renderer.requests.at(-1)?.layout.fontFamily).toBe('Arial');
    });

    it('a prévia expira em 24 h (404 depois)', async () => {
      silence();
      const { versionId } = await newTemplate();
      const renditionId = renditionIdOf(await requestPreview(versionId));
      now = new Date(NOW.getTime() + 24 * 3_600_000 + 1_000);
      expectProblem(await getPreview(versionId, renditionId), 404, 'NOT_FOUND');
    });

    it('envia o logo como ativo do tenant (ATT-02, TENANT_ASSET) a partir do rascunho', async () => {
      silence();
      const { versionId } = await newTemplate();
      const response = await withAuth(request(api.server).post('/api/v1/attachments'), LUCIA)
        .set('Idempotency-Key', randomUUID())
        .send({
          targetType: 'TENANT_ASSET',
          targetId: versionId,
          fileName: 'brasao.png',
          declaredMimeType: 'image/png',
          sizeBytes: 2048,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = attachments.rows.get(dataOf<{ id: string }>(response).id);
      expect(created).toMatchObject({ targetType: 'TENANT_ASSET', processId: null });
      expect(created?.storageKey).toMatch(new RegExp(`^tenants/${A}/assets/`));
    });
  });

  describe('[Validação]', () => {
    it('variável desconhecida no rodapé: 422 TEMPLATE_INVALID e o layout não é salvo', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const problem = expectProblem(
        await patchLayout(versionId, { footer: doc('Assina: {{document.assinante}}') }, etag),
        422,
        'TEMPLATE_INVALID',
      );
      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'TEMPLATE_VARIABLE_UNKNOWN',
          field: 'layout.footer',
          params: { variable: 'document.assinante' },
          message: 'A variável {{document.assinante}} não é reconhecida.',
        }),
      ]);
      const reloaded = await getVersion(versionId);
      expect(reloaded.headers.etag).toBe(etag);
      expect(dataOf<TemplateVersionDto>(reloaded).layout.footer).toBeUndefined();
    });

    it.each([
      [
        { fontSizePt: 20 },
        'layout.fontSizePt',
        'OUT_OF_RANGE',
        'O tamanho da fonte deve estar entre 9 e 14.',
      ],
      [
        { marginsMm: { left: 5 } },
        'layout.marginsMm.left',
        'OUT_OF_RANGE',
        'A margem deve estar entre 10 e 40 mm.',
      ],
      [
        { lineHeight: 2.5 },
        'layout.lineHeight',
        'OUT_OF_RANGE',
        'A entrelinha deve estar entre 1,0 e 2,0.',
      ],
      [
        { logo: { attachmentId: newId(), position: 'top' } },
        'layout.logo.position',
        'INVALID_ENUM',
        'Selecione uma posição válida para o logo.',
      ],
      [{ pageSize: 'A3' }, 'layout.pageSize', 'INVALID_ENUM', 'O tamanho da página é fixo em A4.'],
    ])('%j fora da faixa: 422 VALIDATION_ERROR em %s', async (layout, field, code, message) => {
      silence();
      const { versionId, etag } = await newTemplate();
      const problem = expectProblem(
        await patchLayout(versionId, layout, etag),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toContainEqual({ field, code, message });
    });

    it('altura do logo acima da margem superior: 422 OUT_OF_RANGE (RN-TPL-23)', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const problem = expectProblem(
        await patchLayout(versionId, { logo: { attachmentId: brasaoId, maxHeightMm: 22 } }, etag),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'layout.logo.maxHeightMm', code: 'OUT_OF_RANGE' }),
      ]);
    });

    it('logo ainda em varredura: 409 ATTACHMENT_NOT_AVAILABLE; anexo de processo: REFERENCE_NOT_FOUND', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const scanning = await seedAsset(A, { status: 'SCANNING' });
      expectProblem(
        await patchLayout(versionId, { logo: { attachmentId: scanning } }, etag),
        409,
        'ATTACHMENT_NOT_AVAILABLE',
      );
      const ofProcess = await seedAsset(A, { targetType: 'PROCESS' });
      const problem = expectProblem(
        await patchLayout(versionId, { logo: { attachmentId: ofProcess } }, etag),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'layout.logo.attachmentId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
    });

    it('PATCH de layout em versão publicada: 409 TEMPLATE_VERSION_NOT_DRAFT; prévia com pendências: 422 TEMPLATE_INVALID', async () => {
      silence();
      const { template, versionId, etag } = await newTemplate();
      const published = await withAuth(
        request(api.server).post(`/api/v1/template-versions/${versionId}/publish`),
        MARTA,
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', etag)
        .send();
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      expectProblem(
        await patchLayout(versionId, { fontSizePt: 12 }, String(published.headers.etag)),
        409,
        'TEMPLATE_VERSION_NOT_DRAFT',
      );

      // V-08: versão com variável desconhecida no rodapé (gravada antes da regra) não gera prévia.
      const { versions } = templates.snapshot();
      const draft = versions.find((row) => row.id === versionId);
      if (!draft) throw new Error('versão inexistente');
      const brokenId = newId();
      templates.seed(
        [],
        [
          {
            ...draft,
            id: brokenId,
            status: 'DRAFT',
            versionNumber: 99,
            templateId: template.id,
            layout: { ...draft.layout, footer: doc('{{document.assinante}}') },
          },
        ],
      );
      const problem = expectProblem(await requestPreview(brokenId), 422, 'TEMPLATE_INVALID');
      expect(problem.violations[0]).toMatchObject({ field: 'layout.footer' });
    });
  });

  describe('[Permissão]', () => {
    it('só TEMPLATE_VIEW: PATCH de layout → 403 (access.denied); prévia da versão publicada → 202', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const denials = auditOf('access.denied').length;
      expectProblem(
        await patchLayout(versionId, { fontSizePt: 12 }, etag, ANA),
        403,
        'PERMISSION_DENIED',
      );
      expect(auditOf('access.denied')).toHaveLength(denials + 1);

      const published = await withAuth(
        request(api.server).post(`/api/v1/template-versions/${versionId}/publish`),
        MARTA,
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', etag)
        .send();
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      const renditionId = renditionIdOf(await requestPreview(versionId, ANA));
      await runTemplatePreview(api, renditionId);
      expect(previewOf(await getPreview(versionId, renditionId, ANA)).status).toBe('READY');
    });

    it('enviar logo exige ATTACHMENT_UPLOAD e TEMPLATE_MANAGE com o rascunho editável', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const intent = (user: User, targetId = versionId) =>
        withAuth(request(api.server).post('/api/v1/attachments'), user)
          .set('Idempotency-Key', randomUUID())
          .send({
            targetType: 'TENANT_ASSET',
            targetId,
            fileName: 'brasao.png',
            declaredMimeType: 'image/png',
            sizeBytes: 2048,
          });
      // Ana: só TEMPLATE_VIEW; Marta (ADM): TEMPLATE_MANAGE sem ATTACHMENT_UPLOAD.
      expectProblem(await intent(ANA), 403, 'PERMISSION_DENIED');
      expectProblem(await intent(MARTA), 403, 'PERMISSION_DENIED');
      expectProblem(await intent(LUCIA, newId()), 404, 'NOT_FOUND');
      const published = await withAuth(
        request(api.server).post(`/api/v1/template-versions/${versionId}/publish`),
        MARTA,
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', etag)
        .send();
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      expectProblem(await intent(LUCIA), 409, 'TEMPLATE_VERSION_NOT_DRAFT');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('logo de outro tenant: 422 REFERENCE_NOT_FOUND sem revelar que o anexo existe em B', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const response = await patchLayout(versionId, { logo: { attachmentId: logoOfB } }, etag);
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'layout.logo.attachmentId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione um logo válido.',
        },
      ]);
      // Mesma resposta de um id que não existe em lugar nenhum.
      const unknown = expectProblem(
        await patchLayout(versionId, { logo: { attachmentId: newId() } }, etag),
        422,
        'VALIDATION_ERROR',
      );
      expect(unknown.errors).toEqual(problem.errors);
      expect(JSON.stringify(response.body)).not.toMatch(/Prefeitura B|brasao/);
    });

    it('prévia e versão de outro tenant: 404', async () => {
      silence();
      const { versionId } = await newTemplate();
      const renditionId = renditionIdOf(await requestPreview(versionId));
      expectProblem(await requestPreview(versionId, HEITOR, B), 404, 'NOT_FOUND');
      expectProblem(await getPreview(versionId, renditionId, HEITOR, B), 404, 'NOT_FOUND');
      expectProblem(await getPreview(newId(), renditionId), 404, 'NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('cliques repetidos em "Gerar prévia": o mesmo renditionId em processamento e um só PDF', async () => {
      silence();
      const { versionId } = await newTemplate();
      const [first, second] = await Promise.all([
        requestPreview(versionId),
        requestPreview(versionId),
      ]);
      const id = renditionIdOf(first);
      expect(renditionIdOf(second)).toBe(id);
      expect(renditionIdOf(await requestPreview(versionId))).toBe(id);
      const queued = jobQueueOf(api)
        .all()
        .filter(
          (job) =>
            (job.data.payload as { templateVersionId?: string }).templateVersionId === versionId,
        );
      expect(queued).toHaveLength(1);

      const requests = renderer.requests.length;
      await runTemplatePreview(api, id);
      await runTemplatePreview(api, id);
      expect(renderer.requests).toHaveLength(requests + 1);
      // Concluída, um novo clique gera outra prévia.
      expect(renditionIdOf(await requestPreview(versionId))).not.toBe(id);
    });
  });

  describe('[Concorrência]', () => {
    it('edição simultânea do layout: o segundo PATCH com If-Match antigo → 412 VERSION_CONFLICT', async () => {
      silence();
      const { versionId, etag } = await newTemplate();
      const felipe = await patchLayout(versionId, { fontSizePt: 12 }, etag, MARTA);
      expect(felipe.status).toBe(200);
      const problem = expectProblem(
        await patchLayout(versionId, { fontSizePt: 13 }, etag, OTAVIO),
        412,
        'VERSION_CONFLICT',
      );
      expect(problem.currentVersion).toBe(Number(String(felipe.headers.etag).replaceAll('"', '')));
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao salvar o layout: 503 DEPENDENCY_UNAVAILABLE e nada alterado', async () => {
      silence();
      const failing: DocumentTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [
          { token: DOCUMENT_TRANSACTIONS, value: failing },
          { token: DOCUMENT_CLOCK, value: () => NOW },
        ],
      });
      try {
        const audits = down.auditRecords().length;
        const response = await request(down.server)
          .patch(`/api/v1/template-versions/${newId()}`)
          .set('Authorization', down.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .set('If-Match', '"2"')
          .send({ layout: { marginsMm: { top: 30 } } });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(down.auditRecords()).toHaveLength(audits);
      } finally {
        await down.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('Gotenberg indisponível: 202, a prévia termina FAILED (DEPENDENCY_UNAVAILABLE) e a nova tentativa funciona', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { versionId } = await newTemplate();
      renderer.failing = 'unavailable';
      const failedId = renditionIdOf(await requestPreview(versionId));
      await runTemplatePreview(api, failedId);
      expect(previewOf(await getPreview(versionId, failedId))).toMatchObject({
        status: 'FAILED',
        errorCode: 'DEPENDENCY_UNAVAILABLE',
        errorMessage: 'Não foi possível gerar a prévia agora. Tente novamente.',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'template_preview.gotenberg_unavailable' }),
        'template_preview.gotenberg_unavailable',
      );

      renderer.failing = null;
      const retryId = renditionIdOf(await requestPreview(versionId));
      expect(retryId).not.toBe(failedId);
      await runTemplatePreview(api, retryId);
      expect(previewOf(await getPreview(versionId, retryId)).status).toBe('READY');
    });

    it('fila indisponível: 202 e a prévia já nasce FAILED, sem prender a próxima tentativa', async () => {
      silence();
      const { versionId } = await newTemplate();
      jobQueueOf(api).down = true;
      const failedId = renditionIdOf(await requestPreview(versionId));
      expect(previewOf(await getPreview(versionId, failedId))).toMatchObject({
        status: 'FAILED',
        errorCode: 'DEPENDENCY_UNAVAILABLE',
      });
      jobQueueOf(api).down = false;
      expect(renditionIdOf(await requestPreview(versionId))).not.toBe(failedId);
    });
  });
});

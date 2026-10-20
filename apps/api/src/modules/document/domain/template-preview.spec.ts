import { DEFAULT_TEMPLATE_LAYOUT, documentSnapshotSchema } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { buildRenditionHtml, DRAFT_WATERMARK } from './rendition-html.js';
import {
  isPreviewExpired,
  isPreviewInProgress,
  PREVIEW_SAMPLE,
  previewFailed,
  previewReady,
  previewSnapshot,
  requestTemplatePreview,
  SECTION_PLACEHOLDER,
  startPreview,
} from './template-preview.js';

/* US-109 · RN-TPL-25..27: a prévia efêmera do template (estado e amostra do documento). */

const NOW = new Date('2026-10-17T12:00:00.000Z');
const ID = '0192d109-0000-7000-8000-0000000000b1';
const VERSION = '0192d109-0000-7000-8000-0000000000b2';
const TENANT = '0192d109-0000-7000-8000-0000000000b3';
const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const pending = () =>
  requestTemplatePreview({
    renditionId: ID,
    tenantId: TENANT,
    templateVersionId: VERSION,
    templateVersionRevision: 3,
    requestedById: null,
    now: NOW,
  });

describe('Prévia efêmera do template (US-109)', () => {
  it('nasce PENDING com validade de 24 h (RN-TPL-26)', () => {
    const preview = pending();
    expect(preview).toMatchObject({ status: 'PENDING', storageKey: null, errorCode: null });
    expect(preview.expiresAt.toISOString()).toBe('2026-10-18T12:00:00.000Z');
    expect(isPreviewInProgress(preview)).toBe(true);
    expect(isPreviewExpired(preview, new Date('2026-10-18T11:59:59.000Z'))).toBe(false);
    expect(isPreviewExpired(preview, new Date('2026-10-18T12:00:00.000Z'))).toBe(true);
  });

  it('PENDING → PROCESSING → READY; só a pendente é assumida', () => {
    const processing = startPreview(pending(), NOW);
    expect(processing?.status).toBe('PROCESSING');
    if (!processing) throw new Error('não assumida');
    expect(startPreview(processing, NOW)).toBeNull();
    const ready = previewReady(
      processing,
      { storageKey: 'k', sha256: 'a'.repeat(64), sizeBytes: 10, pageCount: 2 },
      NOW,
    );
    expect(ready).toMatchObject({ status: 'READY', pageCount: 2, readyAt: NOW });
    expect(isPreviewInProgress(ready)).toBe(false);
  });

  it('FA-03: a falha guarda o código e a mensagem sanitizada', () => {
    expect(previewFailed(pending(), 'DEPENDENCY_UNAVAILABLE')).toMatchObject({
      status: 'FAILED',
      errorCode: 'DEPENDENCY_UNAVAILABLE',
      errorMessage: 'Não foi possível gerar a prévia agora. Tente novamente.',
    });
  });

  it('RN-TPL-25: amostra com defaultContent ou o espaço reservado; HTML com "RASCUNHO" e sem hash', () => {
    const sections = [
      {
        key: 'OBJETO',
        title: 'Objeto',
        order: 1,
        requirement: 'REQUIRED' as const,
        defaultContent: doc('Contratação para {{organization.name}}'),
        maxChars: 50_000,
        render: 'TEXT' as const,
        allowNarrative: true,
      },
      {
        key: 'CORPO',
        title: 'Corpo',
        order: 2,
        requirement: 'OPTIONAL' as const,
        maxChars: 50_000,
        render: 'TEXT' as const,
        allowNarrative: true,
      },
    ];
    const snapshot = previewSnapshot({
      templateId: ID,
      templateVersionId: VERSION,
      templateName: 'Ofício padrão',
      documentType: { code: 'OFICIO', kind: 'FREE_TEXT', defaultConfidentiality: 'PUBLIC' },
      versionNumber: 3,
      sections,
      organizationName: 'Prefeitura de São José',
      organizationCnpj: '12345678000190',
      now: NOW,
    });
    expect(documentSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const html = buildRenditionHtml({
      kind: 'PREVIEW',
      snapshot,
      template: {
        sections,
        layout: { ...DEFAULT_TEMPLATE_LAYOUT, header: doc('{{process.code}} — {{page}}') },
      },
      contentHash: null,
      tenantName: 'Prefeitura de São José',
      requesterName: 'Marta',
      now: NOW,
      timeZone: 'America/Sao_Paulo',
      logo: {
        dataUri: 'data:image/png;base64,iVBORw0KGgo=',
        position: 'right',
        maxHeightMm: 12,
      },
    });
    expect(html.indexHtml).toContain(DRAFT_WATERMARK);
    expect(html.indexHtml).toContain('Contratação para Prefeitura de São José');
    expect(html.indexHtml).toContain(SECTION_PLACEHOLDER);
    expect(html.headerHtml).toContain(PREVIEW_SAMPLE.processCode);
    expect(html.headerHtml).toContain('<span class="pageNumber"></span>');
    expect(html.headerHtml).toContain('text-align:right');
    expect(html.headerHtml).toContain('max-height:12mm');
    expect(html.footerHtml).not.toContain('Hash SHA-256');
  });

  it('logo com URI fora do formato de imagem não entra no HTML', () => {
    const snapshot = previewSnapshot({
      templateId: ID,
      templateVersionId: VERSION,
      templateName: 'Ofício',
      documentType: { code: 'OFICIO', kind: 'FREE_TEXT', defaultConfidentiality: 'PUBLIC' },
      versionNumber: 1,
      sections: [],
      organizationName: null,
      organizationCnpj: null,
      now: NOW,
    });
    const html = buildRenditionHtml({
      kind: 'PREVIEW',
      snapshot,
      template: { sections: [], layout: DEFAULT_TEMPLATE_LAYOUT },
      contentHash: null,
      tenantName: null,
      requesterName: null,
      now: NOW,
      timeZone: 'America/Sao_Paulo',
      logo: { dataUri: 'javascript:alert(1)', position: 'left', maxHeightMm: 10 },
    });
    expect(html.headerHtml).toBeNull();
  });
});

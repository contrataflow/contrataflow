import { describe, expect, it } from 'vitest';

import {
  canClaim,
  classifyRendererStatus,
  downloadFileName,
  downloadRefusal,
  isInProgress,
  isReusable,
  markFailed,
  markReady,
  previewExpiresAt,
  RenditionTransitionError,
  requestPreview,
  requestVersionRendition,
  startProcessing,
} from './document-rendition.js';
import type { DocumentRendition } from './document-rendition.js';

const NOW = new Date('2026-10-17T13:00:00.000Z');
const base = {
  id: '0192f067-0000-7000-8000-000000000001',
  tenantId: '0192f067-0000-7000-8000-0000000000aa',
  processId: '0192f067-0000-7000-8000-0000000000bb',
  documentId: '0192f067-0000-7000-8000-0000000000cc',
  masked: false,
  requestedById: '0192f067-0000-7000-8000-0000000000dd',
  now: NOW,
};
const VERSION = '0192f067-0000-7000-8000-0000000000ee';
const PDF = { storageKey: 'tenants/x/a.pdf', sha256: 'a'.repeat(64), sizeBytes: 10, pageCount: 2 };

const preview = () => requestPreview({ ...base, draftRevision: 5 });
const content = () =>
  requestVersionRendition({
    ...base,
    documentVersionId: VERSION,
    kind: 'CONTENT',
    approvalId: 'ignorado',
  });

describe('DocumentRendition — fábricas (RN-DOC-63/68)', () => {
  it('prévia: PENDING, revisão do rascunho, sem versão, expira em 24 h', () => {
    const rendition = preview();
    expect(rendition).toMatchObject({
      kind: 'PREVIEW',
      status: 'PENDING',
      draftRevision: 5,
      documentVersionId: null,
      approvalId: null,
      attempts: 0,
      version: 1,
      requestedAt: NOW,
    });
    expect(rendition.expiresAt?.toISOString()).toBe('2026-10-18T13:00:00.000Z');
    expect(previewExpiresAt(NOW).getTime() - NOW.getTime()).toBe(24 * 3_600_000);
  });

  it('versão: CONTENT sem aprovação nem validade; selo guarda a aprovação', () => {
    expect(content()).toMatchObject({
      kind: 'CONTENT',
      documentVersionId: VERSION,
      draftRevision: null,
      approvalId: null,
      expiresAt: null,
    });
    const stamped = requestVersionRendition({
      ...base,
      documentVersionId: VERSION,
      kind: 'APPROVAL_STAMPED',
      approvalId: 'apr-1',
    });
    expect(stamped).toMatchObject({ kind: 'APPROVAL_STAMPED', approvalId: 'apr-1' });
  });
});

describe('DocumentRendition — trava condicional (RN-DOC-65)', () => {
  const LEASE = 60_000;

  it('assume PENDING; PROCESSING só de tentativa anterior ou com a trava vencida', () => {
    const pending = content();
    expect(canClaim(pending, 1, NOW, LEASE)).toBe(true);
    const claimed = startProcessing(pending, 1, NOW);
    expect(claimed).toMatchObject({
      status: 'PROCESSING',
      attempts: 1,
      startedAt: NOW,
      version: 2,
    });
    // Mesma tentativa entregue duas vezes: só uma assume.
    expect(canClaim(claimed, 1, NOW, LEASE)).toBe(false);
    // Próxima tentativa (falha transitória anterior) ou trava vencida (worker morto).
    expect(canClaim(claimed, 2, NOW, LEASE)).toBe(true);
    expect(canClaim(claimed, 1, new Date(NOW.getTime() + LEASE), LEASE)).toBe(true);
    // Trava devolvida (`startedAt` nulo): a mesma tentativa reassume.
    expect(canClaim({ ...claimed, startedAt: null }, 1, NOW, LEASE)).toBe(true);
    expect(startProcessing(claimed, 2, NOW).attempts).toBe(2);
  });

  it('estados finais nunca são reassumidos', () => {
    const ready = markReady(startProcessing(content(), 1, NOW), PDF, NOW);
    const failed = markFailed(content(), { errorCode: 'X', errorMessage: 'm' }, NOW);
    for (const done of [ready, failed, { ...ready, status: 'EXPIRED' as const }]) {
      expect(canClaim(done, 9, NOW, 0)).toBe(false);
      expect(isInProgress(done)).toBe(false);
    }
  });
});

describe('DocumentRendition — máquina de estados', () => {
  it('PROCESSING → READY grava o PDF e limpa o erro; PENDING → READY é recusado', () => {
    const ready = markReady(startProcessing(content(), 1, NOW), PDF, NOW);
    expect(ready).toMatchObject({ status: 'READY', ...PDF, readyAt: NOW, errorCode: null });
    expect(() => markReady(content(), PDF, NOW)).toThrow(RenditionTransitionError);
  });

  it('FAILED a partir de PENDING/PROCESSING; nunca de READY', () => {
    const failure = { errorCode: 'TEMPLATE_INVALID', errorMessage: 'layout' };
    expect(markFailed(startProcessing(content(), 1, NOW), failure, NOW)).toMatchObject({
      status: 'FAILED',
      errorCode: 'TEMPLATE_INVALID',
    });
    const ready = markReady(startProcessing(content(), 1, NOW), PDF, NOW);
    expect(() => markFailed(ready, failure, NOW)).toThrow(RenditionTransitionError);
    expect(() => startProcessing(ready, 2, NOW)).toThrow(RenditionTransitionError);
  });
});

describe('DocumentRendition — download (RN-DOC-68/69)', () => {
  const ready = (rendition: DocumentRendition) =>
    markReady(startProcessing(rendition, 1, NOW), PDF, NOW);

  it('só READY com PDF; prévia dentro da validade', () => {
    expect(downloadRefusal(content(), NOW)).toBe('NOT_READY');
    expect(downloadRefusal(startProcessing(content(), 1, NOW), NOW)).toBe('NOT_READY');
    expect(downloadRefusal(ready(content()), NOW)).toBeNull();
    expect(downloadRefusal(ready(preview()), NOW)).toBeNull();
    const expiry = previewExpiresAt(NOW);
    expect(downloadRefusal(ready(preview()), expiry)).toBe('EXPIRED');
    expect(downloadRefusal({ ...ready(preview()), status: 'EXPIRED' }, NOW)).toBe('EXPIRED');
    expect(downloadRefusal({ ...ready(content()), storageKey: null }, NOW)).toBe('NOT_READY');
  });

  it('reaproveitável enquanto não falhou nem expirou (FA-01)', () => {
    expect(isReusable(content())).toBe(true);
    expect(isReusable(ready(content()))).toBe(true);
    expect(isReusable(markFailed(content(), { errorCode: 'X', errorMessage: 'm' }, NOW))).toBe(
      false,
    );
    expect(isReusable({ ...content(), status: 'EXPIRED' })).toBe(false);
  });

  it('nome do arquivo: código do documento, versão e tipo', () => {
    expect(downloadFileName(content(), { code: 'ETP 0003/2026', versionNumber: 2 })).toBe(
      'ETP 0003-2026-v2.pdf',
    );
    expect(downloadFileName(preview(), { code: null, versionNumber: null })).toBe(
      'documento-previa.pdf',
    );
    expect(
      downloadFileName({ kind: 'APPROVAL_STAMPED' }, { code: 'TR 1/2026', versionNumber: 3 }),
    ).toBe('TR 1-2026-v3-aprovado.pdf');
  });
});

describe('classifyRendererStatus (RN-DOC-66)', () => {
  it('5xx, 429 e 408 transitórios; demais 4xx permanentes', () => {
    for (const status of [500, 502, 503, 504, 429, 408]) {
      expect(classifyRendererStatus(status)).toBe('TRANSIENT');
    }
    for (const status of [400, 404, 413, 422]) {
      expect(classifyRendererStatus(status)).toBe('PERMANENT');
    }
  });
});

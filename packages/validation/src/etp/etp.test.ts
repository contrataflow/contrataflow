import { describe, expect, it } from 'vitest';

import {
  etpCreateSchema,
  etpDocumentTitle,
  etpListMetaSchema,
  importableDfdSchema,
} from './etp.js';

describe('etpCreateSchema (ETP-02)', () => {
  it('aceita importFromDfd booleano ou ausente e recusa campos desconhecidos', () => {
    expect(etpCreateSchema.parse({})).toEqual({});
    expect(etpCreateSchema.parse({ importFromDfd: true })).toEqual({ importFromDfd: true });
    expect(etpCreateSchema.safeParse({ importFromDfd: 'sim' }).success).toBe(false);
    expect(etpCreateSchema.safeParse({ templateId: 'x' }).success).toBe(false);
  });
});

describe('etpDocumentTitle', () => {
  it('usa o código do processo quando houver', () => {
    expect(etpDocumentTitle('0012/2026')).toBe('Estudo Técnico Preliminar — 0012/2026');
    expect(etpDocumentTitle(null)).toBe('Estudo Técnico Preliminar');
    expect(etpDocumentTitle('')).toBe('Estudo Técnico Preliminar');
  });
});

describe('etpListMetaSchema (ETP-01)', () => {
  it('aceita o DFD elegível ou null; só FINALIZED/APPROVED', () => {
    const dfd = {
      documentId: '0192d019-0000-7000-8000-000000000001',
      code: 'DFD 0005/2026',
      status: 'FINALIZED',
      versionId: '0192d019-0000-7000-8000-000000000002',
      versionNumber: 1,
      objectSummary: 'Objeto',
      itemsCount: 2,
      pcaStatus: 'PLANNED',
    };
    expect(etpListMetaSchema.parse({ importableDfd: dfd })).toEqual({ importableDfd: dfd });
    expect(etpListMetaSchema.parse({ importableDfd: null })).toEqual({ importableDfd: null });
    expect(importableDfdSchema.safeParse({ ...dfd, status: 'DRAFT' }).success).toBe(false);
  });
});

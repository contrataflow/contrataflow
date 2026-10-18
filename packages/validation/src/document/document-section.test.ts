import { describe, expect, it } from 'vitest';

import {
  deriveSectionState,
  documentSectionSaveSchema,
  hasSectionText,
  sectionContentLength,
  sectionContentLimitProblem,
  sectionEtag,
  sectionRevisionOf,
} from './document-section.js';

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('DOC-05 — contrato e limites da seção (US-015)', () => {
  it('aceita as duas formas do corpo (notApplicable ou state) e recusa campos desconhecidos', () => {
    expect(
      documentSectionSaveSchema.safeParse({ content: doc('a'), notApplicable: false }).success,
    ).toBe(true);
    expect(
      documentSectionSaveSchema.safeParse({ content: null, state: 'NOT_APPLICABLE' }).success,
    ).toBe(true);
    expect(documentSectionSaveSchema.safeParse({ content: { type: 'p' } }).success).toBe(false);
    expect(documentSectionSaveSchema.safeParse({ content: null, extra: 1 }).success).toBe(false);
    expect(
      documentSectionSaveSchema.safeParse({ content: null, overwrittenRevision: 0 }).success,
    ).toBe(false);
  });

  it('ETag de seção: "s<revision>" ida e volta', () => {
    expect(sectionEtag(4)).toBe('"s4"');
    expect(sectionRevisionOf('"s4"')).toBe(4);
    expect(sectionRevisionOf('W/"s12"')).toBe(12);
    expect(sectionRevisionOf('"4"')).toBeNull();
    expect(sectionRevisionOf(null)).toBeNull();
  });

  it('estado derivado: FILLED com texto útil, EMPTY só com espaços, NOT_APPLICABLE pedido', () => {
    expect(hasSectionText(doc('  '))).toBe(false);
    expect(deriveSectionState({ content: doc('Algo'), notApplicable: false })).toBe('FILLED');
    expect(deriveSectionState({ content: doc(' '), notApplicable: false })).toBe('EMPTY');
    expect(deriveSectionState({ content: null, notApplicable: true })).toBe('NOT_APPLICABLE');
  });

  it('limites: caracteres do texto puro (maxChars) e 1 MB serializado', () => {
    expect(sectionContentLength(doc('ação'))).toBe(4);
    expect(sectionContentLimitProblem(doc('a'.repeat(50_000)))).toBeNull();
    expect(sectionContentLimitProblem(doc('a'.repeat(50_001)))).toEqual({
      kind: 'TOO_LONG',
      maxChars: 50_000,
    });
    expect(sectionContentLimitProblem(doc('a'.repeat(1024 * 1024)), 2_000_000)).toEqual({
      kind: 'PAYLOAD_TOO_LARGE',
    });
  });
});

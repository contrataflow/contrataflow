import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { inspectPdf } from './pdf-inspection.js';
import { fakePdf } from '../../../../test/support/rendition-fixtures.js';

describe('inspectPdf (RN-DOC-65)', () => {
  it('SHA-256, tamanho e páginas do PDF', () => {
    const bytes = fakePdf(3);
    expect(inspectPdf(bytes)).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      pageCount: 3,
    });
  });

  it('/Count da árvore vale mesmo com páginas em object streams', () => {
    const bytes = Buffer.from('%PDF-1.7\n2 0 obj << /Count 7 /Type /Pages >> endobj\n%%EOF');
    expect(inspectPdf(bytes)?.pageCount).toBe(7);
  });

  it('sem cabeçalho %PDF- ou sem página → inválido', () => {
    expect(inspectPdf(Buffer.from('<html>erro</html>'))).toBeNull();
    expect(inspectPdf(Buffer.from('%PDF-1.7\n%%EOF'))).toBeNull();
    expect(inspectPdf(Buffer.alloc(0))).toBeNull();
  });
});

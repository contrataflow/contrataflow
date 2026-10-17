import { createHash } from 'node:crypto';

/*
 * Conferência do PDF devolvido pelo conversor (US-067 · RN-DOC-65 · storage.md §10): SHA-256,
 * tamanho e número de páginas calculados sobre os bytes, antes de gravar. Sem cabeçalho `%PDF-` ou
 * sem página → `INVALID_PDF` (falha permanente — o mesmo HTML geraria o mesmo resultado).
 */

export interface PdfFacts {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
}

/** `null` = não é um PDF utilizável. */
export function inspectPdf(bytes: Buffer): PdfFacts | null {
  if (bytes.length < 8 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
  const text = bytes.toString('latin1');
  // Objetos de página (`/Type /Page`, nunca `/Pages`) e o `/Count` da árvore de páginas.
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  let declared = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) {
    declared = Math.max(declared, Number(match[1]));
  }
  for (const match of text.matchAll(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    declared = Math.max(declared, Number(match[1]));
  }
  const pageCount = Math.max(pages, declared);
  if (pageCount < 1) return null;
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    pageCount,
  };
}

import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_VERSION_MESSAGES,
  documentVersionCompareQuerySchema,
  documentVersionCreateSchema,
  documentVersionListQuerySchema,
} from './document-version.js';

/* US-066 — contratos de versões e comparação (api/03-documents.md DOC-15..18). */

const V1 = '0192f066-0000-7000-8000-0000000000a1';
const V2 = '0192f066-0000-7000-8000-0000000000a2';

describe('DOC-16 — salvar versão', () => {
  it('resumo opcional (sem corpo = sem resumo), aparado, até 500 caracteres (V-03)', () => {
    expect(documentVersionCreateSchema.parse(undefined)).toEqual({});
    expect(documentVersionCreateSchema.parse({ changeSummary: '  Ajuste  ' })).toEqual({
      changeSummary: 'Ajuste',
    });
    expect(documentVersionCreateSchema.safeParse({ changeSummary: 'x'.repeat(500) }).success).toBe(
      true,
    );
    const long = documentVersionCreateSchema.safeParse({ changeSummary: 'x'.repeat(600) });
    expect(long.success).toBe(false);
    expect(long.error?.issues[0]?.message).toBe(DOCUMENT_VERSION_MESSAGES.changeSummaryTooLong);
    expect(documentVersionCreateSchema.safeParse({ reason: 'MANUAL' }).success).toBe(false);
  });
});

describe('DOC-15/18 — listar e comparar', () => {
  it('lista com paginação padrão', () => {
    expect(documentVersionListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('comparar exige duas versões diferentes (V-05)', () => {
    expect(documentVersionCompareQuerySchema.parse({ from: V1, to: V2 })).toEqual({
      from: V1,
      to: V2,
    });
    const same = documentVersionCompareQuerySchema.safeParse({ from: V1, to: V1 });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]).toMatchObject({
      path: ['to'],
      message: DOCUMENT_VERSION_MESSAGES.sameVersion,
    });
    expect(documentVersionCompareQuerySchema.safeParse({ from: V1 }).success).toBe(false);
  });
});

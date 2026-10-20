import { describe, expect, it } from 'vitest';

import { processDocumentsQuerySchema } from './process-documents.js';

/* US-062 — filtros do DOC-01 (V-01/V-02 · RN-DOC-20). */

const TYPE = '0192d062-0000-7000-8000-000000000001';

describe('processDocumentsQuerySchema', () => {
  it('listas por vírgula ou repetição, sem repetidos; vazio = ausente', () => {
    expect(
      processDocumentsQuerySchema.parse({
        status: ['DRAFT,IN_REVIEW', 'DRAFT'],
        type: `${TYPE},${TYPE}`,
        q: '  etp ',
      }),
    ).toEqual({ status: ['DRAFT', 'IN_REVIEW'], type: [TYPE], q: 'etp' });
    expect(processDocumentsQuerySchema.parse({ status: '' })).toEqual({ status: undefined });
  });

  it('status fora do enum → issue no campo inteiro com INVALID_ENUM', () => {
    const result = processDocumentsQuerySchema.safeParse({ status: 'DRAFT,NAO_EXISTE' });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['status'],
        message: 'Filtro inválido.',
        params: { code: 'INVALID_ENUM' },
      }),
    ]);
  });

  it('type não-uuid, busca com 1 caractere e parâmetro desconhecido são recusados', () => {
    expect(processDocumentsQuerySchema.safeParse({ type: 'abc' }).success).toBe(false);
    expect(processDocumentsQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(processDocumentsQuerySchema.safeParse({ page: '1' }).success).toBe(false);
    expect(processDocumentsQuerySchema.safeParse({ responsibleId: 'x' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import { canApply, checkImportFile, classifyImportError } from './quotation-import-model';

/* US-028 — regras do diálogo "Importar planilha": conferência local e destino das recusas. */

const MESSAGES = { unavailable: 'indisponível', unexpected: 'inesperado' };
const MB = 1024 * 1024;

describe('checkImportFile (V-01/V-02)', () => {
  it('aceita .xlsx (qualquer caixa) dentro do limite; recusa outro tipo, vazio e grande', () => {
    expect(checkImportFile({ name: 'Cotacoes.XLSX', size: 10 })).toEqual({ ok: true });
    expect(checkImportFile({ name: 'cotacoes.xls', size: 10 })).toEqual({
      ok: false,
      message: 'Envie um arquivo .xlsx.',
    });
    expect(checkImportFile({ name: 'cotacoes.xlsx', size: 0 })).toMatchObject({ ok: false });
    expect(checkImportFile({ name: 'cotacoes.xlsx', size: 2 * MB }, 1)).toEqual({
      ok: false,
      message: 'O arquivo excede o tamanho máximo permitido.',
    });
  });
});

describe('classifyImportError', () => {
  const api = (
    status: number,
    code: string,
    extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
  ) => new ApiError({ status, code, ...extra });

  it('arquivo recusado, prévia vencida ou desconhecida e 422 → volta ao envio com a mensagem', () => {
    expect(classifyImportError(api(415, 'FILE_TYPE_NOT_ALLOWED'), MESSAGES)).toEqual({
      step: 'upload',
      message: 'Envie um arquivo .xlsx.',
    });
    expect(classifyImportError(api(413, 'PAYLOAD_TOO_LARGE'), MESSAGES)).toMatchObject({
      step: 'upload',
      message: 'O arquivo excede o tamanho máximo permitido.',
    });
    expect(classifyImportError(api(410, 'IMPORT_PREVIEW_EXPIRED'), MESSAGES)).toMatchObject({
      message: 'A prévia expirou. Envie a planilha novamente.',
    });
    expect(classifyImportError(api(404, 'NOT_FOUND'), MESSAGES)).toMatchObject({ step: 'upload' });
    expect(
      classifyImportError(
        api(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'file', code: 'REQUIRED', message: 'Sem a coluna Item.' }],
        }),
        MESSAGES,
      ),
    ).toEqual({ step: 'upload', message: 'Sem a coluna Item.' });
  });

  it('documento não editável/sem permissão fecham; indisponibilidade e o resto pedem nova tentativa', () => {
    expect(classifyImportError(api(409, 'DOCUMENT_NOT_EDITABLE'), MESSAGES)).toEqual({
      step: 'close',
      code: 'DOCUMENT_NOT_EDITABLE',
    });
    expect(classifyImportError(api(403, 'PERMISSION_DENIED'), MESSAGES)).toMatchObject({
      step: 'close',
    });
    expect(
      classifyImportError(api(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-1' }), MESSAGES),
    ).toEqual({ step: 'retry', message: 'indisponível', correlationId: 'c-1' });
    expect(classifyImportError(api(500, 'INTERNAL_ERROR'), MESSAGES)).toMatchObject({
      step: 'retry',
      message: 'inesperado',
    });
    expect(classifyImportError(new Error('x'), MESSAGES)).toEqual({
      step: 'retry',
      message: 'inesperado',
      correlationId: null,
    });
  });
});

describe('canApply (FA-04)', () => {
  it('só com ao menos uma célula válida', () => {
    const preview = (valid: number) => ({
      previewToken: 'x',
      expiresAt: '2026-10-06T15:15:00.000Z',
      fileName: 'a.xlsx',
      columns: [],
      rows: [],
      columnIssues: [],
      summary: { total: 1, valid, errors: 1 - valid, empty: 0, warnings: 0, rows: 1 },
    });
    expect(canApply(preview(1))).toBe(true);
    expect(canApply(preview(0))).toBe(false);
  });
});

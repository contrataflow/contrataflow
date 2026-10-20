import { describe, expect, it } from 'vitest';

import {
  BULK_ITEM_MESSAGES,
  bulkItemFailureOf,
  isUnavailable,
  notAttempted,
  summarizeBulk,
} from './task-bulk.js';

const P1 = '0192d058-0000-7000-8000-000000000001';
const P2 = '0192d058-0000-7000-8000-000000000002';

describe('Ações em lote — resultado por item (US-058 · RN-INBOX-22)', () => {
  it('processo de outro tenant/inexistente vira REFERENCE_NOT_FOUND sem revelar a existência', () => {
    expect(
      bulkItemFailureOf({ code: 'PROCESS_NOT_FOUND', status: 404, detail: 'Processo X' }),
    ).toEqual({ code: 'REFERENCE_NOT_FOUND', message: BULK_ITEM_MESSAGES.notFound });
  });

  it('recusa de regra mantém o código e a mensagem do PRC-21/PRC-22', () => {
    expect(
      bulkItemFailureOf({
        code: 'PROCESS_ALREADY_ASSIGNED',
        status: 409,
        detail: 'Este processo já foi assumido por Fábio Nunes.',
      }),
    ).toEqual({
      code: 'PROCESS_ALREADY_ASSIGNED',
      message: 'Este processo já foi assumido por Fábio Nunes.',
    });
  });

  it('VALIDATION_ERROR de item usa a mensagem do campo', () => {
    expect(
      bulkItemFailureOf({
        code: 'VALIDATION_ERROR',
        status: 422,
        detail: 'Dados inválidos.',
        fieldMessage: 'Selecione um responsável válido.',
      }),
    ).toEqual({ code: 'VALIDATION_ERROR', message: 'Selecione um responsável válido.' });
  });

  it('banco indisponível e falha inesperada', () => {
    const down = { code: 'DEPENDENCY_UNAVAILABLE', status: 503, detail: 'fora' };
    expect(bulkItemFailureOf(down)).toEqual({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: BULK_ITEM_MESSAGES.unavailable,
    });
    expect(isUnavailable(down)).toBe(true);
    expect(isUnavailable(null)).toBe(false);
    expect(bulkItemFailureOf(null)).toEqual({
      code: 'INTERNAL_ERROR',
      message: BULK_ITEM_MESSAGES.unexpected,
    });
    expect(bulkItemFailureOf({ code: 'INTERNAL_ERROR', status: 500, detail: 'stack' })).toEqual({
      code: 'INTERNAL_ERROR',
      message: BULK_ITEM_MESSAGES.unexpected,
    });
  });

  it('item não tentado depois da queda do banco', () => {
    expect(notAttempted(P1)).toEqual({
      processId: P1,
      ok: false,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: BULK_ITEM_MESSAGES.unavailable,
    });
  });

  it('agrega sucessos e erros do lote', () => {
    expect(
      summarizeBulk([
        { processId: P1, ok: true, process: {} },
        { processId: P2, ok: false, code: 'X', message: 'x' },
      ]),
    ).toEqual({ successCount: 1, errorCount: 1 });
    expect(summarizeBulk([])).toEqual({ successCount: 0, errorCount: 0 });
  });
});

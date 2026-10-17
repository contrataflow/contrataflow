import type { Violation } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import { lifecycleActionsOf } from './document-actions-bar';
import { describeDocumentError, endsFlow, sortViolations, warningCodes } from './document-errors';

/*
 * US-065 · "Casos de erro": como cada recusa da API vira desfecho na SCR-105, e a ordem/os códigos
 * das pendências. Funções puras, sem renderização.
 */

const PATH = '/processos/p1/documentos/d1';

const violation = (extra: Partial<Violation>): Violation => ({
  code: 'X',
  severity: 'BLOCKING',
  message: 'm',
  ruleId: null,
  sectionKey: null,
  field: null,
  itemId: null,
  params: {},
  ...extra,
});

function apiError(
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) {
  return new ApiError({ status, code, correlationId: 'c-1', ...extra });
}

describe('describeDocumentError', () => {
  it('412 e 428: conflito de versão', () => {
    expect(describeDocumentError(apiError(412, 'VERSION_CONFLICT'), PATH)).toEqual({
      kind: 'conflict',
    });
    expect(describeDocumentError(apiError(428, 'PRECONDITION_REQUIRED'), PATH)).toEqual({
      kind: 'conflict',
    });
  });

  it('409: estado inválido, com o detail do problem+json quando houver', () => {
    expect(describeDocumentError(apiError(409, 'INVALID_STATE'), PATH)).toEqual({
      kind: 'invalidState',
      detail: null,
    });
  });

  it('403: permissão/custódia', () => {
    expect(describeDocumentError(apiError(403, 'NOT_PROCESS_CUSTODIAN'), PATH).kind).toBe(
      'forbidden',
    );
    expect(describeDocumentError(apiError(403, 'PERMISSION_DENIED'), PATH).kind).toBe('forbidden');
  });

  it('403 de MFA vira redirecionamento ao step-up', () => {
    const outcome = describeDocumentError(apiError(403, 'MFA_REQUIRED'), PATH);
    expect(outcome.kind).toBe('redirect');
    expect(outcome.kind === 'redirect' && outcome.href).toContain('/api/auth/step-up');
  });

  it('422 de completude carrega as violations; outro 422, a mensagem do campo', () => {
    const violations = [violation({ code: 'A' })];
    expect(
      describeDocumentError(apiError(422, 'DOCUMENT_INCOMPLETE', { violations }), PATH),
    ).toEqual({
      kind: 'incomplete',
      code: 'DOCUMENT_INCOMPLETE',
      violations,
    });
    expect(
      describeDocumentError(apiError(422, 'WARNINGS_NOT_ACKNOWLEDGED', { violations }), PATH).kind,
    ).toBe('incomplete');
    expect(
      describeDocumentError(
        apiError(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'reopenReason', code: 'TOO_SHORT', message: 'Curta.' }],
        }),
        PATH,
      ),
    ).toEqual({ kind: 'field', message: 'Curta.' });
  });

  it('404, 503, 429 e sessão expirada', () => {
    expect(describeDocumentError(apiError(404, 'NOT_FOUND'), PATH).kind).toBe('notFound');
    expect(describeDocumentError(apiError(503, 'DEPENDENCY_UNAVAILABLE'), PATH).kind).toBe(
      'unavailable',
    );
    expect(
      describeDocumentError(apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 3 }), PATH).kind,
    ).toBe('rateLimited');
    expect(describeDocumentError(apiError(401, 'SESSION_EXPIRED'), PATH).kind).toBe('silent');
  });

  it('erro inesperado traz o correlationId; erro que não é da API, não', () => {
    expect(describeDocumentError(apiError(500, 'INTERNAL_ERROR'), PATH)).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(describeDocumentError(new Error('boom'), PATH)).toEqual({
      kind: 'unexpected',
      correlationId: null,
    });
  });
});

describe('endsFlow', () => {
  it('encerra o fluxo quando a causa não se corrige na tela', () => {
    expect(endsFlow({ kind: 'conflict' })).toBe(true);
    expect(endsFlow({ kind: 'invalidState', detail: null })).toBe(true);
    expect(endsFlow({ kind: 'forbidden', detail: null })).toBe(true);
    expect(endsFlow({ kind: 'notFound' })).toBe(true);
  });

  it('mantém o fluxo aberto quando o usuário pode corrigir ou tentar de novo', () => {
    expect(endsFlow({ kind: 'unavailable' })).toBe(false);
    expect(endsFlow({ kind: 'field', message: 'm' })).toBe(false);
    expect(endsFlow({ kind: 'unexpected', correlationId: null })).toBe(false);
    expect(endsFlow({ kind: 'rateLimited' })).toBe(false);
  });
});

describe('pendências', () => {
  it('bloqueantes antes dos avisos, preservando a ordem dentro de cada grupo', () => {
    const list = [
      violation({ code: 'W1', severity: 'WARNING' }),
      violation({ code: 'B1' }),
      violation({ code: 'W2', severity: 'WARNING' }),
      violation({ code: 'B2' }),
    ];
    expect(sortViolations(list).map((item) => item.code)).toEqual(['B1', 'B2', 'W1', 'W2']);
  });

  it('acknowledgedWarnings: só os códigos dos avisos, sem repetição', () => {
    const list = [
      violation({ code: 'B1' }),
      violation({ code: 'W1', severity: 'WARNING' }),
      violation({ code: 'W1', severity: 'WARNING', sectionKey: 'OUTRA' }),
      violation({ code: 'W2', severity: 'WARNING' }),
    ];
    expect(warningCodes(list)).toEqual(['W1', 'W2']);
  });
});

describe('lifecycleActionsOf', () => {
  it('ordem do ciclo de vida e sem UPDATE', () => {
    expect(
      lifecycleActionsOf(['DELETE', 'UPDATE', 'CANCEL', 'FINALIZE', 'REOPEN', 'SUBMIT']),
    ).toEqual(['FINALIZE', 'SUBMIT', 'REOPEN', 'CANCEL', 'DELETE']);
    expect(lifecycleActionsOf(['UPDATE'])).toEqual([]);
  });
});

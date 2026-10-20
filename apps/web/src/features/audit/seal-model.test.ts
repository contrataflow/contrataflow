import { AUDIT_SEAL_MESSAGES } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  classifyVerifyError,
  isoToLocalInput,
  localInputToIso,
  rangeOfSeals,
  sealStatusOf,
  validateRange,
  verificationIndex,
} from './seal-model';

const SP = 'America/Sao_Paulo';
const REQUIRED = { required: 'Informe a data e a hora.' };

describe('intervalo no fuso da instituição (US-074 · SCR-037)', () => {
  it('converte o relógio de parede de São Paulo (UTC−3) em ISO UTC e de volta', () => {
    expect(localInputToIso('2026-10-15T08:00', SP)).toBe('2026-10-15T11:00:00Z');
    expect(isoToLocalInput('2026-10-15T11:00:00Z', SP)).toBe('2026-10-15T08:00');
    expect(isoToLocalInput('2026-10-15T02:30:00Z', SP)).toBe('2026-10-14T23:30');
  });

  it('respeita o fuso de outra instituição (Manaus, UTC−4)', () => {
    expect(localInputToIso('2026-10-15T08:00', 'America/Manaus')).toBe('2026-10-15T12:00:00Z');
  });

  it('valor inválido não vira data', () => {
    expect(localInputToIso('ontem', SP)).toBeNull();
  });

  it('seleção de selos: menor início e maior fim', () => {
    expect(
      rangeOfSeals([
        { periodStart: '2026-10-15T13:00:00Z', periodEnd: '2026-10-15T14:00:00Z' },
        { periodStart: '2026-10-15T11:00:00Z', periodEnd: '2026-10-15T12:00:00Z' },
      ]),
    ).toEqual({ start: '2026-10-15T11:00:00Z', end: '2026-10-15T14:00:00Z' });
    expect(rangeOfSeals([])).toBeNull();
  });
});

describe('validação do intervalo com o schema da API (V-02)', () => {
  it('campos vazios são obrigatórios', () => {
    expect(validateRange({ start: '', end: '' }, SP, REQUIRED)).toEqual({
      ok: false,
      errors: { start: REQUIRED.required, end: REQUIRED.required },
    });
  });

  it('fim anterior ao início usa a mensagem compartilhada, no campo do fim', () => {
    expect(
      validateRange({ start: '2026-10-15T10:00', end: '2026-10-15T09:00' }, SP, REQUIRED),
    ).toEqual({ ok: false, errors: { end: AUDIT_SEAL_MESSAGES.periodRange } });
  });

  it('intervalo válido devolve o corpo de AUD-05 em ISO UTC', () => {
    expect(
      validateRange({ start: '2026-10-15T08:00', end: '2026-10-15T11:00' }, SP, REQUIRED),
    ).toEqual({
      ok: true,
      body: { periodStart: '2026-10-15T11:00:00Z', periodEnd: '2026-10-15T14:00:00Z' },
    });
  });
});

describe('status do selo combinado com a verificação', () => {
  const verification = {
    brokenAtPeriodStart: '2026-10-15T12:00:00Z',
    results: [
      {
        periodStart: '2026-10-15T11:00:00.000Z',
        periodEnd: '2026-10-15T12:00:00.000Z',
        recordCount: 3,
        status: 'VALID' as const,
      },
      {
        periodStart: '2026-10-15T12:00:00.000Z',
        periodEnd: '2026-10-15T13:00:00.000Z',
        recordCount: 2,
        status: 'INVALID' as const,
        brokenAt: 'digest' as const,
      },
    ],
  };

  it('"Não verificado" sem resultado; íntegro/quebrado para os selos cobertos', () => {
    const none = verificationIndex(null);
    const index = verificationIndex(verification);
    expect(sealStatusOf({ periodStart: '2026-10-15T11:00:00Z' }, none)).toBe('unverified');
    expect(sealStatusOf({ periodStart: '2026-10-15T11:00:00Z' }, index)).toBe('valid');
    expect(sealStatusOf({ periodStart: '2026-10-15T12:00:00Z' }, index)).toBe('broken');
    expect(sealStatusOf({ periodStart: '2026-10-15T13:00:00Z' }, index)).toBe('unverified');
  });
});

describe('classificação dos erros de AUD-05 (Casos de erro da US-074)', () => {
  const error = (status: number, code: string, message = '') =>
    new ApiError({
      status,
      code,
      correlationId: 'corr-1',
      errors: message ? [{ field: 'periodEnd', code: 'OUT_OF_RANGE', message }] : [],
    });

  it('422 usa a mensagem de errors[]; 404, 503 e MFA têm tratamento próprio', () => {
    const message = AUDIT_SEAL_MESSAGES.tooManyPeriods(720);
    expect(classifyVerifyError(error(422, 'VALIDATION_ERROR', message))).toEqual({
      kind: 'validation',
      message,
    });
    expect(classifyVerifyError(error(404, 'NOT_FOUND'))).toEqual({ kind: 'notFound' });
    expect(classifyVerifyError(error(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
      correlationId: 'corr-1',
    });
    expect(classifyVerifyError(error(403, 'MFA_REQUIRED'))).toEqual({ kind: 'mfa' });
    expect(classifyVerifyError(error(403, 'PERMISSION_DENIED'))).toEqual({ kind: 'forbidden' });
    expect(classifyVerifyError(new Error('x'))).toEqual({
      kind: 'unexpected',
      correlationId: null,
    });
  });
});

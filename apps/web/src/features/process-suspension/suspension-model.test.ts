import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  describeSuspensionError,
  extensionQuery,
  suspendedPeriod,
  validateResumeComment,
  validateSuspendReason,
} from './suspension-model';

const problem = (
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ status, code, detail: code, ...extra });

describe('suspension-model (US-008 · SCR-116)', () => {
  it('V-01: motivo de 20 a 5.000 caracteres', () => {
    expect(validateSuspendReason('Pausa')).toBe(
      'Informe o motivo da suspensão (mínimo de 20 caracteres).',
    );
    expect(validateSuspendReason('   ')).toBeDefined();
    expect(validateSuspendReason('Aguardando definição da dotação')).toBeUndefined();
    expect(validateSuspendReason('x'.repeat(5001))).toBe('O motivo pode ter até 5.000 caracteres.');
  });

  it('comentário da retomada é opcional, até 5.000', () => {
    expect(validateResumeComment('')).toBeUndefined();
    expect(validateResumeComment('x'.repeat(5001))).toBe(
      'O comentário pode ter até 5.000 caracteres.',
    );
  });

  it('período suspenso em datas locais do tenant', () => {
    expect(
      suspendedPeriod(
        '2026-10-06T13:00:00.000Z',
        new Date('2026-10-13T18:00:00Z'),
        'America/Sao_Paulo',
      ),
    ).toEqual({ from: '2026-10-06', to: '2026-10-13' });
  });

  it('prévia: mesmo dia = none (FA-04); corridos calculados localmente; úteis pelo CAL-05 até a véspera', () => {
    expect(extensionQuery({ from: '2026-10-06', to: '2026-10-06' }, 'BUSINESS')).toEqual({
      kind: 'none',
    });
    expect(extensionQuery({ from: '2026-10-06', to: '2026-10-13' }, 'CALENDAR')).toEqual({
      kind: 'calendar',
      days: 7,
    });
    expect(extensionQuery({ from: '2026-10-06', to: '2026-10-13' }, 'BUSINESS')).toEqual({
      kind: 'business',
      from: '2026-10-06',
      to: '2026-10-12',
    });
  });

  it('casos de erro da story', () => {
    expect(describeSuspensionError(problem(412, 'VERSION_CONFLICT'), 'reason')).toEqual({
      kind: 'stale',
    });
    expect(describeSuspensionError(problem(428, 'PRECONDITION_REQUIRED'), 'reason')).toEqual({
      kind: 'stale',
    });
    expect(describeSuspensionError(problem(409, 'INVALID_PROCESS_STATUS'), 'reason')).toEqual({
      kind: 'status',
    });
    expect(describeSuspensionError(problem(409, 'IDEMPOTENCY_IN_PROGRESS'), 'reason')).toEqual({
      kind: 'inProgress',
    });
    expect(describeSuspensionError(problem(422, 'IDEMPOTENCY_KEY_REUSED'), 'reason')).toEqual({
      kind: 'keyReused',
    });
    expect(describeSuspensionError(problem(403, 'TENANT_SUSPENDED'), 'reason')).toEqual({
      kind: 'access',
    });
    expect(describeSuspensionError(problem(403, 'PERMISSION_DENIED'), 'reason')).toEqual({
      kind: 'permission',
    });
    expect(describeSuspensionError(problem(404, 'PROCESS_NOT_FOUND'), 'reason')).toEqual({
      kind: 'notFound',
    });
    expect(describeSuspensionError(problem(503, 'DEPENDENCY_UNAVAILABLE'), 'reason')).toEqual({
      kind: 'unavailable',
    });
    expect(
      describeSuspensionError(
        problem(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'reason', code: 'TOO_SHORT', message: 'Curto demais.' }],
        }),
        'reason',
      ),
    ).toEqual({ kind: 'field', message: 'Curto demais.' });
    expect(describeSuspensionError(problem(422, 'VALIDATION_ERROR'), 'comment')).toEqual({
      kind: 'field',
      message: 'O comentário pode ter até 5.000 caracteres.',
    });
    expect(describeSuspensionError(new Error('x'), 'reason')).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
    expect(describeSuspensionError(problem(500, 'INTERNAL_ERROR'), 'reason')).toMatchObject({
      kind: 'unexpected',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { summaryDto } from '@test/support/process-fixtures';

import {
  cancellationImpact,
  describeCancellationError,
  validateCancellationReason,
  validateDiscardReason,
} from './cancellation-model';

const problem = (
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ status, code, detail: code, ...extra });

describe('cancellation-model (US-009 · SCR-116)', () => {
  it('V-01 · FA-04: justificativa com pelo menos 20 caracteres, sem contar as pontas', () => {
    expect(validateCancellationReason('Curta demais')).toBe(
      'A justificativa deve ter pelo menos 20 caracteres.',
    );
    expect(validateCancellationReason(`   ${'x'.repeat(19)}   `)).toBeDefined();
    expect(validateCancellationReason('Demanda já atendida por contrato vigente')).toBeUndefined();
    expect(validateCancellationReason('x'.repeat(5001))).toBe(
      'A justificativa pode ter até 5.000 caracteres.',
    );
  });

  it('motivo do descarte é opcional, até 500', () => {
    expect(validateDiscardReason('')).toBeUndefined();
    expect(validateDiscardReason('x'.repeat(501))).toBe('O motivo pode ter até 500 caracteres.');
  });

  it('FA-02: impactos a partir do painel (aprovações pendentes e documentos em aprovação)', () => {
    expect(cancellationImpact(undefined)).toEqual({ pendingApprovals: 0, documentsInApproval: 0 });
    const base = summaryDto();
    const [dfd, etp] = base.documents;
    const summary = summaryDto({
      approvals: [
        {
          id: '0192f009-0000-7000-8000-000000000001',
          title: 'Aprovação da autoridade',
          approverLabel: 'Roberto Lima',
          requestedAt: '2026-10-04T12:00:00.000Z',
          dueAt: null,
          isOverdue: false,
          isMine: false,
        },
      ],
      documents: [
        ...(dfd ? [{ ...dfd, inApproval: true }] : []),
        ...(etp ? [{ ...etp, inApproval: false }] : []),
      ],
    });
    expect(cancellationImpact(summary)).toEqual({ pendingApprovals: 1, documentsInApproval: 1 });
  });

  it('erros da API viram o comportamento da tabela "Casos de erro"', () => {
    expect(
      describeCancellationError(problem(412, 'VERSION_CONFLICT'), 'cancellationReason'),
    ).toEqual({ kind: 'stale' });
    expect(
      describeCancellationError(problem(428, 'PRECONDITION_REQUIRED'), 'cancellationReason').kind,
    ).toBe('stale');
    expect(
      describeCancellationError(problem(409, 'CANNOT_DISCARD_NUMBERED_PROCESS'), 'reason'),
    ).toEqual({ kind: 'numbered' });
    expect(
      describeCancellationError(problem(409, 'INVALID_PROCESS_STATUS'), 'cancellationReason'),
    ).toEqual({ kind: 'status' });
    expect(describeCancellationError(problem(403, 'TENANT_SUSPENDED'), 'reason').kind).toBe(
      'access',
    );
    expect(describeCancellationError(problem(403, 'PERMISSION_DENIED'), 'reason').kind).toBe(
      'permission',
    );
    expect(describeCancellationError(problem(404, 'PROCESS_NOT_FOUND'), 'reason').kind).toBe(
      'notFound',
    );
    expect(
      describeCancellationError(
        problem(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'cancellationReason', code: 'TOO_SHORT', message: 'Curta.' }],
        }),
        'cancellationReason',
      ),
    ).toEqual({ kind: 'field', message: 'Curta.' });
    expect(describeCancellationError(problem(422, 'VALIDATION_ERROR'), 'reason')).toEqual({
      kind: 'field',
      message: 'O motivo pode ter até 500 caracteres.',
    });
    expect(describeCancellationError(problem(503, 'DEPENDENCY_UNAVAILABLE'), 'reason').kind).toBe(
      'unavailable',
    );
    expect(
      describeCancellationError(problem(500, 'INTERNAL_ERROR', { correlationId: 'c-1' }), 'reason'),
    ).toEqual({ kind: 'unexpected', correlationId: 'c-1' });
    expect(describeCancellationError(new Error('x'), 'reason')).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  canReassign,
  canWithdraw,
  describePendingActionError,
  isClosingProblem,
  reassignBodyOf,
  validateReassign,
  withdrawBodyOf,
} from './pending-actions-model';

/* US-053 — regras puras das ações sobre a aprovação pendente (SCR-015). */

const DIEGO = '0192d053-0000-7000-8000-0000000000d1';
const SAUDE = '0192d053-0000-7000-8000-0000000000a4';
const LEAVE = 'Carla está de licença médica';

const meta = (allowedActions: ('DECIDE' | 'WITHDRAW' | 'REASSIGN')[]) => ({
  allowedActions,
  decisionOptions: [],
  decidesAsDeputy: false,
  decisionBlocker: null,
});

const apiError = (
  status: number,
  code: string,
  errors: { field: string; message: string }[] = [],
) =>
  new ApiError({
    status,
    code,
    detail: code,
    correlationId: 'corr-1',
    errors: errors.map((error) => ({ ...error, code: 'TOO_SHORT' })),
  });

describe('ações disponíveis (meta.allowedActions)', () => {
  it('retirar e redirecionar dependem da ação da API', () => {
    expect(canWithdraw(meta(['WITHDRAW']))).toBe(true);
    expect(canReassign(meta(['WITHDRAW']))).toBe(false);
    expect(canReassign(meta(['DECIDE', 'REASSIGN']))).toBe(true);
    expect(canWithdraw(meta([]))).toBe(false);
  });
});

describe('corpos do APV-04 e do APV-05', () => {
  it('retirada: motivo só quando informado', () => {
    expect(withdrawBodyOf('   ')).toEqual({});
    expect(withdrawBodyOf('  Enviado antes da hora. ')).toEqual({
      reason: 'Enviado antes da hora.',
    });
  });

  it('redirecionamento: o targetApprover* do tipo e o motivo aparado', () => {
    expect(reassignBodyOf({ approverType: 'USER', targetId: DIEGO, reason: ` ${LEAVE} ` })).toEqual(
      {
        approverType: 'USER',
        targetApproverUserId: DIEGO,
        reason: LEAVE,
      },
    );
    expect(
      reassignBodyOf({ approverType: 'DEPARTMENT_HEAD', targetId: SAUDE, reason: LEAVE }),
    ).toEqual({
      approverType: 'DEPARTMENT_HEAD',
      targetApproverDepartmentId: SAUDE,
      reason: LEAVE,
    });
  });
});

describe('validateReassign (V-01)', () => {
  it('exige o novo aprovador e o motivo com 10+ caracteres', () => {
    expect(validateReassign({ approverType: 'USER', targetId: null, reason: 'curto' })).toEqual({
      target: 'Selecione o novo aprovador.',
      reason: 'Informe o motivo do redirecionamento (mín. 10 caracteres).',
    });
    expect(validateReassign({ approverType: 'USER', targetId: DIEGO, reason: LEAVE })).toEqual({});
  });

  it('motivo acima de 2.000 caracteres', () => {
    expect(
      validateReassign({ approverType: 'USER', targetId: DIEGO, reason: 'x'.repeat(2001) }).reason,
    ).toBe('O motivo pode ter até 2.000 caracteres.');
  });
});

describe('describePendingActionError (Casos de erro)', () => {
  it.each([
    [409, 'APPROVAL_NOT_PENDING', 'notPending', true],
    [409, 'INVALID_PROCESS_STATUS', 'processStatus', true],
    [412, 'VERSION_CONFLICT', 'stale', true],
    [428, 'PRECONDITION_REQUIRED', 'precondition', true],
    [403, 'PERMISSION_DENIED', 'denied', true],
    [404, 'APPROVAL_NOT_FOUND', 'notFound', true],
    [403, 'SELF_APPROVAL_FORBIDDEN', 'selfApproval', false],
    [422, 'APPROVER_NOT_ELIGIBLE', 'notEligible', false],
    [422, 'IDEMPOTENCY_KEY_REUSED', 'idempotencyReused', false],
    [503, 'DEPENDENCY_UNAVAILABLE', 'unavailable', false],
  ] as const)('%i %s → %s (fecha: %s)', (status, code, kind, closing) => {
    const problem = describePendingActionError(apiError(status, code));
    expect(problem.kind).toBe(kind);
    expect(isClosingProblem(problem)).toBe(closing);
  });

  it('422 VALIDATION_ERROR vira mensagens por campo; 500 traz o código de correlação', () => {
    expect(
      describePendingActionError(
        apiError(422, 'VALIDATION_ERROR', [
          { field: 'reason', message: 'Informe o motivo.' },
          { field: 'targetApproverUserId', message: 'Selecione o novo aprovador.' },
        ]),
      ),
    ).toEqual({
      kind: 'fields',
      messages: { reason: 'Informe o motivo.', target: 'Selecione o novo aprovador.' },
    });
    expect(describePendingActionError(apiError(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'corr-1',
    });
    expect(describePendingActionError(new Error('rede'))).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });
});

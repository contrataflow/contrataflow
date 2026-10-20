import { describe, expect, it } from 'vitest';

import {
  APPROVAL_WITHDRAWAL_MESSAGES,
  reassignApprovalSchema,
  reassignIssues,
  withdrawApprovalSchema,
} from './approval-withdrawal.js';

/* US-053 — corpos do APV-04/DOC-11 e do APV-05 (V-01 · RN-TRAM-69: as mesmas regras na tela e na API). */

const DIEGO = '0192d053-0000-7000-8000-0000000000d1';
const ROLE = '0192d053-0000-7000-8000-0000000000e5';
const REASON = 'Carla está de licença médica';

describe('withdrawApprovalSchema (APV-04 · DOC-11)', () => {
  it('motivo opcional (corpo vazio vale)', () => {
    expect(withdrawApprovalSchema.parse(undefined)).toEqual({});
    expect(withdrawApprovalSchema.parse({ reason: 'Enviado antes da hora.' })).toEqual({
      reason: 'Enviado antes da hora.',
    });
  });

  it('até 2.000 caracteres; campo desconhecido recusado', () => {
    const tooLong = withdrawApprovalSchema.safeParse({ reason: 'x'.repeat(2001) });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toBe(APPROVAL_WITHDRAWAL_MESSAGES.reasonTooLong);
    expect(withdrawApprovalSchema.safeParse({ motivo: 'x' }).success).toBe(false);
  });
});

describe('reassignIssues (V-01 · RN-TRAM-69)', () => {
  it('motivo ausente ou com menos de 10 caracteres (sem os espaços das pontas)', () => {
    const base = { approverType: 'USER' as const, targetApproverUserId: DIEGO };
    expect(reassignIssues(base)).toEqual([
      {
        field: 'reason',
        code: 'REQUIRED',
        message: APPROVAL_WITHDRAWAL_MESSAGES.reassignReasonRequired,
      },
    ]);
    expect(reassignIssues({ ...base, reason: '   curto   ' })[0]?.code).toBe('TOO_SHORT');
    expect(reassignIssues({ ...base, reason: REASON })).toEqual([]);
  });

  it('exatamente o targetApprover* do approverType', () => {
    expect(reassignIssues({ approverType: 'ROLE', reason: REASON })).toEqual([
      {
        field: 'targetApproverRoleId',
        code: 'REQUIRED',
        message: APPROVAL_WITHDRAWAL_MESSAGES.targetRequired,
      },
    ]);
    expect(
      reassignIssues({
        approverType: 'USER',
        targetApproverUserId: DIEGO,
        targetApproverRoleId: ROLE,
        reason: REASON,
      }),
    ).toEqual([
      {
        field: 'targetApproverRoleId',
        code: 'NOT_ALLOWED',
        message: APPROVAL_WITHDRAWAL_MESSAGES.targetNotAllowed,
      },
    ]);
    expect(reassignIssues({ reason: REASON })[0]?.field).toBe('approverType');
  });
});

describe('reassignApprovalSchema (APV-05)', () => {
  it('aceita o novo aprovador do tipo e o motivo', () => {
    expect(
      reassignApprovalSchema.parse({
        approverType: 'USER',
        targetApproverUserId: DIEGO,
        reason: REASON,
      }),
    ).toEqual({ approverType: 'USER', targetApproverUserId: DIEGO, reason: REASON });
  });

  it('recusa sem motivo (campo reason, TOO_SHORT/REQUIRED) e sem o alvo', () => {
    const result = reassignApprovalSchema.safeParse({ approverType: 'DEPARTMENT_HEAD' });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(['reason', 'targetApproverDepartmentId']);
  });
});

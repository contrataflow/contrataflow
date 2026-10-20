import { describe, expect, it } from 'vitest';

import { ApprovalNotPendingError, recordOf } from './approval-decision.js';
import type { ApprovalRecord } from './approval-decision.js';
import {
  WITHDRAWN,
  approverConfigOfTarget,
  isSameApprover,
  reassignApproval,
  violatesSegregation,
  withdrawApproval,
} from './approval-withdrawal.js';
import type { Approval, ResolvedApprover } from './approval.js';

/*
 * US-053 — retirar ou redirecionar a aprovação pendente (RN-TRAM-65/66/69/70): o cancelamento pela
 * retirada, o alvo do redirecionamento como configuração da resolução (US-051), o "mesmo aprovador",
 * a segregação de funções do novo aprovador e a troca que preserva título, prazo e cobertura.
 */

const CARLA = '0192d053-0000-7000-8000-0000000000c1';
const DIEGO = '0192d053-0000-7000-8000-0000000000d1';
const ANA = '0192d053-0000-7000-8000-0000000000a1';
const ROLE = '0192d053-0000-7000-8000-0000000000e5';
const UNIT = '0192d053-0000-7000-8000-0000000000e4';
const OTHER_UNIT = '0192d053-0000-7000-8000-0000000000e6';
const NOW = new Date('2026-10-20T12:00:00.000Z');

const approval: Approval = {
  id: '0192d053-0000-7000-8000-0000000000f1',
  tenantId: '0192d053-0000-7000-8000-0000000000e1',
  processId: '0192d053-0000-7000-8000-0000000000e2',
  subjectType: 'PROCESS_STAGE',
  processStageId: '0192d053-0000-7000-8000-0000000000e3',
  documentId: null,
  title: 'Aprovação da autoridade competente — TR 0001/2026',
  requestedById: ANA,
  requestedAt: new Date('2026-10-19T12:00:00.000Z'),
  requestComment: null,
  approverType: 'USER',
  approverUserId: CARLA,
  approverRoleId: null,
  approverDepartmentId: null,
  allowDeputy: false,
  dueAt: new Date('2026-10-25T12:00:00.000Z'),
  status: 'PENDING',
  createdAt: new Date('2026-10-19T12:00:00.000Z'),
  createdById: ANA,
};

const record = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  ...recordOf(approval),
  ...overrides,
});

const user = (userId: string): ResolvedApprover => ({
  approverType: 'USER',
  approverUserId: userId,
  approverRoleId: null,
  approverDepartmentId: null,
  allowDeputy: false,
});

describe('withdrawApproval (RN-TRAM-65/66)', () => {
  it('cancela com data, autor e o motivo codificado WITHDRAWN; versão + 1', () => {
    const canceled = withdrawApproval(record(), { withdrawnById: ANA, now: NOW });
    expect(canceled).toMatchObject({
      status: 'CANCELED',
      canceledAt: NOW,
      canceledById: ANA,
      cancellationReason: WITHDRAWN,
      decision: null,
      updatedAt: NOW,
      version: 2,
    });
    expect(WITHDRAWN).toBe('WITHDRAWN');
  });

  it.each(['APPROVED', 'RETURNED', 'REJECTED', 'CANCELED'] as const)(
    'aprovação %s não é retirada (APPROVAL_NOT_PENDING)',
    (status) => {
      expect(() => withdrawApproval(record({ status }), { withdrawnById: ANA, now: NOW })).toThrow(
        ApprovalNotPendingError,
      );
    },
  );
});

describe('approverConfigOfTarget (RN-TRAM-69)', () => {
  it('USER e ROLE diretos; DEPARTMENT_HEAD pela unidade escolhida (FIXED)', () => {
    const target = {
      targetApproverUserId: DIEGO,
      targetApproverRoleId: ROLE,
      targetApproverDepartmentId: UNIT,
    };
    expect(approverConfigOfTarget({ ...target, approverType: 'USER' })).toEqual({
      approverType: 'USER',
      approverUserId: DIEGO,
      approverRoleId: null,
      approverDepartmentResolution: null,
      approverFixedDepartmentId: null,
    });
    expect(approverConfigOfTarget({ ...target, approverType: 'ROLE' })).toEqual({
      approverType: 'ROLE',
      approverUserId: null,
      approverRoleId: ROLE,
      approverDepartmentResolution: null,
      approverFixedDepartmentId: null,
    });
    expect(approverConfigOfTarget({ ...target, approverType: 'DEPARTMENT_HEAD' })).toEqual({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: null,
      approverRoleId: null,
      approverDepartmentResolution: 'FIXED',
      approverFixedDepartmentId: UNIT,
    });
  });
});

describe('isSameApprover (V-02)', () => {
  it('mesmo usuário, perfil ou unidade é o mesmo aprovador', () => {
    expect(isSameApprover(record(), user(CARLA))).toBe(true);
    expect(
      isSameApprover(record({ approverType: 'ROLE', approverUserId: null, approverRoleId: ROLE }), {
        ...user(CARLA),
        approverType: 'ROLE',
        approverUserId: null,
        approverRoleId: ROLE,
      }),
    ).toBe(true);
    const head = {
      approverType: 'DEPARTMENT_HEAD' as const,
      approverUserId: CARLA,
      approverRoleId: null,
      approverDepartmentId: UNIT,
      allowDeputy: true,
    };
    expect(isSameApprover(record(head), head)).toBe(true);
  });

  it('outro usuário, outro tipo ou outra unidade é diferente', () => {
    expect(isSameApprover(record(), user(DIEGO))).toBe(false);
    expect(
      isSameApprover(record(), {
        ...user(CARLA),
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentId: UNIT,
      }),
    ).toBe(false);
    const head = {
      approverType: 'DEPARTMENT_HEAD' as const,
      approverUserId: CARLA,
      approverRoleId: null,
      approverDepartmentId: UNIT,
      allowDeputy: true,
    };
    expect(isSameApprover(record(head), { ...head, approverDepartmentId: OTHER_UNIT })).toBe(false);
  });
});

describe('violatesSegregation (V-05 · RN-TRAM-62)', () => {
  it('autor de documento coberto não vira aprovador com preventSelfApproval', () => {
    expect(violatesSegregation(user(ANA), [ANA], true)).toBe(true);
    expect(violatesSegregation(user(ANA), [ANA], false)).toBe(false);
    expect(violatesSegregation(user(DIEGO), [ANA], true)).toBe(false);
  });

  it('o titular da unidade conta; o perfil não nomeia ninguém', () => {
    expect(
      violatesSegregation(
        { ...user(ANA), approverType: 'DEPARTMENT_HEAD', approverDepartmentId: UNIT },
        [ANA],
        true,
      ),
    ).toBe(true);
    expect(
      violatesSegregation(
        { ...user(ANA), approverType: 'ROLE', approverUserId: null, approverRoleId: ROLE },
        [ANA],
        true,
      ),
    ).toBe(false);
  });
});

describe('reassignApproval (RN-TRAM-70)', () => {
  it('troca só o aprovador; título, prazo, solicitante e status ficam; versão + 1', () => {
    const before = record();
    const after = reassignApproval(before, user(DIEGO), NOW);
    expect(after).toMatchObject({
      status: 'PENDING',
      approverType: 'USER',
      approverUserId: DIEGO,
      allowDeputy: false,
      title: before.title,
      dueAt: before.dueAt,
      requestedById: ANA,
      requestedAt: before.requestedAt,
      updatedAt: NOW,
      version: 2,
    });
  });

  it('para o titular de uma unidade: allowDeputy da resolução', () => {
    const after = reassignApproval(
      record(),
      {
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: DIEGO,
        approverRoleId: null,
        approverDepartmentId: UNIT,
        allowDeputy: true,
      },
      NOW,
    );
    expect(after).toMatchObject({
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentId: UNIT,
      allowDeputy: true,
    });
  });

  it('aprovação já decidida não é redirecionada', () => {
    expect(() => reassignApproval(record({ status: 'APPROVED' }), user(DIEGO), NOW)).toThrow(
      ApprovalNotPendingError,
    );
  });
});

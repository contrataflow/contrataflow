import { describe, expect, it } from 'vitest';

import {
  ApprovalNotPendingError,
  decideApproval,
  decisionBlockerOf,
  designationOf,
  isDecidableProcessStatus,
  isSelfApproval,
  recordOf,
} from './approval-decision.js';
import type { ApprovalRecord, Designation } from './approval-decision.js';
import type { Approval } from './approval.js';

/*
 * US-052 — decisão da aprovação (RN-TRAM-54/55/62/63 · POL-03): o registro da decisão, a
 * designação de quem decide (titular, substituto, detentor do perfil, usuário), a segregação de
 * funções e o motivo de não poder decidir (SCR-015).
 */

const CARLA = '0192d052-0000-7000-8000-0000000000c1';
const DIEGO = '0192d052-0000-7000-8000-0000000000d1';
const BRUNO = '0192d052-0000-7000-8000-0000000000b1';
const ANA = '0192d052-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-19T12:00:00.000Z');

const approval: Approval = {
  id: '0192d052-0000-7000-8000-0000000000f1',
  tenantId: '0192d052-0000-7000-8000-0000000000e1',
  processId: '0192d052-0000-7000-8000-0000000000e2',
  subjectType: 'PROCESS_STAGE',
  processStageId: '0192d052-0000-7000-8000-0000000000e3',
  documentId: null,
  title: 'Aprovação da autoridade competente — TR 0001/2026',
  requestedById: ANA,
  requestedAt: new Date('2026-10-18T12:00:00.000Z'),
  requestComment: null,
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: CARLA,
  approverRoleId: null,
  approverDepartmentId: '0192d052-0000-7000-8000-0000000000e4',
  allowDeputy: true,
  dueAt: null,
  status: 'PENDING',
  createdAt: new Date('2026-10-18T12:00:00.000Z'),
  createdById: ANA,
};

const record = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  ...recordOf(approval),
  ...overrides,
});
const facts = (userId: string, overrides: Partial<Parameters<typeof designationOf>[1]> = {}) => ({
  userId,
  roleHolderIds: [],
  unit: { headUserId: CARLA, deputyUserId: DIEGO },
  ...overrides,
});

describe('recordOf / decideApproval (RN-TRAM-54/63)', () => {
  it('a aprovação recém-aberta vira registro sem decisão, versão 1', () => {
    expect(recordOf(approval)).toMatchObject({
      decision: null,
      decidedById: null,
      decidedAt: null,
      decisionComment: null,
      decidedAsDeputy: false,
      updatedAt: approval.createdAt,
      version: 1,
    });
  });

  it.each([
    ['APPROVE', 'APPROVED'],
    ['RETURN', 'RETURNED'],
    ['REJECT', 'REJECTED'],
  ] as const)(
    '%s → %s, com decisor, data, comentário, substituto e versão + 1',
    (decision, status) => {
      const decided = decideApproval(record(), {
        decision,
        comment: 'Ajustar a estimativa de quantidades.',
        decidedById: DIEGO,
        asDeputy: true,
        now: NOW,
      });
      expect(decided).toMatchObject({
        status,
        decision,
        decidedById: DIEGO,
        decidedAt: NOW,
        decisionComment: 'Ajustar a estimativa de quantidades.',
        decidedAsDeputy: true,
        updatedAt: NOW,
        version: 2,
      });
    },
  );

  it.each(['APPROVED', 'RETURNED', 'REJECTED', 'CANCELED'] as const)(
    'aprovação %s não é decidida de novo (APPROVAL_NOT_PENDING)',
    (status) => {
      expect(() =>
        decideApproval(record({ status }), {
          decision: 'APPROVE',
          comment: null,
          decidedById: CARLA,
          asDeputy: false,
          now: NOW,
        }),
      ).toThrow(ApprovalNotPendingError);
    },
  );
});

describe('designationOf (POL-03 · DEC-022)', () => {
  const designated = (asDeputy = false): Designation => ({ designated: true, asDeputy });
  const none: Designation = { designated: false, asDeputy: false };

  it('USER: só o aprovador registrado', () => {
    const user = { ...approval, approverType: 'USER' as const, allowDeputy: false };
    expect(designationOf(user, facts(CARLA))).toEqual(designated());
    expect(designationOf(user, facts(BRUNO))).toEqual(none);
  });

  it('ROLE: detentor competente no escopo da unidade solicitante (o primeiro a confirmar vence)', () => {
    const role = { ...approval, approverType: 'ROLE' as const, approverUserId: null };
    expect(designationOf(role, facts(BRUNO, { roleHolderIds: [BRUNO, CARLA] }))).toEqual(
      designated(),
    );
    expect(designationOf(role, facts(ANA, { roleHolderIds: [BRUNO] }))).toEqual(none);
  });

  it('DEPARTMENT_HEAD: o titular ATUAL; o substituto só com allowDeputy (FA-02)', () => {
    expect(designationOf(approval, facts(CARLA))).toEqual(designated());
    expect(designationOf(approval, facts(DIEGO))).toEqual(designated(true));
    expect(designationOf({ ...approval, allowDeputy: false }, facts(DIEGO))).toEqual(none);
    expect(designationOf(approval, facts(BRUNO))).toEqual(none);
    // Titular trocado depois da solicitação: decide o novo titular.
    expect(
      designationOf(approval, facts(BRUNO, { unit: { headUserId: BRUNO, deputyUserId: null } })),
    ).toEqual(designated());
    expect(designationOf(approval, facts(CARLA, { unit: null }))).toEqual(none);
  });
});

describe('segregação de funções e status do processo', () => {
  it('RN-TRAM-62: autor de documento coberto ou da versão analisada não decide com a política ligada', () => {
    expect(isSelfApproval([ANA, CARLA], CARLA, true)).toBe(true);
    expect(isSelfApproval([ANA, CARLA], CARLA, false)).toBe(false);
    expect(isSelfApproval([ANA], CARLA, true)).toBe(false);
  });

  it.each([
    ['IN_PROGRESS', true],
    ['AWAITING_APPROVAL', true],
    ['RETURNED', true],
    ['DRAFT', true],
    ['SUSPENDED', false],
    ['CANCELED', false],
    ['COMPLETED', false],
    ['PUBLISHED', false],
  ] as const)('processo %s decidível? %s', (status, decidable) => {
    expect(isDecidableProcessStatus(status)).toBe(decidable);
  });

  it('decisionBlockerOf: o primeiro motivo na ordem das checagens do APV-03', () => {
    const base = {
      status: 'PENDING' as const,
      canDecide: true,
      designation: { designated: true, asDeputy: false },
      selfApproval: false,
      processStatus: 'AWAITING_APPROVAL' as const,
    };
    expect(decisionBlockerOf(base)).toBeNull();
    expect(decisionBlockerOf({ ...base, status: 'APPROVED', canDecide: false })).toBe(
      'NOT_PENDING',
    );
    expect(decisionBlockerOf({ ...base, canDecide: false, selfApproval: true })).toBe(
      'PERMISSION_DENIED',
    );
    expect(
      decisionBlockerOf({
        ...base,
        designation: { designated: false, asDeputy: false },
        selfApproval: true,
      }),
    ).toBe('NOT_DESIGNATED_APPROVER');
    expect(decisionBlockerOf({ ...base, selfApproval: true, processStatus: 'SUSPENDED' })).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    expect(decisionBlockerOf({ ...base, processStatus: 'SUSPENDED' })).toBe(
      'INVALID_PROCESS_STATUS',
    );
  });
});

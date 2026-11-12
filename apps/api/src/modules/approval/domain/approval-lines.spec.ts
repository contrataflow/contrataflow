import { composeApproverLabel } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { recordOf } from './approval-decision.js';
import type { ApprovalRecord } from './approval-decision.js';
import {
  ApprovalConfigInvalidError,
  approvalConfigOf,
  assertDistinctApprovers,
  backfillLineOf,
  DuplicatedApproverError,
  guardSelfApproval,
  lineAfterReassignment,
  linesAfterCancellation,
  mirroredLineOf,
  openApprovalLines,
  SelfApprovalAtRequestError,
  segregationAppliesAtRequest,
} from './approval-lines.js';
import type { ApprovalApprover, ResolvedApprovalLine } from './approval-lines.js';
import type { Approval } from './approval.js';

/*
 * US-133 — regras puras da aprovação múltipla na solicitação: configuração copiada (RN-APV-16/17,
 * V-06/V-07), estado inicial por política (RN-APV-18), segregação por linha (RN-APV-20), pessoa
 * única (RN-APV-21), espelho (RN-APV-24), backfill (RN-APV-30) e a sincronização provisória com as
 * ações do MVP 1.
 */

const id = (n: number) => `0192f133-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ROBERTO = id(1);
const HELENA = id(2);
const MARCOS = id(3);
const ANA = id(4);
const SECRETARIA = id(10);
const OUTRA = id(11);
const ROLE = id(20);
const APPROVAL = id(30);
const NOW = new Date('2026-11-11T12:00:00.000Z');

const head = (
  sequence: number,
  userId = ROBERTO,
  departmentId = SECRETARIA,
): ResolvedApprovalLine => ({
  sequence,
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: userId,
  approverRoleId: null,
  approverDepartmentId: departmentId,
  allowDeputy: true,
  configuredLabel: null,
});
const user = (sequence: number, userId: string): ResolvedApprovalLine => ({
  sequence,
  approverType: 'USER',
  approverUserId: userId,
  approverRoleId: null,
  approverDepartmentId: null,
  allowDeputy: false,
  configuredLabel: null,
});
const role = (sequence: number): ResolvedApprovalLine => ({
  sequence,
  approverType: 'ROLE',
  approverUserId: null,
  approverRoleId: ROLE,
  approverDepartmentId: null,
  allowDeputy: false,
  configuredLabel: null,
});

let counter = 100;
const stamp = { requestedAt: NOW, requestedById: ANA, newId: () => id((counter += 1)) };
const facts = (authors: readonly string[], deputy: string | null = HELENA) => ({
  preventSelfApproval: true,
  authorIds: new Set(authors),
  deputies: new Map([[SECRETARIA, deputy]]),
});

const approval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => {
  const base: Approval = {
    id: APPROVAL,
    tenantId: id(40),
    processId: id(41),
    subjectType: 'PROCESS_STAGE',
    processStageId: id(42),
    documentId: null,
    title: 'Aprovação da autorização',
    requestedById: ANA,
    requestedAt: NOW,
    requestComment: null,
    approverType: 'DEPARTMENT_HEAD',
    approverUserId: ROBERTO,
    approverRoleId: null,
    approverDepartmentId: SECRETARIA,
    allowDeputy: true,
    dueAt: null,
    status: 'PENDING',
    createdAt: NOW,
    createdById: ANA,
  };
  return { ...recordOf(base), ...overrides };
};

describe('approvalConfigOf (RN-APV-16/17 · V-06/V-07)', () => {
  const single = {
    approverType: 'DEPARTMENT_HEAD' as const,
    approverDepartmentResolution: 'REQUESTING_SECRETARIAT' as const,
  };

  it('sem lista: uma linha sequence 1 com o aprovador único do MVP 1 (ANY)', () => {
    expect(approvalConfigOf(single)).toEqual({
      decisionPolicy: 'ANY',
      listed: false,
      lines: [
        {
          sequence: 1,
          approverType: 'DEPARTMENT_HEAD',
          approverUserId: null,
          approverRoleId: null,
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          approverFixedDepartmentId: null,
          label: null,
        },
      ],
    });
  });

  it('com lista: ordem por sequence (snapshot) ou pela posição (tipo de documento), renumerada 1..n', () => {
    const config = approvalConfigOf({
      ...single,
      decisionPolicy: 'SEQUENTIAL',
      approvers: [
        { sequence: 2, approverType: 'USER', approverUserId: MARCOS, label: 'Prefeito' },
        { sequence: 1, ...single },
      ],
    });
    expect(config.listed).toBe(true);
    expect(config.lines.map((line) => [line.sequence, line.approverType, line.label])).toEqual([
      [1, 'DEPARTMENT_HEAD', null],
      [2, 'USER', 'Prefeito'],
    ]);
    const byPosition = approvalConfigOf({
      ...single,
      decisionPolicy: 'ALL',
      approvers: [
        { approverType: 'USER', approverUserId: MARCOS },
        { approverType: 'ROLE', approverRoleId: ROLE },
      ],
    });
    expect(byPosition.lines.map((line) => [line.sequence, line.approverType])).toEqual([
      [1, 'USER'],
      [2, 'ROLE'],
    ]);
  });

  it('V-06: política ≠ ANY sem lista ou com uma linha; V-07: mais de 20 linhas', () => {
    expect(() => approvalConfigOf({ ...single, decisionPolicy: 'ALL' })).toThrow(
      expect.objectContaining({ reason: 'POLICY_INVALID' }) as unknown,
    );
    expect(() =>
      approvalConfigOf({
        ...single,
        decisionPolicy: 'SEQUENTIAL',
        approvers: [{ approverType: 'USER', approverUserId: MARCOS }],
      }),
    ).toThrow(ApprovalConfigInvalidError);
    const many = Array.from({ length: 21 }, (_, index) => ({
      approverType: 'USER' as const,
      approverUserId: id(200 + index),
    }));
    expect(() => approvalConfigOf({ ...single, approvers: many })).toThrow(
      expect.objectContaining({ reason: 'LIMIT_EXCEEDED' }) as unknown,
    );
    // ANY com uma linha listada é válido (RN-APV-03).
    expect(
      approvalConfigOf({ ...single, approvers: [{ approverType: 'USER', approverUserId: MARCOS }] })
        .lines,
    ).toHaveLength(1);
  });
});

describe('openApprovalLines (RN-APV-18)', () => {
  it('ANY e ALL: todas PENDING com activatedAt = requestedAt; SEQUENTIAL: só a primeira, as demais WAITING', () => {
    for (const policy of ['ANY', 'ALL'] as const) {
      const lines = openApprovalLines(
        APPROVAL,
        policy,
        guardSelfApproval(policy, [head(1), user(2, MARCOS)], facts([])),
        stamp,
      );
      expect(lines.map((line) => [line.status, line.activatedAt])).toEqual([
        ['PENDING', NOW],
        ['PENDING', NOW],
      ]);
    }
    const sequential = openApprovalLines(
      APPROVAL,
      'SEQUENTIAL',
      guardSelfApproval('SEQUENTIAL', [user(2, MARCOS), head(1), role(3)], facts([])),
      stamp,
    );
    expect(sequential.map((line) => [line.sequence, line.status, line.activatedAt])).toEqual([
      [1, 'PENDING', NOW],
      [2, 'WAITING', null],
      [3, 'WAITING', null],
    ]);
    expect(sequential.every((line) => line.dueAt === null && line.createdById === ANA)).toBe(true);
    expect(new Set(sequential.map((line) => line.id)).size).toBe(3);
  });
});

describe('SelfApprovalGuard (RN-APV-20)', () => {
  it('vale em ALL/SEQUENTIAL ou com mais de uma linha; ANY com linha única mantém o MVP 1', () => {
    expect(segregationAppliesAtRequest('ANY', 1)).toBe(false);
    expect(segregationAppliesAtRequest('ANY', 2)).toBe(true);
    expect(segregationAppliesAtRequest('ALL', 2)).toBe(true);
    expect(segregationAppliesAtRequest('SEQUENTIAL', 2)).toBe(true);
    expect(guardSelfApproval('ANY', [head(1)], facts([ROBERTO]))).toEqual([
      { ...head(1), selfApprovalAvoided: false },
    ]);
  });

  it('titular autor → substituto (allowDeputy falso, selfApprovalAvoided); sem preventSelfApproval nada muda', () => {
    expect(guardSelfApproval('ALL', [head(1), user(2, MARCOS)], facts([ROBERTO]))).toEqual([
      { ...head(1), approverUserId: HELENA, allowDeputy: false, selfApprovalAvoided: true },
      { ...user(2, MARCOS), selfApprovalAvoided: false },
    ]);
    expect(
      guardSelfApproval('ALL', [head(1), user(2, MARCOS)], {
        ...facts([ROBERTO, MARCOS]),
        preventSelfApproval: false,
      })[0]?.approverUserId,
    ).toBe(ROBERTO);
  });

  it('USER autor, titular sem substituto ou substituto também autor → SelfApprovalAtRequestError(sequence); ROLE nunca', () => {
    const error = (run: () => unknown) => {
      try {
        run();
      } catch (caught) {
        return caught;
      }
      return null;
    };
    expect(
      error(() => guardSelfApproval('SEQUENTIAL', [head(1), user(2, MARCOS)], facts([MARCOS]))),
    ).toEqual(new SelfApprovalAtRequestError(2));
    expect(
      error(() => guardSelfApproval('ALL', [head(1), user(2, MARCOS)], facts([ROBERTO], null))),
    ).toMatchObject({
      sequence: 1,
    });
    expect(
      error(() => guardSelfApproval('ALL', [head(1), user(2, MARCOS)], facts([ROBERTO, HELENA]))),
    ).toMatchObject({ sequence: 1 });
    expect(guardSelfApproval('ALL', [role(1), user(2, MARCOS)], facts([ANA]))).toHaveLength(2);
  });
});

describe('DistinctApproversPolicy (RN-APV-21)', () => {
  it('mesma pessoa em duas linhas (titular de duas unidades, usuário = titular, substituto repetido) → DuplicatedApproverError(n, m)', () => {
    expect(() => {
      assertDistinctApprovers([head(1), head(2, ROBERTO, OUTRA)]);
    }).toThrow(new DuplicatedApproverError(1, 2));
    expect(() => {
      assertDistinctApprovers([user(3, ROBERTO), head(1)]);
    }).toThrow(expect.objectContaining({ first: 1, second: 3 }) as unknown);
    const diverted = guardSelfApproval('ALL', [head(1), user(2, HELENA)], facts([ROBERTO]));
    expect(() => {
      assertDistinctApprovers(diverted);
    }).toThrow(DuplicatedApproverError);
  });

  it('perfis não entram na comparação; pessoas distintas passam', () => {
    expect(() => {
      assertDistinctApprovers([role(1), role(2), user(3, MARCOS), head(4)]);
    }).not.toThrow();
  });
});

describe('espelho e rótulo composto (RN-APV-24/28)', () => {
  const lines = openApprovalLines(
    APPROVAL,
    'SEQUENTIAL',
    guardSelfApproval('SEQUENTIAL', [head(1), user(2, MARCOS)], facts([])),
    stamp,
  );

  it('SEQUENTIAL espelha a corrente (primeira PENDING); ANY/ALL a primeira', () => {
    expect(mirroredLineOf('SEQUENTIAL', lines)?.sequence).toBe(1);
    const advanced = lines.map((line): ApprovalApprover =>
      line.sequence === 1
        ? { ...line, status: 'APPROVED', decision: 'APPROVE', decidedAt: NOW }
        : { ...line, status: 'PENDING', activatedAt: NOW },
    );
    expect(mirroredLineOf('SEQUENTIAL', advanced)?.sequence).toBe(2);
    expect(mirroredLineOf('ALL', advanced)?.sequence).toBe(1);
    expect(mirroredLineOf('ANY', [])).toBeNull();
  });

  it('"A ou B", "A e B", "A, depois B"; uma linha = o próprio rótulo', () => {
    expect(composeApproverLabel('ANY', ['A', 'B', 'C'])).toBe('A, B ou C');
    expect(composeApproverLabel('ALL', ['A', 'B'])).toBe('A e B');
    expect(composeApproverLabel('SEQUENTIAL', ['A', 'B', 'C'])).toBe('A, depois B, depois C');
    expect(composeApproverLabel('ALL', ['A'])).toBe('A');
    expect(composeApproverLabel('ANY', [])).toBe('');
  });
});

describe('backfillLineOf (RN-APV-30 · M2-03)', () => {
  it.each([
    ['PENDING', null],
    ['APPROVED', 'APPROVE'],
    ['RETURNED', 'RETURN'],
    ['REJECTED', 'REJECT'],
    ['CANCELED', null],
  ] as const)('%s → linha 1 no estado equivalente', (status, decision) => {
    const decided = decision !== null;
    const source = approval({
      status,
      decision: decided ? decision : null,
      decidedById: decided ? MARCOS : null,
      decidedAt: decided ? NOW : null,
      decisionComment: decision === 'RETURN' || decision === 'REJECT' ? 'Motivo da decisão.' : null,
      decidedAsDeputy: decided,
    });
    const line = backfillLineOf(source, id(99));
    expect(line).toMatchObject({
      id: id(99),
      approvalId: APPROVAL,
      sequence: 1,
      status,
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: ROBERTO,
      allowDeputy: true,
      activatedAt: NOW,
      decision,
      decidedById: decided ? MARCOS : null,
      decidedAsDeputy: decided,
      skippedReason: status === 'CANCELED' ? 'WITHDRAWN' : null,
      createdById: null,
    });
  });
});

describe('sincronização provisória com as ações do MVP 1', () => {
  const open = (policy: 'ANY' | 'ALL' | 'SEQUENTIAL') =>
    openApprovalLines(
      APPROVAL,
      policy,
      guardSelfApproval(policy, [head(1), user(2, MARCOS), role(3)], facts([])),
      stamp,
    );

  it('retirada/cancelamento: linhas não decididas → CANCELED (WITHDRAWN); decididas ficam', () => {
    const lines = open('ALL').map((line) =>
      line.sequence === 2
        ? { ...line, status: 'APPROVED' as const, decision: 'APPROVE' as const, decidedAt: NOW }
        : line,
    );
    expect(
      linesAfterCancellation(lines, NOW).map((line) => [line.status, line.skippedReason]),
    ).toEqual([
      ['CANCELED', 'WITHDRAWN'],
      ['APPROVED', null],
      ['CANCELED', 'WITHDRAWN'],
    ]);
  });

  it('redirecionamento: a linha espelhada recebe o novo aprovador, no lugar; sem linha viva, null', () => {
    const lines = open('SEQUENTIAL');
    const reassigned = approval({
      approverType: 'USER',
      approverUserId: MARCOS,
      approverDepartmentId: null,
      allowDeputy: false,
      updatedAt: NOW,
    });
    expect(lineAfterReassignment('SEQUENTIAL', lines, reassigned)).toMatchObject({
      id: lines[0]?.id,
      sequence: 1,
      approverType: 'USER',
      approverUserId: MARCOS,
      allowDeputy: false,
      status: 'PENDING',
      version: 2,
    });
    expect(lineAfterReassignment('ANY', linesAfterCancellation(lines, NOW), reassigned)).toBeNull();
  });
});

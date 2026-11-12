import type { ApprovalDecisionPolicy } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApprovalNotPendingError, recordOf } from './approval-decision.js';
import type { ApprovalRecord } from './approval-decision.js';
import {
  ApprovalLineNotFoundError,
  ApprovalLineNotReassignableError,
  ApprovalLineRequiredError,
  ReassignDuplicatedError,
  ReassignSelfApprovalError,
  assertNotInOtherLine,
  guardLineTarget,
  isSameLineApprover,
  positionsOf,
  reassignLine,
  reassignableLineOf,
  singleLineOf,
  withdrawalTallyOf,
} from './approval-line-reassignment.js';
import {
  guardSelfApproval,
  linesAfterCancellation,
  mirroredLineOf,
  openApprovalLines,
} from './approval-lines.js';
import type { ApprovalApprover, ResolvedApprovalLine } from './approval-lines.js';
import {
  LineSelectionError,
  approvalInvariantViolations,
  castVote,
  selectVoteLine,
} from './approval-vote.js';
import type { Approval, ResolvedApprover } from './approval.js';

/*
 * US-135 — redirecionar linha e retirar aprovação múltipla, puro: a linha alvo e a ordem das
 * recusas (RN-APV-51/59/60), "cancelar e criar" preservando `sequence`, estado, `activatedAt` e
 * `dueAt` e o espelho (RN-APV-52), o mesmo aprovador, a segregação por linha com a regra do
 * substituto e a pessoa única com o histórico (RN-APV-53), a ativação da linha redirecionada em
 * espera (FA-02) e a contagem da retirada — votos preservados (RN-APV-57). Ver também
 * `approval-vote.spec.ts` (decisão por linha).
 */

const id = (n: number) => `0192f135-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ROBERTO = id(1);
const MARCOS = id(2);
const PAULA = id(3);
const DIEGO = id(4);
const ANA = id(5);
const HELENA = id(6);
const MARTA = id(7);
const SECRETARIA = id(10);
const ROLE = id(20);
const OTHER_ROLE = id(21);
const APPROVAL = id(30);
const NOW = new Date('2026-11-12T12:00:00.000Z');
const LATER = new Date('2026-11-12T13:00:00.000Z');
const DUE = new Date('2026-12-10T23:59:59.000Z');

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
const targetUser = (userId: string): ResolvedApprover => ({
  approverType: 'USER',
  approverUserId: userId,
  approverRoleId: null,
  approverDepartmentId: null,
  allowDeputy: false,
});
const targetHead = (headUserId: string): ResolvedApprover => ({
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: headUserId,
  approverRoleId: null,
  approverDepartmentId: SECRETARIA,
  allowDeputy: true,
});
const targetRole = (roleId: string): ResolvedApprover => ({
  approverType: 'ROLE',
  approverUserId: null,
  approverRoleId: roleId,
  approverDepartmentId: null,
  allowDeputy: false,
});

let counter = 100;
const nextId = () => id((counter += 1));
const open = (
  policy: ApprovalDecisionPolicy,
  lines: readonly ResolvedApprovalLine[],
): ApprovalApprover[] =>
  openApprovalLines(
    APPROVAL,
    policy,
    guardSelfApproval(policy, lines, {
      preventSelfApproval: false,
      authorIds: new Set(),
      deputies: new Map(),
    }),
    { requestedAt: NOW, requestedById: ANA, newId: nextId },
  );

const approvalOf = (
  policy: ApprovalDecisionPolicy,
  lines: readonly ApprovalApprover[],
): ApprovalRecord => {
  const mirror = mirroredLineOf(policy, lines);
  const base: Approval = {
    id: APPROVAL,
    tenantId: id(40),
    processId: id(41),
    subjectType: 'PROCESS_STAGE',
    processStageId: id(42),
    documentId: null,
    title: 'Autorização da licitação',
    requestedById: ANA,
    requestedAt: NOW,
    requestComment: null,
    approverType: mirror?.approverType ?? 'USER',
    approverUserId: mirror?.approverUserId ?? null,
    approverRoleId: mirror?.approverRoleId ?? null,
    approverDepartmentId: mirror?.approverDepartmentId ?? null,
    allowDeputy: mirror?.allowDeputy ?? false,
    dueAt: new Date('2026-11-20T23:59:59.000Z'),
    status: 'PENDING',
    createdAt: NOW,
    createdById: ANA,
    decisionPolicy: policy,
  };
  return recordOf(base);
};

/**
 * Background da story: SEQUENTIAL com Roberto (linha 1) já `APPROVED`, Marcos (linha 2) `PENDING`
 * com prazo próprio e Paula (linha 3) `WAITING`.
 */
function background() {
  const opened = open('SEQUENTIAL', [user(1, ROBERTO), user(2, MARCOS), user(3, PAULA)]).map(
    (line) => (line.sequence === 2 ? { ...line, dueAt: DUE } : line),
  );
  const approval = approvalOf('SEQUENTIAL', opened);
  const voted = castVote(approval, opened, {
    lineId: opened[0]?.id ?? '',
    decision: 'APPROVE',
    comment: null,
    decidedById: ROBERTO,
    asDeputy: false,
    now: NOW,
  });
  const lineAt = (sequence: number) => {
    const line = voted.lines.find((candidate) => candidate.sequence === sequence);
    if (!line) throw new Error(`linha ${String(sequence)} ausente`);
    return line;
  };
  return { approval: voted.approval, lines: voted.lines, lineAt };
}

const stamp = { now: LATER, newId: nextId, userId: MARTA };

describe('reassignableLineOf / singleLineOf (RN-APV-51/60)', () => {
  it('APV-06: a linha PENDING ou WAITING da aprovação', () => {
    const { lines, lineAt } = background();
    expect(reassignableLineOf(lines, lineAt(2).id)).toBe(lineAt(2));
    expect(reassignableLineOf(lines, lineAt(3).id).status).toBe('WAITING');
  });

  it('linha decidida, dispensada ou cancelada → APPROVAL_LINE_NOT_PENDING; de outra aprovação → não encontrada', () => {
    const { lines, lineAt } = background();
    expect(() => reassignableLineOf(lines, lineAt(1).id)).toThrow(ApprovalLineNotReassignableError);
    const canceled = linesAfterCancellation(lines, LATER);
    expect(() => reassignableLineOf(canceled, lineAt(2).id)).toThrow(
      ApprovalLineNotReassignableError,
    );
    expect(() => reassignableLineOf(lines, id(999))).toThrow(ApprovalLineNotFoundError);
  });

  it('APV-05: a única linha; mais de uma posição → APPROVAL_LINE_REQUIRED', () => {
    const single = open('ANY', [user(1, MARCOS)]);
    expect(singleLineOf(single)).toBe(single[0]);
    const { lines } = background();
    expect(() => singleLineOf(lines)).toThrow(ApprovalLineRequiredError);
    expect(positionsOf(lines)).toBe(3);
  });

  it('APV-05 depois de um redirecionamento: a linha cancelada não conta como outra posição', () => {
    const single = open('ANY', [user(1, MARCOS)]);
    const [line] = single;
    if (!line) throw new Error('linha ausente');
    const { linesAfter, created } = reassignLine(
      approvalOf('ANY', single),
      single,
      line,
      targetUser(DIEGO),
      stamp,
    );
    expect(positionsOf(linesAfter)).toBe(1);
    expect(singleLineOf(linesAfter).id).toBe(created.id);
  });
});

describe('reassignLine — "cancelar e criar" (RN-APV-52)', () => {
  it('[Sucesso] linha PENDING: antiga CANCELED/REASSIGNED, nova no mesmo sequence com prazo, ativação e reassignedFromId', () => {
    const { approval, lines, lineAt } = background();
    const old = lineAt(2);
    const result = reassignLine(approval, lines, old, targetUser(DIEGO), stamp);

    expect(result.canceled).toEqual({
      ...old,
      status: 'CANCELED',
      skippedReason: 'REASSIGNED',
      updatedAt: LATER,
      version: old.version + 1,
    });
    expect(result.created).toMatchObject({
      approvalId: APPROVAL,
      sequence: 2,
      status: 'PENDING',
      approverType: 'USER',
      approverUserId: DIEGO,
      activatedAt: old.activatedAt,
      dueAt: DUE,
      reassignedFromId: old.id,
      decision: null,
      skippedReason: null,
      createdById: MARTA,
      version: 1,
    });
    // FA-03: o voto de Roberto e a linha em espera não mudam.
    expect(result.linesAfter.find((line) => line.sequence === 1)).toBe(lineAt(1));
    expect(result.linesAfter.find((line) => line.sequence === 3)).toBe(lineAt(3));
    expect(result.linesAfter.map((line) => [line.sequence, line.status])).toEqual([
      [1, 'APPROVED'],
      [2, 'CANCELED'],
      [2, 'PENDING'],
      [3, 'WAITING'],
    ]);
    // O espelho segue a linha corrente; título, prazo e solicitante ficam (RN-TRAM-70).
    expect(result.approval).toMatchObject({
      status: 'PENDING',
      approverType: 'USER',
      approverUserId: DIEGO,
      title: approval.title,
      dueAt: approval.dueAt,
      requestedById: ANA,
      version: approval.version + 1,
      updatedAt: LATER,
    });
    expect(approvalInvariantViolations(result.approval, result.linesAfter)).toEqual([]);
  });

  it('[Sucesso] linha WAITING (FA-02): nasce WAITING sem ativação e o espelho não muda', () => {
    const { approval, lines, lineAt } = background();
    const result = reassignLine(approval, lines, lineAt(3), targetRole(OTHER_ROLE), stamp);
    expect(result.created).toMatchObject({
      sequence: 3,
      status: 'WAITING',
      activatedAt: null,
      approverType: 'ROLE',
      approverRoleId: OTHER_ROLE,
      reassignedFromId: lineAt(3).id,
    });
    expect(result.approval.approverUserId).toBe(MARCOS);
  });

  it('a linha redirecionada em espera é ativada pelo voto da anterior (US-134)', () => {
    const { approval, lines, lineAt } = background();
    const redirected = reassignLine(approval, lines, lineAt(3), targetUser(DIEGO), stamp);
    const voted = castVote(redirected.approval, redirected.linesAfter, {
      lineId: lineAt(2).id,
      decision: 'APPROVE',
      comment: null,
      decidedById: MARCOS,
      asDeputy: false,
      now: LATER,
    });
    expect(voted.activated).toMatchObject({ id: redirected.created.id, status: 'PENDING' });
    expect(voted.approval.approverUserId).toBe(DIEGO);
  });

  it('FA-08: o voto com o id da linha já redirecionada recebe LINE_NOT_PENDING (409), não 403', () => {
    const { approval, lines, lineAt } = background();
    const { linesAfter } = reassignLine(approval, lines, lineAt(2), targetUser(DIEGO), stamp);
    const facts = { userId: MARCOS, roleHolders: new Map(), units: new Map() };
    expect(() => selectVoteLine(linesAfter, facts, lineAt(2).id)).toThrow(
      expect.objectContaining({ problem: 'LINE_NOT_PENDING' }) as unknown,
    );
    // Quem nunca foi aprovador da linha continua sem designação (403).
    expect(() => selectVoteLine(linesAfter, { ...facts, userId: PAULA }, lineAt(2).id)).toThrow(
      expect.objectContaining({ problem: 'NOT_LINE_APPROVER' }) as unknown,
    );
    expect(() => selectVoteLine(linesAfter, facts, lineAt(2).id)).toThrow(LineSelectionError);
  });

  it('aprovação não pendente ou linha decidida não é redirecionada', () => {
    const { approval, lines, lineAt } = background();
    expect(() =>
      reassignLine({ ...approval, status: 'CANCELED' }, lines, lineAt(2), targetUser(DIEGO), stamp),
    ).toThrow(ApprovalNotPendingError);
    expect(() => reassignLine(approval, lines, lineAt(1), targetUser(DIEGO), stamp)).toThrow(
      ApprovalLineNotReassignableError,
    );
  });
});

describe('isSameLineApprover (V-03)', () => {
  it('mesmo usuário, perfil ou unidade da linha é o mesmo aprovador', () => {
    const [userLine] = open('ANY', [user(1, MARCOS)]);
    const [roleLine] = open('ANY', [role(1)]);
    if (!userLine || !roleLine) throw new Error('linhas ausentes');
    expect(isSameLineApprover(userLine, targetUser(MARCOS))).toBe(true);
    expect(isSameLineApprover(userLine, targetUser(DIEGO))).toBe(false);
    expect(isSameLineApprover(roleLine, targetRole(ROLE))).toBe(true);
    expect(isSameLineApprover(roleLine, targetRole(OTHER_ROLE))).toBe(false);
    expect(isSameLineApprover(userLine, targetHead(MARCOS))).toBe(false);
  });
});

describe('guardLineTarget — segregação por linha (RN-APV-53 → RN-APV-20)', () => {
  const facts = (overrides: Partial<Parameters<typeof guardLineTarget>[2]> = {}) => ({
    preventSelfApproval: true,
    authorIds: new Set([ANA]),
    deputyUserId: HELENA,
    ...overrides,
  });

  it('USER autor → SELF_APPROVAL_FORBIDDEN; sem preventSelfApproval ou sem autoria, segue', () => {
    expect(() => guardLineTarget(2, targetUser(ANA), facts())).toThrow(ReassignSelfApprovalError);
    expect(
      guardLineTarget(2, targetUser(ANA), facts({ preventSelfApproval: false })),
    ).toMatchObject({ approverUserId: ANA, selfApprovalAvoided: false });
    expect(guardLineTarget(2, targetUser(DIEGO), facts()).selfApprovalAvoided).toBe(false);
  });

  it('titular autor → o substituto ativo, sem allowDeputy; sem substituto ou substituto autor → recusa', () => {
    expect(guardLineTarget(2, targetHead(ANA), facts())).toMatchObject({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: HELENA,
      approverDepartmentId: SECRETARIA,
      allowDeputy: false,
      selfApprovalAvoided: true,
    });
    expect(() => guardLineTarget(2, targetHead(ANA), facts({ deputyUserId: null }))).toThrow(
      ReassignSelfApprovalError,
    );
    expect(() =>
      guardLineTarget(2, targetHead(ANA), facts({ authorIds: new Set([ANA, HELENA]) })),
    ).toThrow(ReassignSelfApprovalError);
  });

  it('ROLE não nomeia ninguém: a segregação fica para o voto', () => {
    expect(guardLineTarget(2, targetRole(ROLE), facts()).selfApprovalAvoided).toBe(false);
  });
});

describe('assertNotInOtherLine — pessoa única com o histórico (RN-APV-53)', () => {
  it('quem votou em outra linha não assume esta (APPROVER_DUPLICATED)', () => {
    const { lines } = background();
    expect(() => {
      assertNotInOtherLine(lines, 2, targetUser(ROBERTO));
    }).toThrow(ReassignDuplicatedError);
    expect(() => {
      assertNotInOtherLine(lines, 2, targetUser(PAULA));
    }).toThrow(expect.objectContaining({ sequence: 2, otherSequence: 3 }) as unknown);
    expect(() => {
      assertNotInOtherLine(lines, 2, targetUser(DIEGO));
    }).not.toThrow();
  });

  it('quem ocupou outra linha antes de ser redirecionado também conta; a própria posição, não', () => {
    const { approval, lines, lineAt } = background();
    const moved = reassignLine(approval, lines, lineAt(3), targetUser(DIEGO), stamp).linesAfter;
    // Paula ocupou a linha 3 (cancelada): não assume a linha 2.
    expect(() => {
      assertNotInOtherLine(moved, 2, targetUser(PAULA));
    }).toThrow(ReassignDuplicatedError);
    // Marcos volta para a própria linha 2 depois de redirecionado: não é "outra linha".
    const back = reassignLine(approval, lines, lineAt(2), targetUser(DIEGO), stamp).linesAfter;
    expect(() => {
      assertNotInOtherLine(back, 2, targetUser(MARCOS));
    }).not.toThrow();
  });

  it('quem votou numa linha de perfil conta; o alvo ROLE nunca é comparado', () => {
    const opened = open('ALL', [role(1), user(2, MARCOS)]);
    const voted = castVote(approvalOf('ALL', opened), opened, {
      lineId: opened[0]?.id ?? '',
      decision: 'APPROVE',
      comment: null,
      decidedById: PAULA,
      asDeputy: false,
      now: NOW,
    }).lines;
    expect(() => {
      assertNotInOtherLine(voted, 2, targetUser(PAULA));
    }).toThrow(ReassignDuplicatedError);
    expect(() => {
      assertNotInOtherLine(voted, 2, targetRole(ROLE));
    }).not.toThrow();
  });
});

describe('withdrawalTallyOf — retirada com votos (RN-APV-57)', () => {
  it('as linhas não decididas são canceladas; os votos ficam no histórico', () => {
    const { lines, lineAt } = background();
    expect(withdrawalTallyOf(lines)).toEqual({
      linesCanceled: 2,
      votesKept: 1,
      canceledLineIds: [lineAt(2).id, lineAt(3).id],
    });
    const after = linesAfterCancellation(lines, LATER);
    expect(after.map((line) => [line.sequence, line.status, line.skippedReason])).toEqual([
      [1, 'APPROVED', null],
      [2, 'CANCELED', 'WITHDRAWN'],
      [3, 'CANCELED', 'WITHDRAWN'],
    ]);
    expect(after[0]).toBe(lineAt(1));
  });
});

import type { ApprovalDecision, ApprovalDecisionPolicy } from '@contrataflow/validation';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { recordOf } from './approval-decision.js';
import type { ApprovalRecord } from './approval-decision.js';
import { guardSelfApproval, mirroredLineOf, openApprovalLines } from './approval-lines.js';
import type { ApprovalApprover, ResolvedApprovalLine } from './approval-lines.js';
import {
  LineSelectionError,
  VoteNotAllowedError,
  approvalInvariantViolations,
  castVote,
  coveredLinesOf,
  lineDecisionBlockerOf,
  lineDesignationOf,
  selectVoteLine,
  voteClosesApproval,
  voteExpectedVersion,
} from './approval-vote.js';
import type { LineDesignationFacts } from './approval-vote.js';
import type { Approval } from './approval.js';

/*
 * US-134 — decisão por linha, puro: designação por linha (RN-APV-33/44), escolha da linha e ordem
 * das verificações (RN-APV-40), `If-Match` por política (RN-APV-41), `DecisionPolicyStrategy` em
 * matriz completa política × decisão (RN-APV-34..37), ativação da próxima linha em `SEQUENTIAL`,
 * espelho (RN-APV-24/39), bloqueios do APV-02 (lacuna 4) e as invariantes de RN-APV-50 por teste de
 * propriedade com sequências aleatórias de votos.
 */

const id = (n: number) => `0192f134-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ROBERTO = id(1);
const HELENA = id(2);
const MARCOS = id(3);
const ANA = id(4);
const PAULA = id(5);
const BRUNO = id(6);
const SECRETARIA = id(10);
const ROLE = id(20);
const APPROVAL = id(30);
const NOW = new Date('2026-11-11T12:00:00.000Z');
const LATER = new Date('2026-11-11T13:00:00.000Z');

const head = (sequence: number): ResolvedApprovalLine => ({
  sequence,
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: ROBERTO,
  approverRoleId: null,
  approverDepartmentId: SECRETARIA,
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
    { requestedAt: NOW, requestedById: ANA, newId: () => id((counter += 1)) },
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

const factsFor = (
  userId: string,
  overrides: Partial<Omit<LineDesignationFacts, 'userId'>> = {},
): LineDesignationFacts => ({
  userId,
  roleHolders: new Map([[ROLE, [MARCOS, PAULA]]]),
  units: new Map([[SECRETARIA, { headUserId: ROBERTO, deputyUserId: HELENA }]]),
  ...overrides,
});

const vote = (
  approval: ApprovalRecord,
  lines: readonly ApprovalApprover[],
  line: ApprovalApprover | undefined,
  decision: ApprovalDecision,
  decidedById: string,
  now = LATER,
) =>
  castVote(approval, lines, {
    lineId: line?.id ?? '',
    decision,
    comment: decision === 'APPROVE' ? null : 'Faltam as cláusulas de reajuste do contrato',
    decidedById,
    asDeputy: false,
    now,
  });

const statuses = (lines: readonly ApprovalApprover[]) =>
  [...lines]
    .sort((a, b) => a.sequence - b.sequence)
    .map((line) => [line.status, line.skippedReason]);

describe('lineDesignationOf (POL-03 por linha · RN-APV-33/44)', () => {
  const [headLine, userLine, roleLine] = open('ALL', [head(1), user(2, MARCOS), role(3)]);

  it('USER direto; ROLE detentor competente; DEPARTMENT_HEAD titular atual ou substituto com allowDeputy', () => {
    expect(userLine && lineDesignationOf(userLine, factsFor(MARCOS))).toEqual({
      designated: true,
      asDeputy: false,
    });
    expect(roleLine && lineDesignationOf(roleLine, factsFor(PAULA)).designated).toBe(true);
    expect(roleLine && lineDesignationOf(roleLine, factsFor(BRUNO)).designated).toBe(false);
    expect(headLine && lineDesignationOf(headLine, factsFor(ROBERTO))).toEqual({
      designated: true,
      asDeputy: false,
    });
    expect(headLine && lineDesignationOf(headLine, factsFor(HELENA))).toEqual({
      designated: true,
      asDeputy: true,
    });
    expect(
      headLine && lineDesignationOf({ ...headLine, allowDeputy: true }, factsFor(BRUNO)).designated,
    ).toBe(false);
  });

  it('linha desviada na solicitação (titular autor → substituto gravado, allowDeputy falso): só a pessoa gravada, como substituta', () => {
    if (headLine === undefined) throw new Error('linha ausente');
    const diverted = { ...headLine, approverUserId: HELENA, allowDeputy: false };
    expect(lineDesignationOf(diverted, factsFor(HELENA))).toEqual({
      designated: true,
      asDeputy: true,
    });
    expect(lineDesignationOf(diverted, factsFor(ROBERTO)).designated).toBe(false);
  });

  it('linha CANCELED não tem aprovador', () => {
    if (userLine === undefined) throw new Error('linha ausente');
    expect(lineDesignationOf({ ...userLine, status: 'CANCELED' }, factsFor(MARCOS))).toEqual({
      designated: false,
      asDeputy: false,
    });
  });
});

describe('selectVoteLine (RN-APV-33/40 · FA-02/03/04)', () => {
  it('a única linha PENDING da pessoa; sem linha coberta, line = null (403 depois do If-Match)', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS)]);
    expect(selectVoteLine(lines, factsFor(MARCOS), null).line?.sequence).toBe(2);
    expect(selectVoteLine(lines, factsFor(BRUNO), null)).toEqual({
      line: null,
      designation: { designated: false, asDeputy: false },
      alreadyVoted: false,
    });
  });

  it('FA-03: duas linhas PENDING exigem approvalApproverId (LINE_REQUIRED); com ele, a linha escolhida', () => {
    const lines = open('ALL', [user(1, MARCOS), role(2)]);
    expect(() => selectVoteLine(lines, factsFor(MARCOS), null)).toThrow(
      expect.objectContaining({ problem: 'LINE_REQUIRED' }),
    );
    expect(selectVoteLine(lines, factsFor(MARCOS), lines[1]?.id ?? null).line?.sequence).toBe(2);
  });

  it('V-04: linha de outra aprovação ou que não é da pessoa → NOT_LINE_APPROVER', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS)]);
    for (const requested of [lines[0]?.id ?? '', id(999)]) {
      expect(() => selectVoteLine(lines, factsFor(MARCOS), requested)).toThrow(
        expect.objectContaining({ problem: 'NOT_LINE_APPROVER' }),
      );
    }
  });

  it('FA-04: linha WAITING em SEQUENTIAL → LINE_WAITING', () => {
    const lines = open('SEQUENTIAL', [head(1), user(2, MARCOS)]);
    expect(() => selectVoteLine(lines, factsFor(MARCOS), null)).toThrow(
      expect.objectContaining({ problem: 'LINE_WAITING' }),
    );
  });

  it('FA-02 / V-06: linha de perfil já decidida por outro detentor → LINE_NOT_PENDING', () => {
    const lines = open('ALL', [head(1), role(2)]);
    const approval = approvalOf('ALL', lines);
    const after = vote(approval, lines, lines[1], 'APPROVE', MARCOS).lines;
    let caught: unknown;
    try {
      selectVoteLine(after, factsFor(PAULA), null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LineSelectionError);
    expect(caught).toMatchObject({ problem: 'LINE_NOT_PENDING', line: { sequence: 2 } });
  });

  it('pessoa única: depois do voto, outra linha dela fica alreadyVoted (409 APPROVER_ALREADY_VOTED); a mesma linha dá LINE_NOT_PENDING', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS), role(3)]);
    const approval = approvalOf('ALL', lines);
    const after = vote(approval, lines, lines[1], 'APPROVE', MARCOS).lines;
    const selection = selectVoteLine(after, factsFor(MARCOS), null);
    expect(selection).toMatchObject({ line: { sequence: 3 }, alreadyVoted: true });
    expect(() => selectVoteLine(after, factsFor(MARCOS), after[1]?.id ?? null)).toThrow(
      expect.objectContaining({ problem: 'LINE_NOT_PENDING' }),
    );
  });
});

describe('voteExpectedVersion (RN-APV-41)', () => {
  it('ANY usa a versão da aprovação; ALL/SEQUENTIAL a da linha; sem linha, a da aprovação', () => {
    const line = { version: 3 };
    expect(voteExpectedVersion({ version: 7, decisionPolicy: 'ANY' }, line)).toBe(7);
    expect(voteExpectedVersion({ version: 7 }, line)).toBe(7);
    expect(voteExpectedVersion({ version: 7, decisionPolicy: 'ALL' }, line)).toBe(3);
    expect(voteExpectedVersion({ version: 7, decisionPolicy: 'SEQUENTIAL' }, line)).toBe(3);
    expect(voteExpectedVersion({ version: 7, decisionPolicy: 'ALL' }, null)).toBe(7);
  });
});

describe('DecisionPolicyStrategy — matriz política × decisão (RN-APV-34..37)', () => {
  it.each([
    [
      'ANY',
      'APPROVE',
      'APPROVED',
      [
        ['APPROVED', null],
        ['SKIPPED', 'ANY_DECIDED'],
      ],
    ],
    [
      'ANY',
      'RETURN',
      'RETURNED',
      [
        ['RETURNED', null],
        ['SKIPPED', 'ANY_DECIDED'],
      ],
    ],
    [
      'ANY',
      'REJECT',
      'REJECTED',
      [
        ['REJECTED', null],
        ['SKIPPED', 'ANY_DECIDED'],
      ],
    ],
    [
      'ALL',
      'APPROVE',
      'VOTE_RECORDED',
      [
        ['APPROVED', null],
        ['PENDING', null],
      ],
    ],
    [
      'ALL',
      'RETURN',
      'RETURNED',
      [
        ['RETURNED', null],
        ['SKIPPED', 'NEGATIVE_DECISION'],
      ],
    ],
    [
      'ALL',
      'REJECT',
      'REJECTED',
      [
        ['REJECTED', null],
        ['SKIPPED', 'NEGATIVE_DECISION'],
      ],
    ],
    [
      'SEQUENTIAL',
      'APPROVE',
      'VOTE_RECORDED',
      [
        ['APPROVED', null],
        ['PENDING', null],
      ],
    ],
    [
      'SEQUENTIAL',
      'RETURN',
      'RETURNED',
      [
        ['RETURNED', null],
        ['SKIPPED', 'NEGATIVE_DECISION'],
      ],
    ],
    [
      'SEQUENTIAL',
      'REJECT',
      'REJECTED',
      [
        ['REJECTED', null],
        ['SKIPPED', 'NEGATIVE_DECISION'],
      ],
    ],
  ] as const)('%s + %s na linha 1 → %s', (policy, decision, outcome, expected) => {
    const lines = open(policy, [head(1), user(2, MARCOS)]);
    const approval = approvalOf(policy, lines);
    const result = vote(approval, lines, lines[0], decision, ROBERTO);
    expect(result.outcome).toBe(outcome);
    expect(result.closes).toBe(outcome !== 'VOTE_RECORDED');
    expect(statuses(result.lines)).toEqual(expected);
    expect(result.approval.version).toBe(approval.version + 1);
    // RN-APV-49: o prazo da aprovação não muda com os votos.
    expect(result.approval.dueAt).toEqual(approval.dueAt);
    expect(result.decided).toMatchObject({
      decision,
      decidedById: ROBERTO,
      decidedAt: LATER,
      version: 2,
    });
    expect(approvalInvariantViolations(result.approval, result.lines)).toEqual([]);
  });

  it('ALL: o primeiro voto mantém PENDING (sem mudar o espelho); o último encerra APPROVED com o espelho e a decisão da linha final', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS)]);
    const approval = approvalOf('ALL', lines);
    const first = vote(approval, lines, lines[0], 'APPROVE', ROBERTO);
    expect(first).toMatchObject({
      outcome: 'VOTE_RECORDED',
      remainingPending: 1,
      remainingWaiting: 0,
      activated: null,
    });
    expect(first.approval).toMatchObject({
      status: 'PENDING',
      decision: null,
      approverType: 'DEPARTMENT_HEAD',
      version: 2,
    });
    const second = vote(first.approval, first.lines, first.lines[1], 'APPROVE', MARCOS);
    expect(second.outcome).toBe('APPROVED');
    expect(second.approval).toMatchObject({
      status: 'APPROVED',
      decision: 'APPROVE',
      decidedById: MARCOS,
      approverType: 'USER',
      approverUserId: MARCOS,
      version: 3,
    });
    expect(second.votes.map((item) => [item.sequence, item.decision, item.decidedById])).toEqual([
      [1, 'APPROVE', ROBERTO],
      [2, 'APPROVE', MARCOS],
    ]);
  });

  it('SEQUENTIAL: aprovar ativa a próxima (WAITING → PENDING, activatedAt) e o espelho a segue; a última encerra', () => {
    const lines = open('SEQUENTIAL', [head(1), user(2, MARCOS), role(3)]);
    const approval = approvalOf('SEQUENTIAL', lines);
    const first = vote(approval, lines, lines[0], 'APPROVE', ROBERTO);
    expect(first.activated).toMatchObject({ sequence: 2, status: 'PENDING', activatedAt: LATER });
    expect(first).toMatchObject({ remainingPending: 1, remainingWaiting: 1 });
    expect(first.approval).toMatchObject({ approverType: 'USER', approverUserId: MARCOS });
    const second = vote(
      first.approval,
      first.lines,
      first.activated ?? undefined,
      'APPROVE',
      MARCOS,
    );
    expect(second.activated).toMatchObject({ sequence: 3, approverType: 'ROLE' });
    const third = vote(
      second.approval,
      second.lines,
      second.activated ?? undefined,
      'APPROVE',
      PAULA,
    );
    expect(third).toMatchObject({ outcome: 'APPROVED', closes: true, activated: null });
    expect(third.lines.every((line) => line.status === 'APPROVED')).toBe(true);
  });

  it('RN-APV-45: devolução depois de voto favorável encerra RETURNED e mantém o voto no histórico', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS)]);
    const first = vote(approvalOf('ALL', lines), lines, lines[0], 'APPROVE', ROBERTO);
    const returned = vote(first.approval, first.lines, first.lines[1], 'RETURN', MARCOS);
    expect(returned.outcome).toBe('RETURNED');
    expect(statuses(returned.lines)).toEqual([
      ['APPROVED', null],
      ['RETURNED', null],
    ]);
    expect(returned.approval).toMatchObject({
      status: 'RETURNED',
      decidedById: MARCOS,
      decisionComment: 'Faltam as cláusulas de reajuste do contrato',
    });
  });

  it('rede do domínio: aprovação encerrada ou linha não PENDING recusam o voto', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS)]);
    const approval = approvalOf('ALL', lines);
    expect(() =>
      vote({ ...approval, status: 'APPROVED' }, lines, lines[0], 'APPROVE', ROBERTO),
    ).toThrow(VoteNotAllowedError);
    const sequential = open('SEQUENTIAL', [head(1), user(2, MARCOS)]);
    expect(() =>
      vote(approvalOf('SEQUENTIAL', sequential), sequential, sequential[1], 'APPROVE', MARCOS),
    ).toThrow(expect.objectContaining({ reason: 'LINE_NOT_PENDING' }));
  });

  it('voteClosesApproval: ANY e negativas sempre; positiva só sem outra linha viva', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS)]);
    const [first, second] = lines;
    expect(voteClosesApproval('ANY', lines, first?.id ?? '', 'APPROVE')).toBe(true);
    expect(voteClosesApproval('ALL', lines, first?.id ?? '', 'REJECT')).toBe(true);
    expect(voteClosesApproval('ALL', lines, first?.id ?? '', 'APPROVE')).toBe(false);
    const decided = lines.map((line) =>
      line.id === first?.id ? { ...line, status: 'APPROVED' as const } : line,
    );
    expect(voteClosesApproval('ALL', decided, second?.id ?? '', 'APPROVE')).toBe(true);
  });
});

describe('lineDecisionBlockerOf (APV-02 · lacuna 4)', () => {
  const base = {
    status: 'PENDING' as const,
    canDecide: true,
    line: { status: 'PENDING' as const },
    alreadyVoted: false,
    selfApproval: false,
    processStatus: 'AWAITING_APPROVAL' as const,
  };

  it('o primeiro motivo na ordem das checagens do APV-03', () => {
    expect(lineDecisionBlockerOf(base)).toBeNull();
    expect(lineDecisionBlockerOf({ ...base, status: 'APPROVED', canDecide: false })).toBe(
      'NOT_PENDING',
    );
    expect(lineDecisionBlockerOf({ ...base, canDecide: false, line: null })).toBe(
      'PERMISSION_DENIED',
    );
    expect(lineDecisionBlockerOf({ ...base, line: null })).toBe('NOT_DESIGNATED_APPROVER');
    expect(
      lineDecisionBlockerOf({ ...base, alreadyVoted: true, line: { status: 'APPROVED' } }),
    ).toBe('ALREADY_VOTED');
    expect(lineDecisionBlockerOf({ ...base, line: { status: 'WAITING' } })).toBe(
      'NOT_DESIGNATED_APPROVER',
    );
    expect(lineDecisionBlockerOf({ ...base, line: { status: 'APPROVED' } })).toBe(
      'LINE_NOT_PENDING',
    );
    expect(lineDecisionBlockerOf({ ...base, selfApproval: true })).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(lineDecisionBlockerOf({ ...base, processStatus: 'SUSPENDED' })).toBe(
      'INVALID_PROCESS_STATUS',
    );
  });
});

describe('invariantes de RN-APV-50 (teste de propriedade)', () => {
  const PEOPLE = [ROBERTO, HELENA, MARCOS, PAULA, BRUNO];
  const factsOf = (userId: string) =>
    factsFor(userId, {
      roleHolders: new Map([[ROLE, [MARCOS, PAULA, BRUNO]]]),
      units: new Map([[SECRETARIA, { headUserId: ROBERTO, deputyUserId: HELENA }]]),
    });

  it('decisões aleatórias, em qualquer ordem e com tentativas inválidas, mantêm a aprovação consistente', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ApprovalDecisionPolicy>('ANY', 'ALL', 'SEQUENTIAL'),
        fc.shuffledSubarray([head(1), user(2, MARCOS), role(3), user(4, PAULA)], {
          minLength: 2,
        }),
        fc.array(
          fc.record({
            person: fc.constantFrom(...PEOPLE),
            decision: fc.constantFrom<ApprovalDecision>('APPROVE', 'APPROVE', 'RETURN', 'REJECT'),
          }),
          { maxLength: 12 },
        ),
        (policy, chosen, attempts) => {
          const resolved = chosen.map((line, index) => ({ ...line, sequence: index + 1 }));
          let lines = open(policy, resolved);
          let approval = approvalOf(policy, lines);
          attempts.forEach(({ person, decision }, index) => {
            if (approval.status !== 'PENDING') return;
            let selection;
            try {
              selection = selectVoteLine(lines, factsOf(person), null);
            } catch {
              return; // recusa de seleção (linha em espera, decidida, ambígua) — nada muda
            }
            if (selection.line === null || selection.alreadyVoted) return;
            const result = castVote(approval, lines, {
              lineId: selection.line.id,
              decision,
              comment: decision === 'APPROVE' ? null : 'Motivo da decisão negativa',
              decidedById: person,
              asDeputy: selection.designation.asDeputy,
              now: new Date(NOW.getTime() + (index + 1) * 60_000),
            });
            approval = result.approval;
            lines = [...result.lines];
            expect(approvalInvariantViolations(approval, lines)).toEqual([]);
          });
          expect(approvalInvariantViolations(approval, lines)).toEqual([]);
          if (approval.status === 'PENDING') {
            expect(lines.some((line) => line.status === 'PENDING')).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('o verificador acusa cada violação', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS)]);
    const approval = approvalOf('ALL', lines);
    const decided = (line: ApprovalApprover | undefined, patch: Partial<ApprovalApprover>) => {
      if (line === undefined) throw new Error('linha ausente');
      return { ...line, ...patch };
    };
    expect(
      approvalInvariantViolations(approval, [
        decided(lines[0], { status: 'APPROVED', decision: 'APPROVE', decidedById: ROBERTO }),
        decided(lines[1], { status: 'SKIPPED' }),
      ]),
    ).toContain('a: PENDING sem linha viva');
    expect(
      approvalInvariantViolations({ ...approval, status: 'RETURNED' }, [
        decided(lines[0], {
          status: 'RETURNED',
          decision: 'RETURN',
          decidedById: ROBERTO,
          decidedAt: NOW,
        }),
        decided(lines[1], {
          status: 'APPROVED',
          decision: 'APPROVE',
          decidedById: MARCOS,
          decidedAt: LATER,
        }),
      ]),
    ).toContain('b: APPROVED depois de decisão negativa');
    expect(
      approvalInvariantViolations(approval, [
        decided(lines[0], { status: 'APPROVED', decision: 'APPROVE', decidedById: MARCOS }),
        decided(lines[1], { status: 'APPROVED', decision: 'APPROVE', decidedById: MARCOS }),
      ]),
    ).toContain('c: pessoa com dois votos');
    expect(
      approvalInvariantViolations({ ...approval, status: 'APPROVED' }, [
        decided(lines[0], { status: 'APPROVED', decision: 'APPROVE', decidedById: ROBERTO }),
        decided(lines[1], { status: 'SKIPPED' }),
      ]),
    ).toContain('d: APPROVED sem todas as linhas aprovadas');
  });

  it('coveredLinesOf: só as linhas que cabem à pessoa, em ordem', () => {
    const lines = open('ALL', [head(1), user(2, MARCOS), role(3)]);
    expect(coveredLinesOf(lines, factsFor(MARCOS)).map((item) => item.line.sequence)).toEqual([
      2, 3,
    ]);
  });
});

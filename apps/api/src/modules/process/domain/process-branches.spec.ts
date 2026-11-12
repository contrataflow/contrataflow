import { describe, expect, it } from 'vitest';

import {
  activeSplitOf,
  activeStagesOf,
  branchInvariantViolations,
  focusProcess,
  focusStages,
  macroStatus,
  parallelProcessFields,
  resolveTargetStage,
  stageStatusOf,
} from './process-branches.js';
import type { BranchAwareStage, ProcessBranchRecord } from './process-branches.js';
import type { Process } from './process.js';

/*
 * US-124 — motor de ramos, parte pura: status macro (RN-WF2-16), etapa-alvo (RN-WF2-18), visão
 * focada (RN-WF2-17), desnormalizações (RN-WF2-14) e as invariantes do bloco (RN-WF2-21), inclusive
 * um teste de propriedade com sequências aleatórias de operações (abrir 2/3/5 ramos, avançar,
 * devolver no ramo, chegar, juntar, devolver para antes do split e reentrar — FA-08).
 */

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));
let counter = 0;
const id = () => {
  counter += 1;
  return `0192d124-0000-7000-8000-${String(counter).padStart(12, '0')}`;
};

function stage(overrides: Partial<BranchAwareStage> = {}): BranchAwareStage {
  return {
    id: id(),
    workflowStageId: id(),
    sequence: 1,
    status: 'ACTIVE',
    departmentId: 'dep-a',
    assigneeId: null,
    enteredAt: at(0),
    exitedAt: null,
    dueAt: null,
    stageType: 'TASK',
    branchKey: null,
    splitProcessStageId: null,
    openedByReturn: false,
    ...overrides,
  };
}

const process = (overrides: Partial<Process> = {}): Process =>
  ({
    id: 'proc',
    tenantId: 't',
    status: 'IN_PROGRESS',
    currentStageId: null,
    currentWorkflowStageId: null,
    currentDepartmentId: 'dep-a',
    currentResponsibleId: 'ana',
    currentStageDueAt: null,
    version: 3,
    activeStagesCount: 1,
    ...overrides,
  }) as Process;

describe('macroStatus (RN-WF2-16)', () => {
  it.each([
    [[{ stageType: 'TASK', openedByReturn: false }], 'IN_PROGRESS'],
    [[{ stageType: 'APPROVAL', openedByReturn: false }], 'AWAITING_APPROVAL'],
    [
      [
        { stageType: 'APPROVAL', openedByReturn: false },
        { stageType: 'APPROVAL', openedByReturn: false },
      ],
      'AWAITING_APPROVAL',
    ],
    [
      [
        { stageType: 'TASK', openedByReturn: false },
        { stageType: 'APPROVAL', openedByReturn: false },
      ],
      'IN_PROGRESS',
    ],
    [
      [
        { stageType: 'APPROVAL', openedByReturn: false },
        { stageType: 'TASK', openedByReturn: true },
      ],
      'RETURNED',
    ],
    [[], 'SUSPENDED'],
  ] as const)('%j → %s', (actives, expected) => {
    expect(macroStatus(actives, 'SUSPENDED')).toBe(expected);
  });

  it('stageStatusOf: o tipo da etapa-alvo decide; suspenso e finais valem para o processo', () => {
    expect(stageStatusOf('IN_PROGRESS', { stageType: 'APPROVAL', openedByReturn: false })).toBe(
      'AWAITING_APPROVAL',
    );
    expect(stageStatusOf('AWAITING_APPROVAL', { stageType: 'TASK', openedByReturn: false })).toBe(
      'IN_PROGRESS',
    );
    expect(stageStatusOf('IN_PROGRESS', { stageType: 'TASK', openedByReturn: true })).toBe(
      'RETURNED',
    );
    expect(stageStatusOf('SUSPENDED', { stageType: 'TASK', openedByReturn: false })).toBe(
      'SUSPENDED',
    );
  });
});

describe('resolveTargetStage (RN-WF2-18)', () => {
  const split = stage({ stageType: 'PARALLEL_SPLIT', sequence: 2 });
  const juridico = stage({ branchKey: 'JURIDICO', splitProcessStageId: split.id, sequence: 3 });
  const controle = stage({
    branchKey: 'CONTROLE_INTERNO',
    splitProcessStageId: split.id,
    sequence: 4,
  });
  const done = stage({ status: 'COMPLETED', sequence: 1 });
  const branching = [done, split, juridico, controle];
  const current = { currentStageId: split.id };

  it('fora da ramificação e sem processStageId: o caminho do MVP 1', () => {
    expect(resolveTargetStage({ currentStageId: done.id }, [done], {}).kind).toBe('TRUNK');
  });

  it('com várias etapas ativas exige a etapa; o split nunca é alvo', () => {
    expect(resolveTargetStage(current, branching, {}).kind).toBe('REQUIRED');
    expect(resolveTargetStage(current, branching, { expectedStageId: juridico.id }).kind).toBe(
      'REQUIRED',
    );
    expect(resolveTargetStage(current, branching, { processStageId: split.id }).kind).toBe(
      'INVALID',
    );
    expect(resolveTargetStage(current, branching, { processStageId: 'outro' }).kind).toBe(
      'INVALID',
    );
  });

  it('etapa encerrada, esperada diferente ou o split como esperado (leitor do MVP 1): CHANGED', () => {
    expect(resolveTargetStage(current, branching, { processStageId: done.id }).kind).toBe(
      'CHANGED',
    );
    expect(
      resolveTargetStage(current, branching, {
        processStageId: juridico.id,
        expectedStageId: controle.id,
      }).kind,
    ).toBe('CHANGED');
    expect(resolveTargetStage(current, branching, { expectedStageId: split.id }).kind).toBe(
      'CHANGED',
    );
  });

  it('a etapa informada e, com um único ramo restante, a inferida (FA-01)', () => {
    expect(resolveTargetStage(current, branching, { processStageId: juridico.id })).toEqual({
      kind: 'TARGET',
      stage: juridico,
    });
    const oneLeft = [done, split, { ...juridico, status: 'COMPLETED' as const }, controle];
    expect(resolveTargetStage(current, oneLeft, {})).toEqual({ kind: 'TARGET', stage: controle });
  });
});

describe('visão focada e desnormalizações (RN-WF2-14/17)', () => {
  it('focusProcess: a custódia e o status são os da etapa; fora do ramo, o próprio processo', () => {
    const trunk = stage();
    const base = process({ currentStageId: trunk.id });
    expect(focusProcess(base, trunk)).toBe(base);
    const branch = stage({
      branchKey: 'JURIDICO',
      splitProcessStageId: 's',
      departmentId: 'proc-dep',
      assigneeId: 'paulo',
      stageType: 'APPROVAL',
    });
    expect(focusProcess(process({ currentResponsibleId: null }), branch)).toMatchObject({
      currentStageId: branch.id,
      currentDepartmentId: 'proc-dep',
      currentResponsibleId: 'paulo',
      status: 'AWAITING_APPROVAL',
    });
    const other = stage({ branchKey: 'CI', splitProcessStageId: 's' });
    expect(focusStages([branch, other], branch)).toEqual([branch]);
  });

  it('parallelProcessFields: primeiro ramo na ordem de exibição, menor prazo, contagem e status', () => {
    const order = new Map([
      ['JURIDICO', 0],
      ['CONTROLE_INTERNO', 1],
    ]);
    const fields = parallelProcessFields(
      process(),
      [
        stage({ branchKey: 'CONTROLE_INTERNO', departmentId: 'ci', dueAt: at(30), sequence: 4 }),
        stage({ branchKey: 'JURIDICO', departmentId: 'pj', dueAt: at(50), sequence: 3 }),
      ],
      order,
    );
    expect(fields).toEqual({
      currentDepartmentId: 'pj',
      currentResponsibleId: null,
      currentStageDueAt: at(30),
      status: 'IN_PROGRESS',
      activeStagesCount: 2,
    });
  });

  it('activeStagesOf/activeSplitOf ignoram split e junção e acham a raiz do bloco', () => {
    const split = stage({ stageType: 'PARALLEL_SPLIT' });
    const join = stage({ stageType: 'PARALLEL_JOIN', status: 'COMPLETED' });
    const task = stage({ branchKey: 'X', splitProcessStageId: split.id, sequence: 2 });
    expect(activeStagesOf([split, join, task])).toEqual([task]);
    expect(activeSplitOf([split, join, task])).toBe(split);
  });
});

/* ── Teste de invariante: simulação do runtime com operações aleatórias ───────────────────── */

interface SimBranch {
  readonly splitProcessStageId: string;
  readonly branchKey: string;
  status: ProcessBranchRecord['status'];
}

interface Sim {
  stages: BranchAwareStage[];
  branches: SimBranch[];
  count: number;
  seq: number;
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** As operações do `BranchEngine` em forma de efeito sobre a simulação (mesmas regras). */
function apply(sim: Sim, op: string, pick: () => number): void {
  const split = activeSplitOf(sim.stages);
  const close = (target: BranchAwareStage, status: BranchAwareStage['status']) => {
    sim.stages = sim.stages.map((s) => (s.id === target.id ? { ...s, status } : s));
  };
  const enter = (overrides: Partial<BranchAwareStage>) => {
    sim.seq += 1;
    const entered = stage({ sequence: sim.seq, ...overrides });
    sim.stages.push(entered);
    return entered;
  };
  const recount = () => {
    sim.count = activeStagesOf(sim.stages).length;
  };
  if (split === null) {
    // Tronco: encaminhar para o split com 2, 3 ou 5 ramos (RN-WF2-13).
    if (op !== 'open') return;
    const trunk = sim.stages.find((s) => s.status === 'ACTIVE');
    if (trunk) close(trunk, 'COMPLETED');
    const opened = enter({ stageType: 'PARALLEL_SPLIT' });
    const total = [2, 3, 5][Math.floor(pick() * 3)] ?? 2;
    for (let index = 0; index < total; index += 1) {
      const key = `R${String(index)}`;
      enter({ branchKey: key, splitProcessStageId: opened.id });
      sim.branches.push({ splitProcessStageId: opened.id, branchKey: key, status: 'OPEN' });
    }
    recount();
    return;
  }
  const actives = activeStagesOf(sim.stages).filter((s) => s.splitProcessStageId === split.id);
  const target = actives[Math.floor(pick() * actives.length)];
  if (target === undefined) return;
  const branchOf = (key: string | null) =>
    sim.branches.find((b) => b.splitProcessStageId === split.id && b.branchKey === key);
  if (op === 'advance' || op === 'returnInBranch') {
    close(target, op === 'advance' ? 'COMPLETED' : 'RETURNED');
    enter({
      branchKey: target.branchKey,
      splitProcessStageId: split.id,
      openedByReturn: op === 'returnInBranch',
    });
  } else if (op === 'arrive') {
    close(target, 'COMPLETED');
    const branch = branchOf(target.branchKey);
    if (branch) branch.status = 'ARRIVED';
    const open = sim.branches.filter(
      (b) => b.splitProcessStageId === split.id && b.status === 'OPEN',
    );
    if (open.length === 0) {
      // Junção na mesma operação: join encerrado, split encerrado, etapa seguinte no tronco.
      enter({ stageType: 'PARALLEL_JOIN', status: 'COMPLETED' });
      close(split, 'COMPLETED');
      enter({});
    }
  } else if (op === 'returnBeforeSplit') {
    for (const other of actives) close(other, other.id === target.id ? 'RETURNED' : 'CANCELED');
    for (const branch of sim.branches) {
      if (branch.splitProcessStageId === split.id && branch.status === 'OPEN') {
        branch.status = 'CANCELED';
      }
    }
    close(split, 'RETURNED');
    enter({ openedByReturn: true });
  }
  recount();
}

describe('invariantes do bloco (RN-WF2-21 · 100% das operações)', () => {
  it('depois de cada operação aleatória: um tronco, ≤ 1 por ramo OPEN, sem etapa órfã, contagem certa', () => {
    const operations = ['open', 'advance', 'returnInBranch', 'arrive', 'returnBeforeSplit'];
    for (let seed = 1; seed <= 50; seed += 1) {
      const pick = seeded(seed);
      const sim: Sim = { stages: [stage({ sequence: 1 })], branches: [], count: 1, seq: 1 };
      for (let step = 0; step < 40; step += 1) {
        const op = operations[Math.floor(pick() * operations.length)] ?? 'open';
        apply(sim, op, pick);
        const violations = branchInvariantViolations(
          { activeStagesCount: sim.count, status: 'IN_PROGRESS' },
          sim.stages,
          sim.branches,
        );
        expect(violations, `semente ${String(seed)}, passo ${String(step)} (${op})`).toEqual([]);
      }
    }
  });

  it('acusa etapa órfã, ramo OPEN sem etapa, split sem ramo aberto e contagem errada', () => {
    const split = stage({ stageType: 'PARALLEL_SPLIT' });
    const orphan = stage({ branchKey: 'X', splitProcessStageId: 'outro-split' });
    expect(
      branchInvariantViolations({ activeStagesCount: 1, status: 'IN_PROGRESS' }, [orphan], []),
    ).toContain(`ORPHAN_BRANCH_STAGE:${orphan.id}`);
    expect(
      branchInvariantViolations(
        { activeStagesCount: 0, status: 'IN_PROGRESS' },
        [split],
        [{ splitProcessStageId: split.id, branchKey: 'X', status: 'OPEN' }],
      ),
    ).toEqual(['OPEN_BRANCH_WITHOUT_STAGE:X']);
    expect(
      branchInvariantViolations({ activeStagesCount: 0, status: 'IN_PROGRESS' }, [split], []),
    ).toEqual(['SPLIT_ACTIVE_WITHOUT_OPEN_BRANCH']);
    expect(
      branchInvariantViolations({ activeStagesCount: 2, status: 'IN_PROGRESS' }, [stage()], []),
    ).toEqual(['ACTIVE_STAGES_COUNT_MISMATCH']);
  });
});

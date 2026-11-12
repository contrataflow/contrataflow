import { describe, expect, it } from 'vitest';

import { criticalStageDtoOf, criticalStageOf, isStageOverdue, siblingsOf } from './branch-views.js';
import type { BranchViewBranch, BranchViewStage } from './branch-views.js';
import { isStageMine, parallelSummaryOf } from './parallel-summary.js';
import type { SummaryStageFacts } from './parallel-summary.js';
import { matchesCriteria } from './process-list.js';
import type { ProcessListCriteria, ProcessListFacts } from './process-list.js';

/*
 * US-125 — partes puras das leituras com ramos: `ProcessDeadlineCalculator` (menor `dueAt` e
 * etapa crítica — RN-WF2-34), `SiblingBranchesProjection` (até 3 irmãos, sem pessoas — RN-WF2-30),
 * o painel por etapa (RN-WF2-33) e os filtros da lista por qualquer etapa ativa (RN-WF2-36).
 */

const NOW = new Date('2026-11-16T12:00:00.000Z');
const id = (n: number) => `0192e125-0000-7000-8000-${String(n).padStart(12, '0')}`;

const stage = (n: number, patch: Partial<BranchViewStage> = {}): BranchViewStage => ({
  processStageId: id(n),
  workflowStageId: id(100 + n),
  stageKey: `ETAPA_${String(n)}`,
  stageName: `Etapa ${String(n)}`,
  branchKey: `RAMO_${String(n)}`,
  dueAt: null,
  pausedAt: null,
  overdueSince: null,
  ...patch,
});

const branch = (n: number, patch: Partial<BranchViewBranch> = {}): BranchViewBranch => ({
  branchKey: `RAMO_${String(n)}`,
  branchLabel: `Ramo ${String(n)}`,
  status: 'OPEN',
  arrivedAt: null,
  stageName: `Etapa ${String(n)}`,
  isOverdue: false,
  ...patch,
});

describe('ProcessDeadlineCalculator (RN-WF2-34)', () => {
  it('o prazo do processo é o menor dueAt entre as etapas com prazo; sem nenhum, null', () => {
    const juridico = stage(1, { dueAt: new Date('2026-11-18T02:59:59.999Z') });
    const controle = stage(2, { dueAt: new Date('2026-11-20T02:59:59.999Z') });
    const semSla = stage(3);
    expect(criticalStageOf([controle, semSla, juridico])).toBe(juridico);
    expect(criticalStageOf([semSla])).toBeNull();
    expect(criticalStageOf([])).toBeNull();
    expect(criticalStageDtoOf(juridico)).toEqual({
      processStageId: juridico.processStageId,
      branchKey: 'RAMO_1',
      stageName: 'Etapa 1',
    });
  });

  it('empate: fica a primeira na ordem de entrada (resultado estável)', () => {
    const due = new Date('2026-11-18T02:59:59.999Z');
    const first = stage(1, { dueAt: due });
    expect(criticalStageOf([first, stage(2, { dueAt: due })])).toBe(first);
  });

  it('atraso da etapa: overdueSince marcado ou prazo vencido sem pausa (suspensão não atrasa)', () => {
    const past = new Date('2026-11-15T02:59:59.999Z');
    expect(isStageOverdue(stage(1, { overdueSince: past }), NOW)).toBe(true);
    expect(isStageOverdue(stage(1, { dueAt: past }), NOW)).toBe(true);
    expect(isStageOverdue(stage(1, { dueAt: past, pausedAt: past }), NOW)).toBe(false);
    expect(isStageOverdue(stage(1, { dueAt: new Date('2026-11-20T00:00:00Z') }), NOW)).toBe(false);
  });
});

describe('SiblingBranchesProjection (RN-WF2-30)', () => {
  it('os outros ramos, sem o da linha; até 3 e o excedente em siblingsMore', () => {
    const branches = [1, 2, 3, 4, 5].map((n) => branch(n));
    const { siblings, siblingsMore } = siblingsOf(branches, 'RAMO_2');
    expect(siblings.map((sibling) => sibling.branchKey)).toEqual(['RAMO_1', 'RAMO_3', 'RAMO_4']);
    expect(siblingsMore).toBe(1);
  });

  it('linha do processo (sem ramo): todos os ramos; ramo concluído e atrasado aparecem com a situação', () => {
    const { siblings, siblingsMore } = siblingsOf(
      [branch(1, { status: 'ARRIVED' }), branch(2, { isOverdue: true })],
      null,
    );
    expect(siblings).toEqual([
      {
        branchKey: 'RAMO_1',
        branchLabel: 'Ramo 1',
        stageName: 'Etapa 1',
        status: 'ARRIVED',
        isOverdue: false,
      },
      {
        branchKey: 'RAMO_2',
        branchLabel: 'Ramo 2',
        stageName: 'Etapa 2',
        status: 'OPEN',
        isOverdue: true,
      },
    ]);
    expect(siblingsMore).toBe(0);
  });

  it('só nomes de etapa e situação: nenhum campo de pessoa ou valor', () => {
    const [sibling] = siblingsOf([branch(1)], null).siblings;
    expect(Object.keys(sibling ?? {}).sort()).toEqual([
      'branchKey',
      'branchLabel',
      'isOverdue',
      'stageName',
      'status',
    ]);
  });
});

describe('Painel situacional por etapa (RN-WF2-33)', () => {
  const RITA = id(900);
  const PAULO = id(901);
  const CONTROLE = id(800);
  const PROCURADORIA = id(801);
  const facts = (n: number, patch: Partial<SummaryStageFacts>): SummaryStageFacts => ({
    processStageId: id(n),
    stageKey: `ETAPA_${String(n)}`,
    stageName: `Etapa ${String(n)}`,
    stageType: 'TASK',
    branchKey: `RAMO_${String(n)}`,
    branchLabel: `Ramo ${String(n)}`,
    departmentId: CONTROLE,
    assigneeId: null,
    enteredAt: new Date('2026-11-10T12:00:00.000Z'),
    dueAt: null,
    isOverdue: false,
    openedByReturn: false,
    ...patch,
  });

  it('custódia por etapa: o responsável, ou a fila de uma lotação', () => {
    const viewer = { userId: RITA, departmentIds: [CONTROLE] };
    expect(isStageMine({ assigneeId: RITA, departmentId: PROCURADORIA }, viewer)).toBe(true);
    expect(isStageMine({ assigneeId: PAULO, departmentId: CONTROLE }, viewer)).toBe(false);
    expect(isStageMine({ assigneeId: null, departmentId: CONTROLE }, viewer)).toBe(true);
    expect(isStageMine({ assigneeId: null, departmentId: PROCURADORIA }, viewer)).toBe(false);
  });

  it('a ação primária da minha etapa; nas demais, "Aguardando" com etapa e unidade', () => {
    const summary = parallelSummaryOf({
      status: 'IN_PROGRESS',
      stages: [
        facts(1, { assigneeId: PAULO, departmentId: PROCURADORIA }),
        facts(2, { assigneeId: RITA, departmentId: CONTROLE }),
      ],
      branches: [
        { branchKey: 'RAMO_1', branchLabel: 'Ramo 1', status: 'OPEN', arrivedAt: null },
        {
          branchKey: 'RAMO_3',
          branchLabel: 'Ramo 3',
          status: 'ARRIVED',
          arrivedAt: new Date('2026-11-12T12:00:00.000Z'),
        },
      ],
      viewer: { userId: RITA, departmentIds: [CONTROLE] },
      actions: [
        {
          action: 'FORWARD',
          label: 'Encaminhar',
          enabled: true,
          primary: true,
          reasons: [],
          processStageId: id(1),
        },
        {
          action: 'FORWARD',
          label: 'Encaminhar',
          enabled: true,
          primary: true,
          reasons: [],
          processStageId: id(2),
          transitionKey: 'MINHA',
        },
      ] as never,
      approvals: [],
      departmentName: (departmentId) => (departmentId === CONTROLE ? 'Controle' : 'Procuradoria'),
      userName: (userId) => (userId === RITA ? 'Rita' : 'Paulo'),
    });

    expect(summary.whereStages.map((entry) => [entry.processStageId, entry.isMine])).toEqual([
      [id(1), false],
      [id(2), true],
    ]);
    expect(summary.nextStepByStage[0]).toMatchObject({
      action: null,
      waitingFor: { stageName: 'Etapa 1', departmentName: 'Procuradoria' },
    });
    expect(summary.nextStepByStage[1]).toMatchObject({
      isMine: true,
      action: { action: 'FORWARD', transitionKey: 'MINHA' },
      waitingFor: null,
    });
    expect(summary.responsibleByStage.map((entry) => entry.user?.name)).toEqual(['Paulo', 'Rita']);
    expect(summary.whereBranches[1]).toEqual({
      branchKey: 'RAMO_3',
      branchLabel: 'Ramo 3',
      status: 'ARRIVED',
      arrivedAt: '2026-11-12T12:00:00.000Z',
    });
  });
});

describe('Lista de processos: filtros por qualquer etapa ativa (RN-WF2-36)', () => {
  const CLOCK = {
    now: NOW,
    today: '2026-11-16',
    localDate: (d: Date) => d.toISOString().slice(0, 10),
  };
  const SPLIT = id(500);
  const JURIDICO = id(501);
  const CONTROLE_STAGE = id(502);
  const PROCURADORIA = id(801);
  const CONTROLE = id(800);
  const PAULO = id(901);
  const NONE: ProcessListCriteria = {
    search: null,
    statuses: null,
    stageIdsByKey: null,
    currentWorkflowStageIds: null,
    currentDepartmentIds: null,
    requestingSecretariatIds: null,
    requestingDepartmentIds: null,
    organizationIds: null,
    responsible: null,
    priorities: null,
    contractingTypeIds: null,
    modality: null,
    originIds: null,
    years: null,
    tagIds: null,
    overdue: null,
    targetDateOverdue: null,
    createdFrom: null,
    createdTo: null,
    targetDateFrom: null,
    targetDateTo: null,
    estimatedValueMin: null,
    estimatedValueMax: null,
  };
  const process: ProcessListFacts = {
    id: id(1),
    organizationId: id(2),
    number: 45,
    year: 2026,
    code: '0045/2026',
    internalCode: null,
    title: 'Processo em ramificação',
    object: 'Objeto',
    description: null,
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    requestingSecretariatId: id(3),
    requestingDepartmentId: id(4),
    currentDepartmentId: PROCURADORIA,
    currentResponsibleId: null,
    currentWorkflowStageId: SPLIT,
    currentStageDueAt: null,
    overdueSince: null,
    contractingTypeId: id(5),
    modalityId: null,
    originId: id(6),
    isBudgetConfidential: false,
    estimatedValue: null,
    targetDate: null,
    openedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    tagIds: [],
    branchStages: [
      { workflowStageId: JURIDICO, departmentId: PROCURADORIA, assigneeId: PAULO },
      { workflowStageId: CONTROLE_STAGE, departmentId: CONTROLE, assigneeId: null },
    ],
  };
  const matches = (criteria: Partial<ProcessListCriteria>, facts = process) =>
    matchesCriteria(facts, { ...NONE, ...criteria }, CLOCK, false);

  it('etapa, unidade e responsável casam com o processo OU com qualquer etapa de ramo', () => {
    expect(matches({ currentWorkflowStageIds: [CONTROLE_STAGE] })).toBe(true);
    expect(matches({ stageIdsByKey: [SPLIT] })).toBe(true);
    expect(matches({ currentWorkflowStageIds: [id(999)] })).toBe(false);
    expect(matches({ currentDepartmentIds: [CONTROLE] })).toBe(true);
    expect(matches({ currentDepartmentIds: [id(999)] })).toBe(false);
    expect(matches({ responsible: { ids: [PAULO], none: false } })).toBe(true);
    expect(matches({ responsible: { ids: [], none: true } })).toBe(true);
    expect(matches({ responsible: { ids: [id(999)], none: false } })).toBe(false);
  });

  it('"sem responsável" no paralelismo exige um ramo na fila; fora dele, o MVP 1', () => {
    const allAssigned = {
      ...process,
      branchStages: (process.branchStages ?? []).map((entry) => ({ ...entry, assigneeId: PAULO })),
    };
    expect(matches({ responsible: { ids: [], none: true } }, allAssigned)).toBe(false);
    const trunk = { ...process, branchStages: [], currentResponsibleId: null };
    expect(matches({ responsible: { ids: [], none: true } }, trunk)).toBe(true);
    expect(matches({ currentDepartmentIds: [CONTROLE] }, trunk)).toBe(false);
  });
});

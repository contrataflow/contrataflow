import type { WorkflowStageDto, WorkflowTransitionDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  blockDraftProblems,
  blockRemovalPlan,
  destinationCandidates,
  EMPTY_BLOCK,
  originCandidates,
  parallelBlockPlan,
} from './parallel-block-model';

const stage = (key: string, type: WorkflowStageDto['type'], displayOrder: number) =>
  ({
    id: `s-${key}`,
    key,
    name: key,
    type,
    displayOrder,
    branchKey: null,
  }) as WorkflowStageDto;

const transition = (key: string, from: string, to: string) =>
  ({
    id: `t-${key}`,
    key,
    fromStageId: `s-${from}`,
    toStageId: `s-${to}`,
    version: 1,
  }) as WorkflowTransitionDto;

const STAGES = [
  stage('ABERTURA', 'START', 0),
  stage('ESTUDOS_PRELIMINARES', 'TASK', 1),
  stage('AUTORIZACAO_LICITACAO', 'APPROVAL', 2),
  stage('FIM', 'END', 3),
];

describe('assistente "Adicionar ramificação" (US-123)', () => {
  it('origem só START/TASK; destino só TASK/APPROVAL', () => {
    expect(originCandidates(STAGES).map((item) => item.key)).toEqual([
      'ABERTURA',
      'ESTUDOS_PRELIMINARES',
    ]);
    expect(destinationCandidates(STAGES).map((item) => item.key)).toEqual([
      'ESTUDOS_PRELIMINARES',
      'AUTORIZACAO_LICITACAO',
    ]);
  });

  it('validação local: campos obrigatórios, ramos com nomes distintos', () => {
    expect(blockDraftProblems(EMPTY_BLOCK).map((problem) => problem.field)).toEqual([
      'name',
      'originStageId',
      'destinationStageId',
      'branches.0',
      'branches.1',
    ]);
    const duplicated = blockDraftProblems({
      name: 'Análises',
      originStageId: 's-ESTUDOS_PRELIMINARES',
      destinationStageId: 's-AUTORIZACAO_LICITACAO',
      branches: [{ name: 'Jurídico' }, { name: 'jurídico' }],
    });
    expect(duplicated).toEqual([{ field: 'branches.1', code: 'DUPLICATED' }]);
    expect(
      blockDraftProblems({ ...EMPTY_BLOCK, name: 'Bloco', branches: [{ name: 'Único' }] }),
    ).toContainEqual({ field: 'branches.0', code: 'BRANCHES_MIN' });
  });

  it('plano: ramificação, ramos e junção (sem prazo nem aprovador) e as transições FORWARD', () => {
    const plan = parallelBlockPlan(
      {
        name: 'Análises',
        originStageId: 's-ESTUDOS_PRELIMINARES',
        destinationStageId: 's-AUTORIZACAO_LICITACAO',
        branches: [{ name: 'Jurídico' }, { name: 'Controle interno' }],
      },
      STAGES,
      new Set(),
    );
    expect(plan.stages.map((item) => [item.key, item.type, item.displayOrder])).toEqual([
      ['RAMIFICACAO_ANALISES', 'PARALLEL_SPLIT', 4],
      ['JURIDICO', 'TASK', 5],
      ['CONTROLE_INTERNO', 'TASK', 6],
      ['JUNCAO_ANALISES', 'PARALLEL_JOIN', 7],
    ]);
    expect(plan.stages[0]).toMatchObject({
      name: 'Ramificação — Análises',
      slaDays: null,
      approverType: null,
      documentTypeCodes: [],
      assignmentPolicy: 'UNASSIGNED',
    });
    expect(plan.transitions.map((item) => `${item.fromKey}>${item.toKey}:${item.action}`)).toEqual([
      'ESTUDOS_PRELIMINARES>RAMIFICACAO_ANALISES:FORWARD',
      'RAMIFICACAO_ANALISES>JURIDICO:FORWARD',
      'RAMIFICACAO_ANALISES>CONTROLE_INTERNO:FORWARD',
      'JURIDICO>JUNCAO_ANALISES:FORWARD',
      'CONTROLE_INTERNO>JUNCAO_ANALISES:FORWARD',
      'JUNCAO_ANALISES>AUTORIZACAO_LICITACAO:FORWARD',
    ]);
  });

  it('chaves já usadas na versão ganham sufixo', () => {
    const plan = parallelBlockPlan(
      {
        name: 'Análises',
        originStageId: 's-ESTUDOS_PRELIMINARES',
        destinationStageId: 's-AUTORIZACAO_LICITACAO',
        branches: [{ name: 'Estudos preliminares' }, { name: 'Jurídico' }],
      },
      STAGES,
      new Set(['ESTUDOS_PRELIMINARES_RAMIFICACAO_ANALISES']),
    );
    expect(plan.stages[1]?.key).toBe('ESTUDOS_PRELIMINARES_2');
    expect(plan.transitions[0]?.key).toBe('ESTUDOS_PRELIMINARES_RAMIFICACAO_ANALISES_2');
  });
});

describe('"Remover ramificação" (FA-04)', () => {
  it('lista as transições do bloco e as etapas dos ramos, da ramificação e da junção', () => {
    const stages = [
      ...STAGES,
      stage('RAMIFICACAO', 'PARALLEL_SPLIT', 4),
      stage('JURIDICO', 'TASK', 5),
      stage('CONTROLE', 'TASK', 6),
      stage('JUNCAO', 'PARALLEL_JOIN', 7),
    ];
    const transitions = [
      transition('A', 'ESTUDOS_PRELIMINARES', 'RAMIFICACAO'),
      transition('B', 'RAMIFICACAO', 'JURIDICO'),
      transition('C', 'RAMIFICACAO', 'CONTROLE'),
      transition('D', 'JURIDICO', 'JUNCAO'),
      transition('E', 'CONTROLE', 'JUNCAO'),
      transition('F', 'JUNCAO', 'AUTORIZACAO_LICITACAO'),
      transition('G', 'ABERTURA', 'ESTUDOS_PRELIMINARES'),
    ];
    const plan = blockRemovalPlan(
      {
        splitStageKey: 'RAMIFICACAO',
        joinStageKey: 'JUNCAO',
        branches: [
          {
            branchKey: 'JURIDICO',
            entryStageKey: 'JURIDICO',
            stageKeys: ['JURIDICO'],
            exitTransitionKey: 'D',
          },
          {
            branchKey: 'CONTROLE',
            entryStageKey: 'CONTROLE',
            stageKeys: ['CONTROLE'],
            exitTransitionKey: 'E',
          },
        ],
        issues: [],
      },
      stages,
      transitions,
    );
    expect(plan.transitions.map((item) => item.key)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(plan.stages.map((item) => item.key)).toEqual([
      'RAMIFICACAO',
      'JURIDICO',
      'CONTROLE',
      'JUNCAO',
    ]);
  });
});

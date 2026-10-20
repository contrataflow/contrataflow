import { describe, expect, it } from 'vitest';

import type {
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
} from './workflow-definition.js';
import { stageDeleteBlockers, transitionDeleteBlockers } from './workflow-delete-guard.js';

const stage = (id: string) => ({ id }) as WorkflowStage;
const transition = (id: string, fromStageId: string, toStageId: string) =>
  ({
    id,
    key: id.toUpperCase(),
    name: `Transição ${id}`,
    fromStageId,
    toStageId,
  }) as WorkflowTransition;
const rule = (id: string, scope: { stageId?: string; transitionId?: string }) =>
  ({
    id,
    name: `Regra ${id}`,
    stageId: scope.stageId ?? null,
    transitionId: scope.transitionId ?? null,
  }) as WorkflowRule;

const DEFINITION: WorkflowDefinition = {
  stages: [stage('a'), stage('b'), stage('c'), stage('d')],
  transitions: [transition('ab', 'a', 'b'), transition('bc', 'b', 'c'), transition('ca', 'c', 'a')],
  rules: [rule('r-a', { stageId: 'a' }), rule('r-bc', { transitionId: 'bc' })],
};

describe('RN-WF-50 — exclusão restritiva de etapa e transição (US-043)', () => {
  it('etapa com transições de origem/destino e regras é bloqueada, item a item', () => {
    expect(stageDeleteBlockers(DEFINITION, 'a')).toEqual([
      { kind: 'TRANSITION', id: 'ab', key: 'AB', name: 'Transição ab' },
      { kind: 'TRANSITION', id: 'ca', key: 'CA', name: 'Transição ca' },
      { kind: 'RULE', id: 'r-a', key: null, name: 'Regra r-a' },
    ]);
    expect(stageDeleteBlockers(DEFINITION, 'b').map((blocker) => blocker.id)).toEqual(['ab', 'bc']);
  });

  it('etapa solta pode ser excluída', () => {
    expect(stageDeleteBlockers(DEFINITION, 'd')).toEqual([]);
  });

  it('transição com regra é bloqueada; sem regra, liberada', () => {
    expect(transitionDeleteBlockers(DEFINITION, 'bc')).toEqual([
      { kind: 'RULE', id: 'r-bc', key: null, name: 'Regra r-bc' },
    ]);
    expect(transitionDeleteBlockers(DEFINITION, 'ab')).toEqual([]);
  });
});

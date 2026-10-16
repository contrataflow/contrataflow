import type {
  RuleContextSchemaDto,
  WorkflowRuleDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
} from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  approvalStagesOf,
  conditionOf,
  conditionProblems,
  conditionToJsonLogic,
  EMPTY_RULE,
  fieldTypesOf,
  newConditionRow,
  operatorsFor,
  ruleConfigOf,
  ruleCountOf,
  ruleCreateBody,
  ruleDraftOf,
  ruleDraftProblems,
  rulePatch,
  ruleReorderPatches,
  rulesOf,
  ruleSummaryOf,
  ruleTargets,
  transitionNameOf,
  withRowPath,
} from './workflow-rules-model';
import type { ConditionTree, RuleDraft } from './workflow-rules-model';

/* US-044 — modelo puro do SCR-035: alvos, construtor de condições ↔ JSON Logic, rascunho e corpos. */

const SCHEMA: RuleContextSchemaDto = {
  version: 1,
  fields: [
    { path: 'process.estimatedValue', label: 'Processo — valor estimado', type: 'number' },
    { path: 'process.modalityCode', label: 'Processo — modalidade', type: 'string' },
    {
      path: 'process.isPriceRegistration',
      label: 'Processo — registro de preços',
      type: 'boolean',
    },
    { path: 'process.tags', label: 'Processo — etiquetas', type: 'list' },
    { path: 'process.targetDate', label: 'Processo — data desejada', type: 'date' },
  ],
};
const TYPES = fieldTypesOf(SCHEMA);

const stage = (id: string, key: string, type: WorkflowStageDto['type'], order: number) =>
  ({ id, key, name: key, type, displayOrder: order }) as WorkflowStageDto;
const transition = (id: string, action: WorkflowTransitionDto['action'], order = 0) =>
  ({
    id,
    key: id.toUpperCase(),
    name: `T ${id}`,
    action,
    displayOrder: order,
  }) as WorkflowTransitionDto;

function rule(overrides: Partial<WorkflowRuleDto>): WorkflowRuleDto {
  return {
    id: 'r1',
    workflowVersionId: 'v',
    scope: 'STAGE_EXIT',
    stageId: 's1',
    transitionId: null,
    type: 'REQUIRED_DOCUMENT',
    name: 'ETP completo',
    description: null,
    severity: 'BLOCKING',
    config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
    message: 'O ETP deve estar completo.',
    isActive: true,
    displayOrder: 0,
    version: 1,
    ...overrides,
  };
}

describe('alvos e lista (RN-WF-53 · FA-01)', () => {
  const version = {
    stages: [
      stage('s2', 'APROVACAO', 'APPROVAL', 1),
      stage('s1', 'ESTUDOS', 'TASK', 0),
      stage('s3', 'FIM', 'END', 2),
    ],
    transitions: [
      transition('t1', 'FORWARD'),
      transition('t2', 'RETURN'),
      transition('t3', 'APPROVE', 1),
    ],
  };

  it('saída das etapas (sem END) e transições de avanço/aprovação, na ordem', () => {
    expect(ruleTargets(version).map((target) => `${target.scope}:${target.id}`)).toEqual([
      'STAGE_EXIT:s1',
      'STAGE_EXIT:s2',
      'TRANSITION:t1',
      'TRANSITION:t3',
    ]);
    expect(approvalStagesOf(version.stages).map((item) => item.key)).toEqual(['APROVACAO']);
    expect(transitionNameOf(version.transitions, 't3')).toBe('T t3');
    expect(transitionNameOf(version.transitions, null)).toBe('');
  });

  it('regras do alvo por displayOrder e reordenação com um PATCH por regra que mudou', () => {
    const rules = [
      rule({ id: 'b', name: 'B', displayOrder: 1 }),
      rule({ id: 'a', name: 'A', displayOrder: 0 }),
      rule({ id: 'x', scope: 'TRANSITION', stageId: null, transitionId: 't1' }),
    ];
    const target = { scope: 'STAGE_EXIT' as const, id: 's1', name: 'Estudos' };
    const ordered = rulesOf(rules, target);
    expect(ordered.map((item) => item.id)).toEqual(['a', 'b']);
    expect(ruleCountOf(rules, { scope: 'TRANSITION', id: 't1', name: 'T' })).toBe(1);
    expect(
      ruleReorderPatches(ordered, 1, 0).map((patch) => [patch.rule.id, patch.displayOrder]),
    ).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
    expect(ruleReorderPatches(ordered, 0, 0)).toEqual([]);
    expect(ruleReorderPatches(ordered, 0, 5)).toEqual([]);
  });
});

describe('ConditionBuilder ↔ JSON Logic (RN-WF-58)', () => {
  it('operadores por tipo de campo', () => {
    expect(operatorsFor('number')).toContain('>=');
    expect(operatorsFor('boolean')).toEqual(['==', '!=']);
    expect(operatorsFor('list')).toEqual(['contains', 'filled', 'empty']);
    expect(operatorsFor('string')).not.toContain('>');
    expect(operatorsFor('date')).toContain('<');
  });

  it('gera JSON Logic tipado e volta para a mesma árvore', () => {
    const tree: ConditionTree = {
      combinator: 'or',
      rows: [
        { path: 'process.estimatedValue', operator: '>', value: '100000,5' },
        { path: 'process.isPriceRegistration', operator: '==', value: 'false' },
        { path: 'process.tags', operator: 'contains', value: 'TI' },
        { path: 'process.modalityCode', operator: 'filled', value: '' },
        { path: 'process.targetDate', operator: 'empty', value: '' },
      ],
    };
    const logic = conditionToJsonLogic(tree, TYPES);
    expect(logic).toEqual({
      or: [
        { '>': [{ var: 'process.estimatedValue' }, 100000.5] },
        { '==': [{ var: 'process.isPriceRegistration' }, false] },
        { in: ['TI', { var: 'process.tags' }] },
        { '!!': [{ var: 'process.modalityCode' }] },
        { '!': [{ var: 'process.targetDate' }] },
      ],
    });
    expect(conditionOf(logic)).toEqual({
      ...tree,
      rows: tree.rows.map((row) =>
        row.path === 'process.estimatedValue'
          ? { ...row, value: '100000.5' }
          : row.path === 'process.isPriceRegistration'
            ? { ...row, value: 'false' }
            : row,
      ),
    });
  });

  it('condição única sem combinador vira E; formas não representáveis → null', () => {
    expect(conditionOf({ '==': [{ var: 'process.modalityCode' }, 'PREGAO'] })).toEqual({
      combinator: 'and',
      rows: [{ path: 'process.modalityCode', operator: '==', value: 'PREGAO' }],
    });
    expect(conditionOf({ and: [{ if: [true, 1, 2] }] })).toBeNull();
    expect(conditionOf({ and: 'x' })).toBeNull();
    expect(conditionOf([1])).toBeNull();
    expect(conditionOf({ '==': [{ var: { cat: ['a'] } }, 1] })).toBeNull();
    expect(conditionOf({ '==': [{ var: 'a' }, { var: 'b' }] })).toBeNull();
  });

  it('linhas incompletas ou inválidas viram problemas por posição', () => {
    expect(conditionProblems({ combinator: 'and', rows: [] }, TYPES)).toEqual([
      { field: 'config.expression', code: 'REQUIRED' },
    ]);
    expect(
      conditionProblems(
        {
          combinator: 'and',
          rows: [
            { path: 'process.modalityCode', operator: '==', value: ' ' },
            { path: 'process.estimatedValue', operator: '>', value: 'abc' },
            { path: 'process.inexistente', operator: '==', value: '1' },
            { path: 'process.tags', operator: 'filled', value: '' },
          ],
        },
        TYPES,
      ),
    ).toEqual([
      { field: 'condition.0', code: 'REQUIRED' },
      { field: 'condition.1', code: 'INVALID' },
      { field: 'condition.2', code: 'INVALID' },
    ]);
  });

  it('linha nova usa o primeiro campo; trocar o campo ajusta operador e valor', () => {
    const row = newConditionRow(SCHEMA);
    expect(row).toEqual({ path: 'process.estimatedValue', operator: '==', value: '' });
    expect(
      withRowPath({ ...row, operator: '>' }, 'process.isPriceRegistration', 'boolean'),
    ).toEqual({ path: 'process.isPriceRegistration', operator: '==', value: 'true' });
    expect(withRowPath({ ...row, operator: '==' }, 'process.modalityCode', 'string').operator).toBe(
      '==',
    );
    expect(newConditionRow({ version: 1, fields: [] })).toEqual({
      path: '',
      operator: '==',
      value: '',
    });
  });
});

describe('rascunho, config por tipo e corpos (RN-WF-55..58 · V-01/V-05)', () => {
  const draft = (overrides: Partial<RuleDraft>): RuleDraft => ({
    ...EMPTY_RULE,
    name: 'ETP completo',
    message: 'O ETP deve estar completo.',
    ...overrides,
  });

  it('REQUIRED_DOCUMENT: tipo obrigatório e quantidade mínima ≥ 1', () => {
    expect(ruleConfigOf(draft({}), TYPES)).toEqual({
      ok: false,
      problems: [{ field: 'config.documentTypeCode', code: 'REQUIRED' }],
    });
    expect(ruleConfigOf(draft({ documentTypeCode: 'ETP', minCount: '0' }), TYPES)).toMatchObject({
      ok: false,
    });
    expect(ruleConfigOf(draft({ documentTypeCode: 'ETP', minCount: '2' }), TYPES)).toEqual({
      ok: true,
      config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE', minCount: 2 },
    });
  });

  it('REQUIRED_FIELD, REQUIRED_APPROVAL e CONDITION (construtor e JSON)', () => {
    expect(ruleConfigOf(draft({ type: 'REQUIRED_FIELD', field: ' process.year ' }), TYPES)).toEqual(
      { ok: true, config: { field: 'process.year' } },
    );
    expect(ruleConfigOf(draft({ type: 'REQUIRED_FIELD' }), TYPES).ok).toBe(false);
    expect(
      ruleConfigOf(draft({ type: 'REQUIRED_APPROVAL', stageKey: 'APROVACAO' }), TYPES),
    ).toEqual({ ok: true, config: { stageKey: 'APROVACAO' } });
    expect(ruleConfigOf(draft({ type: 'REQUIRED_APPROVAL' }), TYPES).ok).toBe(false);
    expect(
      ruleConfigOf(
        draft({
          type: 'CONDITION',
          condition: {
            combinator: 'and',
            rows: [{ path: 'process.estimatedValue', operator: '>=', value: '10' }],
          },
        }),
        TYPES,
      ),
    ).toEqual({
      ok: true,
      config: { expression: { and: [{ '>=': [{ var: 'process.estimatedValue' }, 10] }] } },
    });
    expect(ruleConfigOf(draft({ type: 'CONDITION' }), TYPES).ok).toBe(false);
    const json = (conditionJson: string) =>
      ruleConfigOf(draft({ type: 'CONDITION', conditionMode: 'json', conditionJson }), TYPES);
    expect(json('{"if":[true,true,false]}')).toEqual({
      ok: true,
      config: { expression: { if: [true, true, false] } },
    });
    expect(json('{').ok).toBe(false);
    expect(json('1').ok).toBe(false);
  });

  it('V-01/V-05: nome e mensagem obrigatórios e nos limites', () => {
    expect(
      ruleDraftProblems(draft({ name: '', message: '', documentTypeCode: 'ETP' }), TYPES),
    ).toEqual([
      { field: 'name', code: 'REQUIRED' },
      { field: 'message', code: 'REQUIRED' },
    ]);
    expect(
      ruleDraftProblems(
        draft({ name: 'AB', message: 'x'.repeat(501), documentTypeCode: 'ETP' }),
        TYPES,
      ),
    ).toEqual([
      { field: 'name', code: 'NAME_LENGTH' },
      { field: 'message', code: 'MESSAGE_LENGTH' },
    ]);
  });

  it('corpo do WF-16 pelo âmbito do alvo e PATCH só com o que mudou', () => {
    const config = { documentTypeCode: 'ETP', minStatus: 'COMPLETE' };
    expect(
      ruleCreateBody(
        draft({ description: '  ' }),
        { scope: 'TRANSITION', id: 't1', name: 'T' },
        3,
        config,
      ),
    ).toEqual({
      scope: 'TRANSITION',
      stageId: null,
      transitionId: 't1',
      type: 'REQUIRED_DOCUMENT',
      name: 'ETP completo',
      severity: 'BLOCKING',
      config,
      message: 'O ETP deve estar completo.',
      isActive: true,
      displayOrder: 3,
    });
    const current = rule({});
    const same = ruleDraftOf(current);
    expect(rulePatch(current, same, current.config)).toEqual({});
    expect(
      rulePatch(
        current,
        { ...same, severity: 'WARNING', isActive: false, description: 'Art. 18' },
        { ...current.config, minCount: 2 },
      ),
    ).toEqual({
      severity: 'WARNING',
      isActive: false,
      description: 'Art. 18',
      config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE', minCount: 2 },
    });
  });

  it('ruleDraftOf: CONDITION não representável abre em JSON; resumo legível por tipo', () => {
    const advanced = rule({ type: 'CONDITION', config: { expression: { if: [1, 2, 3] } } });
    expect(ruleDraftOf(advanced)).toMatchObject({ conditionMode: 'json' });
    expect(
      ruleDraftOf(
        rule({
          type: 'CONDITION',
          config: { expression: { and: [{ '>': [{ var: 'process.estimatedValue' }, 1] }] } },
        }),
      ),
    ).toMatchObject({ conditionMode: 'builder' });
    expect(
      ruleDraftOf(rule({ config: { documentTypeCode: 'ETP', minStatus: 'X', minCount: 3 } })),
    ).toMatchObject({ minStatus: 'COMPLETE', minCount: '3' });
    expect(
      ruleSummaryOf(rule({ config: { documentTypeCode: 'ETP', minStatus: 'FINAL', minCount: 2 } })),
    ).toBe('ETP · FINAL · ≥ 2');
    expect(ruleSummaryOf({ type: 'REQUIRED_FIELD', config: { field: 'process.year' } })).toBe(
      'process.year',
    );
    expect(ruleSummaryOf({ type: 'REQUIRED_APPROVAL', config: { stageKey: 'APROVACAO' } })).toBe(
      'APROVACAO',
    );
    expect(ruleSummaryOf({ type: 'CONDITION', config: { expression: { '!': [1] } } })).toBe(
      '{"!":[1]}',
    );
  });
});

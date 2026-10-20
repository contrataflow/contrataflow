import type { Violation, WorkflowStageDto, WorkflowTransitionDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  deleteBlockersOf,
  EMPTY_STAGE,
  EMPTY_TRANSITION,
  graphWarnings,
  keyFromName,
  reorderPatches,
  stageCreateBody,
  stageDraftOf,
  stageDraftProblems,
  stagePatch,
  transitionCreateBody,
  transitionDraftOf,
  transitionDraftProblems,
  transitionPatch,
  uniqueKey,
  withForcedComment,
  workflowKeyProblems,
} from './workflow-editor-model';

function stage(overrides: Partial<WorkflowStageDto>): WorkflowStageDto {
  return {
    id: 'stage-1',
    workflowVersionId: 'version-1',
    key: 'ABERTURA',
    name: 'Abertura',
    instructions: null,
    type: 'TASK',
    groupLabel: null,
    displayOrder: 0,
    departmentResolution: 'REQUESTING_DEPARTMENT',
    fixedDepartmentId: null,
    assignmentPolicy: 'UNASSIGNED',
    approverType: null,
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentResolution: null,
    approverFixedDepartmentId: null,
    allowDeputy: true,
    approvalDocumentTypeCodes: [],
    documentTypeCodes: [],
    slaDays: null,
    slaType: 'BUSINESS',
    color: null,
    version: 1,
    ...overrides,
  };
}

function transition(overrides: Partial<WorkflowTransitionDto>): WorkflowTransitionDto {
  return {
    id: 'transition-1',
    workflowVersionId: 'version-1',
    key: 'ENCAMINHAR',
    name: 'Encaminhar',
    description: null,
    fromStageId: 'a',
    toStageId: 'b',
    action: 'FORWARD',
    displayOrder: 0,
    isPrimary: false,
    requiresComment: false,
    allowDueDateOverride: true,
    version: 1,
    ...overrides,
  };
}

describe('chave sugerida (RN-WF-45)', () => {
  it('SCREAMING_SNAKE_CASE sem acentos, sem prefixo numérico e com no máximo 60', () => {
    expect(keyFromName('Parecer jurídico')).toBe('PARECER_JURIDICO');
    expect(keyFromName('  1ª análise — técnica  ')).toBe('ANALISE_TECNICA');
    expect(keyFromName('x'.repeat(80))).toHaveLength(60);
    expect(keyFromName('')).toBe('');
  });

  it('sufixo quando a chave já existe na versão', () => {
    expect(uniqueKey('ANALISE', new Set(['ANALISE', 'ANALISE_2']))).toBe('ANALISE_3');
    expect(uniqueKey('NOVA', new Set(['ANALISE']))).toBe('NOVA');
  });

  it('chave do workflow com ao menos 3 caracteres', () => {
    expect(workflowKeyProblems('OB')).toEqual([{ field: 'key', code: 'KEY_PATTERN' }]);
    expect(workflowKeyProblems('')).toEqual([{ field: 'key', code: 'REQUIRED' }]);
    expect(workflowKeyProblems('OBRAS')).toEqual([]);
  });
});

describe('validação local da etapa (V-01..V-04)', () => {
  it('[Validação] aprovação sem aprovador: "Selecione quem aprova esta etapa."', () => {
    const problems = stageDraftProblems({
      ...EMPTY_STAGE,
      key: 'APROVACAO',
      name: 'Aprovação',
      type: 'APPROVAL',
    });
    expect(problems).toEqual([
      { field: 'approverType', code: 'SHARED', message: 'Selecione quem aprova esta etapa.' },
    ]);
  });

  it('unidade fixa sem unidade, SLA fora da faixa, nome curto e chave inválida', () => {
    const problems = stageDraftProblems({
      ...EMPTY_STAGE,
      key: 'abc',
      name: 'Ab',
      departmentResolution: 'FIXED',
      slaDays: '400',
      color: 'azul',
    });
    expect(problems.map((problem) => [problem.field, problem.code])).toEqual([
      ['key', 'KEY_PATTERN'],
      ['name', 'NAME_LENGTH'],
      ['slaDays', 'SLA_RANGE'],
      ['color', 'SHARED'],
      ['fixedDepartmentId', 'SHARED'],
    ]);
    expect(problems.find((problem) => problem.field === 'fixedDepartmentId')?.message).toBe(
      'Selecione a unidade responsável.',
    );
  });

  it('titular aprovador exige a resolução da unidade', () => {
    const problems = stageDraftProblems({
      ...EMPTY_STAGE,
      key: 'APROVACAO',
      name: 'Aprovação',
      type: 'APPROVAL',
      approverType: 'DEPARTMENT_HEAD',
    });
    expect(problems.map((problem) => problem.field)).toEqual(['approverDepartmentResolution']);
  });

  it('etapa válida não tem problemas; END ignora o SLA', () => {
    expect(
      stageDraftProblems({ ...EMPTY_STAGE, key: 'FIM', name: 'Fim', type: 'END', slaDays: '0' }),
    ).toEqual([]);
  });
});

describe('corpo do WF-10 e PATCH do WF-11', () => {
  it('normaliza: campos de aprovador só em APPROVAL e nulos onde vazio', () => {
    const body = stageCreateBody(
      {
        ...EMPTY_STAGE,
        key: 'PARECER',
        name: 'Parecer',
        approverType: 'USER',
        approverUserId: 'user-1',
        slaDays: '5',
        documentTypeCodes: ['DFD'],
      },
      3,
    );
    expect(body).toMatchObject({
      key: 'PARECER',
      type: 'TASK',
      displayOrder: 3,
      approverType: null,
      approverUserId: null,
      slaDays: 5,
      instructions: null,
      documentTypeCodes: ['DFD'],
    });
    expect('groupLabel' in body).toBe(false);
  });

  it('só o que mudou, sem a chave (imutável)', () => {
    const current = stage({ slaDays: 5 });
    expect(stagePatch(current, stageDraftOf(current))).toEqual({});
    expect(
      stagePatch(current, {
        ...stageDraftOf(current),
        key: 'OUTRA',
        name: 'Abertura do processo',
        slaDays: '',
      }),
    ).toEqual({ name: 'Abertura do processo', slaDays: null });
    expect(
      stagePatch(current, {
        ...stageDraftOf(current),
        type: 'APPROVAL',
        approverType: 'ROLE',
        approverRoleId: 'role-1',
      }),
    ).toEqual({ type: 'APPROVAL', approverType: 'ROLE', approverRoleId: 'role-1' });
  });
});

describe('FA-04 · RN-WF-52 — reordenação contígua', () => {
  const stages = [
    stage({ id: 'a', key: 'A', displayOrder: 0 }),
    stage({ id: 'b', key: 'B', displayOrder: 1 }),
    stage({ id: 'c', key: 'C', displayOrder: 2 }),
  ];

  it('um PATCH por etapa que mudou de posição', () => {
    expect(
      reorderPatches(stages, 2, 0).map(({ stage: item, displayOrder }) => [item.id, displayOrder]),
    ).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
    expect(
      reorderPatches(stages, 0, 1).map(({ stage: item, displayOrder }) => [item.id, displayOrder]),
    ).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
  });

  it('corrige buracos na sequência e ignora posições inválidas', () => {
    const gapped = [
      stage({ id: 'a', key: 'A', displayOrder: 0 }),
      stage({ id: 'b', key: 'B', displayOrder: 5 }),
    ];
    expect(reorderPatches(gapped, 1, 0).map(({ displayOrder }) => displayOrder)).toEqual([0, 1]);
    expect(reorderPatches(stages, 0, 0)).toEqual([]);
    expect(reorderPatches(stages, 0, 9)).toEqual([]);
  });
});

describe('avisos incrementais do grafo (passo 7)', () => {
  const start = stage({ id: 's', key: 'S', type: 'START', displayOrder: 0 });
  const task = stage({ id: 't', key: 'T', type: 'TASK', displayOrder: 1 });
  const orphan = stage({ id: 'o', key: 'O', type: 'TASK', displayOrder: 2 });
  const end = stage({ id: 'e', key: 'E', type: 'END', displayOrder: 3 });

  it('sem saída e inalcançável a partir do START (RETURN não conta para alcançar)', () => {
    expect(
      graphWarnings(
        [start, task, orphan, end],
        [
          transition({ fromStageId: 's', toStageId: 't', action: 'FORWARD' }),
          transition({ fromStageId: 't', toStageId: 'e', action: 'COMPLETE' }),
          transition({ fromStageId: 'o', toStageId: 's', action: 'RETURN' }),
        ],
      ),
    ).toEqual([{ kind: 'UNREACHABLE', stageId: 'o' }]);
    expect(graphWarnings([start, task], [])).toEqual([
      { kind: 'NO_EXIT', stageId: 's' },
      { kind: 'NO_EXIT', stageId: 't' },
      { kind: 'UNREACHABLE', stageId: 't' },
    ]);
  });

  it('sem START avisa uma vez; sem etapas, nada', () => {
    expect(graphWarnings([end], [])).toEqual([{ kind: 'NO_START' }]);
    expect(graphWarnings([], [])).toEqual([]);
  });
});

describe('transição (V-05 · RN-WF-49)', () => {
  it('origem igual ao destino e obrigatórios', () => {
    expect(
      transitionDraftProblems({
        ...EMPTY_TRANSITION,
        key: 'LACO',
        name: 'Laço',
        fromStageId: 'a',
        toStageId: 'a',
      }),
    ).toEqual([
      {
        field: 'toStageId',
        code: 'SHARED',
        message: 'A etapa de origem deve ser diferente da etapa de destino.',
      },
    ]);
    expect(transitionDraftProblems(EMPTY_TRANSITION).map((problem) => problem.field)).toEqual([
      'key',
      'name',
      'fromStageId',
      'toStageId',
    ]);
  });

  it('RETURN força comentário no corpo e no PATCH', () => {
    const draft = {
      ...EMPTY_TRANSITION,
      key: 'DEVOLVER',
      name: 'Devolver',
      fromStageId: 'b',
      toStageId: 'a',
      action: 'RETURN' as const,
    };
    expect(withForcedComment(draft).requiresComment).toBe(true);
    expect(transitionCreateBody(draft, 2)).toMatchObject({
      requiresComment: true,
      displayOrder: 2,
    });
    const current = transition({});
    expect(transitionPatch(current, transitionDraftOf(current))).toEqual({});
    expect(transitionPatch(current, { ...transitionDraftOf(current), action: 'RETURN' })).toEqual({
      action: 'RETURN',
      requiresComment: true,
    });
  });
});

describe('FA-01 — itens que bloqueiam a exclusão', () => {
  it('lê as violations do 422 BUSINESS_RULE_VIOLATION', () => {
    const violation = (params: Record<string, unknown>): Violation => ({
      code: 'REFERENCED_BY_TRANSITION',
      severity: 'BLOCKING',
      message: 'Remova primeiro as transições que usam esta etapa.',
      ruleId: 'RN-WF-50',
      sectionKey: null,
      field: null,
      itemId: 'transition-1',
      params,
    });
    expect(
      deleteBlockersOf([
        violation({ kind: 'TRANSITION', key: 'ENCAMINHAR', name: 'Encaminhar' }),
        violation({}),
      ]),
    ).toEqual([{ id: 'transition-1', kind: 'TRANSITION', name: 'Encaminhar' }]);
  });
});

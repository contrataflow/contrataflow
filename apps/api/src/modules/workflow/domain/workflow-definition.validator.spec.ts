import { STAGE_TYPES, TRANSITION_ACTIONS } from '@contrataflow/validation';
import type { StageType, TransitionAction } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { actionAllowedFrom, actionAllowedTo } from './workflow-definition.js';
import { WorkflowDefinitionValidator } from './workflow-definition.validator.js';
import type { WorkflowReferences } from './workflow-definition.validator.js';
import {
  DefinitionBuilder,
  openReferences,
  replaceAt,
  validFourStageWorkflow,
} from '../../../../test/support/workflow-fixtures.js';

const validator = new WorkflowDefinitionValidator();
const USER = '0192c000-0000-7000-8000-00000000a0a1';
const ROLE = '0192c000-0000-7000-8000-00000000a0b1';
const DEPT = '0192c000-0000-7000-8000-00000000a0c1';

const run = (builder: DefinitionBuilder, references: WorkflowReferences = openReferences()) =>
  validator.validate(builder.build(), references);
const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

describe('WorkflowDefinitionValidator (US-040 · RN-WF-07..19)', () => {
  it('o fluxo válido de 4 etapas não tem erros nem avisos', () => {
    expect(run(validFourStageWorkflow())).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('[Validação] PARECER inalcançável e APROVACAO sem REJECT: todos os erros numa execução', () => {
    const builder = validFourStageWorkflow(new DefinitionBuilder());
    builder.stage('PARECER', 'TASK');
    builder.transition('PARECER', 'APROVACAO', 'FORWARD');
    const rejectIndex = builder.transitions.findIndex((t) => t.action === 'REJECT');
    builder.transitions.splice(rejectIndex, 1);

    const result = run(builder);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'WF_STAGE_UNREACHABLE', stageKey: 'PARECER' }),
        expect.objectContaining({ code: 'WF_APPROVAL_TRANSITIONS', stageKey: 'APROVACAO' }),
      ]),
    );
    expect(result.errors.find((e) => e.code === 'WF_STAGE_UNREACHABLE')?.message).toBe(
      'A etapa Etapa PARECER não pode ser alcançada a partir da etapa inicial.',
    );
  });

  it('WF_START_STAGE_COUNT e WF_END_STAGE_MISSING (nenhuma START, nenhuma END)', () => {
    const result = run(new DefinitionBuilder().stage('A', 'TASK'));
    expect(codes(result.errors)).toEqual(['WF_START_STAGE_COUNT', 'WF_END_STAGE_MISSING']);
    const twoStarts = validFourStageWorkflow().stage('OUTRA', 'START');
    expect(codes(run(twoStarts).errors)).toContain('WF_START_STAGE_COUNT');
  });

  it('WF_END_UNREACHABLE: ciclo sem saída para o fim', () => {
    const builder = validFourStageWorkflow()
      .stage('LOOP_A', 'TASK')
      .stage('LOOP_B', 'TASK')
      .transition('ABERTURA', 'LOOP_A', 'FORWARD')
      .transition('LOOP_A', 'LOOP_B', 'FORWARD')
      .transition('LOOP_B', 'LOOP_A', 'FORWARD');
    const result = run(builder);
    expect(
      result.errors.filter((e) => e.code === 'WF_END_UNREACHABLE').map((e) => e.stageKey),
    ).toEqual(['LOOP_A', 'LOOP_B']);
  });

  it('WF_ACTION_NOT_ALLOWED_FROM_STAGE e WF_TRANSITION_TARGET_INVALID (tipos e "anterior")', () => {
    const builder = validFourStageWorkflow()
      .stage('EXTRA', 'TASK')
      .transition('FIM', 'EXTRA', 'FORWARD')
      .transition('ANALISE', 'FIM', 'FORWARD')
      .transition('EXTRA', 'FIM', 'COMPLETE')
      .transition('ABERTURA', 'EXTRA', 'FORWARD')
      // Devolução "para a frente": EXTRA não alcança ANALISE por avanço.
      .transition('ANALISE', 'EXTRA', 'RETURN');
    const result = run(builder);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'WF_ACTION_NOT_ALLOWED_FROM_STAGE',
          transitionKey: 'FIM_FORWARD_EXTRA',
        }),
        expect.objectContaining({
          code: 'WF_TRANSITION_TARGET_INVALID',
          transitionKey: 'ANALISE_FORWARD_FIM',
        }),
        expect.objectContaining({
          code: 'WF_TRANSITION_TARGET_INVALID',
          transitionKey: 'ANALISE_RETURN_EXTRA',
        }),
      ]),
    );
  });

  it('WF_PRIMARY_DUPLICATED: duas ações principais de avanço na mesma etapa', () => {
    const builder = validFourStageWorkflow()
      .stage('OUTRA', 'TASK')
      .transition('ABERTURA', 'OUTRA', 'FORWARD', { isPrimary: true })
      .transition('OUTRA', 'FIM', 'COMPLETE');
    expect(run(builder).errors).toEqual([
      expect.objectContaining({ code: 'WF_PRIMARY_DUPLICATED', stageKey: 'ABERTURA' }),
    ]);
  });

  it('WF_DOCUMENT_TYPE_UNKNOWN: código inativo em etapa e em REQUIRED_DOCUMENT (FA-05)', () => {
    const references = openReferences({ activeDocumentTypeCodes: new Set(['ETP', 'TR']) });
    const result = run(validFourStageWorkflow(), references);
    expect(result.errors.filter((e) => e.code === 'WF_DOCUMENT_TYPE_UNKNOWN')).toEqual([
      expect.objectContaining({
        stageKey: 'ABERTURA',
        message: expect.stringMatching(/DFD/) as unknown,
      }),
      expect.objectContaining({ stageKey: 'APROVACAO' }),
      expect.objectContaining({ ruleId: expect.any(String) as unknown }),
    ]);
  });

  it('WF_APPROVER_UNRESOLVABLE (usuário, perfil, unidade) e WF_APPROVER_HEAD_MISSING (aviso)', () => {
    const withApprover = (overrides: object) => {
      const builder = validFourStageWorkflow();
      const index = builder.stages.findIndex((stage) => stage.key === 'APROVACAO');
      replaceAt(builder.stages, index, overrides as never);
      return builder;
    };
    const user = { approverType: 'USER', approverDepartmentResolution: null, approverUserId: USER };
    expect(codes(run(withApprover(user)).errors)).toEqual(['WF_APPROVER_UNRESOLVABLE']);
    expect(run(withApprover(user), openReferences({ activeUserIds: new Set([USER]) })).valid).toBe(
      true,
    );

    const role = { approverType: 'ROLE', approverDepartmentResolution: null, approverRoleId: ROLE };
    expect(codes(run(withApprover(role)).errors)).toEqual(['WF_APPROVER_UNRESOLVABLE']);
    const noDecide = openReferences({
      roles: new Map([[ROLE, { isActive: true, canDecideApprovals: false }]]),
    });
    expect(codes(run(withApprover(role), noDecide).errors)).toEqual(['WF_APPROVER_UNRESOLVABLE']);
    const decides = openReferences({
      roles: new Map([[ROLE, { isActive: true, canDecideApprovals: true }]]),
    });
    expect(run(withApprover(role), decides).valid).toBe(true);

    const fixed = { approverDepartmentResolution: 'FIXED', approverFixedDepartmentId: DEPT };
    expect(codes(run(withApprover(fixed)).errors)).toEqual(['WF_APPROVER_UNRESOLVABLE']);
    const headless = openReferences({
      departments: new Map([[DEPT, { isActive: true, headUserId: null }]]),
    });
    const result = run(withApprover(fixed), headless);
    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toEqual(['WF_APPROVER_HEAD_MISSING']);

    expect(codes(run(withApprover({ approverType: null })).errors)).toEqual([
      'WF_APPROVER_UNRESOLVABLE',
    ]);
    expect(codes(run(withApprover({ approverDepartmentResolution: null })).errors)).toEqual([
      'WF_APPROVER_UNRESOLVABLE',
    ]);
  });

  it('WF_DEPARTMENT_INVALID: unidade fixa inexistente ou inativa', () => {
    const builder = validFourStageWorkflow();
    replaceAt(builder.stages, 1, { departmentResolution: 'FIXED', fixedDepartmentId: DEPT });
    expect(codes(run(builder).errors)).toEqual(['WF_DEPARTMENT_INVALID']);
    const inactive = openReferences({
      departments: new Map([[DEPT, { isActive: false, headUserId: USER }]]),
    });
    expect(codes(run(builder, inactive).errors)).toEqual(['WF_DEPARTMENT_INVALID']);
    const active = openReferences({
      departments: new Map([[DEPT, { isActive: true, headUserId: USER }]]),
    });
    expect(run(builder, active).valid).toBe(true);
  });

  it('WF_RULE_* : configuração, caminho, operação e escopo (FA-04)', () => {
    const builder = validFourStageWorkflow()
      .rule('REQUIRED_FIELD', { field: 'process.internalCode' }, { stage: 'ANALISE' })
      .rule('CONDITION', { expression: { method: ['x', 'trim'] } }, { stage: 'ANALISE' })
      .rule('REQUIRED_DOCUMENT', { minStatus: 'EXISTS' }, { stage: 'ANALISE' })
      .rule('REQUIRED_FIELD', { field: 'process.year' }, { stage: 'FIM' })
      .rule('REQUIRED_FIELD', { field: 'process.year' }, { transition: 'ANALISE_RETURN_ABERTURA' })
      .rule('REQUIRED_APPROVAL', { stageKey: 'ANALISE' }, { stage: 'ANALISE' });
    const result = run(builder);
    expect(codes(result.errors)).toEqual([
      'WF_RULE_PATH_UNKNOWN',
      'WF_RULE_OPERATOR_FORBIDDEN',
      'WF_RULE_CONFIG_INVALID',
      'WF_RULE_SCOPE_INVALID',
      'WF_RULE_SCOPE_INVALID',
      'WF_RULE_SCOPE_INVALID',
    ]);
    expect(result.errors[0]?.message).toMatch(/^A regra Regra REQUIRED_FIELD está inválida: /);

    // FA-04: etapa APPROVAL referenciada por REQUIRED_APPROVAL excluída do rascunho.
    const orphan = validFourStageWorkflow();
    replaceAt(orphan.rules, 1, { config: { stageKey: 'APROVACAO_X' } });
    expect(codes(run(orphan).errors)).toEqual(['WF_RULE_SCOPE_INVALID']);

    // Alvo inexistente (etapa/transição removida da versão).
    const missing = validFourStageWorkflow();
    replaceAt(missing.rules, 0, { stageId: DEPT });
    replaceAt(missing.rules, 1, { transitionId: DEPT });
    expect(codes(run(missing).errors)).toEqual(['WF_RULE_SCOPE_INVALID', 'WF_RULE_SCOPE_INVALID']);
  });

  it('WF_LIMIT_EXCEEDED: mais de 50 etapas', () => {
    const builder = new DefinitionBuilder();
    for (let index = 0; index < 51; index += 1) builder.stage(`E_${index}`, 'TASK');
    expect(codes(run(builder).errors)).toContain('WF_LIMIT_EXCEEDED');
  });

  it('avisos: sem SLA, sem orientação e regra inativa — não bloqueiam', () => {
    const builder = validFourStageWorkflow();
    replaceAt(builder.stages, 1, { slaDays: null, instructions: '  ' });
    replaceAt(builder.rules, 2, { isActive: false });
    const result = run(builder);
    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toEqual([
      'WF_STAGE_NO_SLA',
      'WF_STAGE_NO_INSTRUCTIONS',
      'WF_RULE_INACTIVE',
    ]);
  });

  it('transição com etapa fora da versão → WF_TRANSITION_TARGET_INVALID', () => {
    const builder = validFourStageWorkflow();
    replaceAt(builder.transitions, 0, { toStageId: DEPT });
    expect(codes(run(builder).errors)).toContain('WF_TRANSITION_TARGET_INVALID');
  });
});

describe('compatibilidade ação × tipo de etapa (RN-WF-10 — tabela completa)', () => {
  const sources: Record<TransitionAction, readonly StageType[]> = {
    FORWARD: ['START', 'TASK'],
    COMPLETE: ['START', 'TASK'],
    APPROVE: ['APPROVAL'],
    RETURN: ['TASK', 'APPROVAL'],
    REJECT: ['APPROVAL'],
  };
  const targets: Record<TransitionAction, readonly StageType[]> = {
    FORWARD: ['TASK', 'APPROVAL'],
    COMPLETE: ['END'],
    APPROVE: ['TASK', 'APPROVAL', 'END'],
    RETURN: ['START', 'TASK'],
    REJECT: ['START', 'TASK'],
  };
  for (const action of TRANSITION_ACTIONS) {
    for (const type of STAGE_TYPES) {
      it(`${action} de ${type}: ${sources[action].includes(type)}; para ${type}: ${targets[action].includes(type)}`, () => {
        expect(actionAllowedFrom(action, type)).toBe(sources[action].includes(type));
        expect(actionAllowedTo(action, type)).toBe(targets[action].includes(type));
      });
    }
  }
  it('END não tem transição de saída', () => {
    expect(TRANSITION_ACTIONS.some((action) => actionAllowedFrom(action, 'END'))).toBe(false);
  });
});

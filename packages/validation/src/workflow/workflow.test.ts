import { describe, expect, it } from 'vitest';

import { WorkflowCreated, WorkflowVersionPublished, WorkflowVersionRetired } from './events.js';
import { inspectJsonLogic, JSON_LOGIC_MAX_DEPTH } from './json-logic.js';
import {
  isRuleContextPath,
  RULE_CONTEXT_V1_PATHS,
  ruleContextFields,
  ruleContextSchemaDtoSchema,
} from './rule-context.js';
import {
  restrictedMarkdownProblem,
  ruleConfigProblems,
  workflowCreateSchema,
  workflowRuleSchema,
  workflowRuleTestSchema,
  workflowStageIssues,
  workflowStageSchema,
  workflowTransitionSchema,
  workflowVersionCreateSchema,
} from './workflow.js';
import type { WorkflowStageFields } from './workflow.js';

const ID = '0192c000-0000-7000-8000-000000000a01';
const ID2 = '0192c000-0000-7000-8000-000000000a02';

const codesOf = (result: { success: boolean; error?: { issues: readonly unknown[] } }) =>
  (result.error?.issues ?? []).map((issue) => {
    const { path, params } = issue as { path: PropertyKey[]; params?: { code?: string } };
    return `${path.join('.')}:${params?.code ?? (issue as { code: string }).code}`;
  });

const stage = (overrides: Partial<WorkflowStageFields> = {}): WorkflowStageFields => ({
  key: 'ANALISE',
  name: 'Análise',
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
  ...overrides,
});

describe('workflowCreateSchema (WF-02 · RN-WF-02)', () => {
  it('aceita chave em maiúsculas e recusa chave curta, minúscula ou nome curto', () => {
    expect(
      workflowCreateSchema.safeParse({ key: 'OBRAS_ENGENHARIA', name: 'Obras e engenharia' })
        .success,
    ).toBe(true);
    for (const key of ['OB', 'obras', '1OBRAS', `A${'B'.repeat(60)}`]) {
      expect(workflowCreateSchema.safeParse({ key, name: 'Nome válido' }).success).toBe(false);
    }
    expect(workflowCreateSchema.safeParse({ key: 'OBRAS', name: 'ab' }).success).toBe(false);
  });

  it('WF-08 aceita corpo ausente (padrão: a publicada corrente)', () => {
    expect(workflowVersionCreateSchema.parse(undefined)).toEqual({});
  });
});

describe('workflowStageIssues (RN-WF-08)', () => {
  it('etapa de tarefa padrão não tem problemas', () => {
    expect(workflowStageIssues(stage())).toEqual([]);
  });

  it.each([
    [stage({ type: 'APPROVAL' }), 'approverType', 'CONDITIONAL_REQUIRED'],
    [stage({ type: 'APPROVAL', approverType: 'USER' }), 'approverUserId', 'CONDITIONAL_REQUIRED'],
    [stage({ type: 'APPROVAL', approverType: 'ROLE' }), 'approverRoleId', 'CONDITIONAL_REQUIRED'],
    [
      stage({ type: 'APPROVAL', approverType: 'DEPARTMENT_HEAD' }),
      'approverDepartmentResolution',
      'CONDITIONAL_REQUIRED',
    ],
    [
      stage({
        type: 'APPROVAL',
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'FIXED',
      }),
      'approverFixedDepartmentId',
      'CONDITIONAL_REQUIRED',
    ],
    [
      stage({ type: 'APPROVAL', approverType: 'USER', approverUserId: ID, approverRoleId: ID2 }),
      'approverRoleId',
      'NOT_ALLOWED',
    ],
    [
      stage({ type: 'APPROVAL', approverType: 'ROLE', approverRoleId: ID, approverUserId: ID2 }),
      'approverUserId',
      'NOT_ALLOWED',
    ],
    [
      stage({
        type: 'APPROVAL',
        approverType: 'USER',
        approverUserId: ID,
        approverDepartmentResolution: 'FIXED',
        approverFixedDepartmentId: ID2,
      }),
      'approverDepartmentResolution',
      'NOT_ALLOWED',
    ],
    [stage({ approverType: 'USER' }), 'approverType', 'NOT_ALLOWED'],
    [stage({ approvalDocumentTypeCodes: ['DFD'] }), 'approvalDocumentTypeCodes', 'NOT_ALLOWED'],
    [stage({ departmentResolution: 'FIXED' }), 'fixedDepartmentId', 'CONDITIONAL_REQUIRED'],
    [stage({ fixedDepartmentId: ID }), 'fixedDepartmentId', 'NOT_ALLOWED'],
    [
      stage({ type: 'START', departmentResolution: 'CHOSEN_ON_FORWARD' }),
      'departmentResolution',
      'NOT_ALLOWED',
    ],
    [stage({ type: 'END', slaDays: 5 }), 'slaDays', 'NOT_ALLOWED'],
  ])('acusa %#: %s em %s', (input, field, code) => {
    expect(workflowStageIssues(input)).toContainEqual(expect.objectContaining({ field, code }));
  });

  it('aprovador titular de unidade fixa completo e com documentos cobertos é válido', () => {
    expect(
      workflowStageIssues(
        stage({
          type: 'APPROVAL',
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'FIXED',
          approverFixedDepartmentId: ID,
          approvalDocumentTypeCodes: ['DFD'],
        }),
      ),
    ).toEqual([]);
  });
});

describe('workflowStageSchema (WF-10)', () => {
  it('aplica os padrões e recusa formato inválido (cor, SLA, chave)', () => {
    const parsed = workflowStageSchema.parse({ key: 'ABERTURA', name: 'Abertura', type: 'START' });
    expect(parsed).toMatchObject({
      departmentResolution: 'REQUESTING_DEPARTMENT',
      assignmentPolicy: 'UNASSIGNED',
      allowDeputy: true,
      slaType: 'BUSINESS',
      documentTypeCodes: [],
    });
    const invalid = workflowStageSchema.safeParse({
      key: 'abertura',
      name: 'Abertura',
      type: 'TASK',
      color: 'red',
      slaDays: 400,
    });
    expect(codesOf(invalid)).toEqual(
      expect.arrayContaining(['key:invalid_format', 'color:invalid_format', 'slaDays:too_big']),
    );
  });

  it('aprovação sem aprovador → CONDITIONAL_REQUIRED em approverType', () => {
    const result = workflowStageSchema.safeParse({
      key: 'APROVA',
      name: 'Aprovar',
      type: 'APPROVAL',
    });
    expect(codesOf(result)).toEqual(['approverType:CONDITIONAL_REQUIRED']);
  });
});

describe('restrictedMarkdownProblem (RN-WF-18)', () => {
  it('aceita Markdown com links https e recusa HTML, http e javascript:', () => {
    expect(restrictedMarkdownProblem('Veja [o manual](https://exemplo.gov.br/manual).')).toBeNull();
    expect(restrictedMarkdownProblem('Texto **forte** e [âncora](#topo).')).toBeNull();
    expect(restrictedMarkdownProblem('<script>alert(1)</script>')).toMatch(/HTML/);
    expect(restrictedMarkdownProblem('[link](http://inseguro.com)')).toMatch(/https/);
    expect(restrictedMarkdownProblem('[x](javascript:alert(1))')).toMatch(/https/);
    expect(restrictedMarkdownProblem('Acesse <http://exemplo.com>')).toMatch(/HTML|https/);
  });
});

describe('workflowTransitionSchema (WF-13 · RN-WF-09)', () => {
  it('origem igual ao destino → NOT_ALLOWED em toStageId', () => {
    const result = workflowTransitionSchema.safeParse({
      key: 'VOLTA',
      name: 'Volta',
      fromStageId: ID,
      toStageId: ID,
      action: 'FORWARD',
    });
    expect(codesOf(result)).toEqual(['toStageId:NOT_ALLOWED']);
  });
});

describe('RuleContext v1 e regras (RN-WF-17)', () => {
  it('conhece os caminhos folha estáticos e os de documentos por código', () => {
    expect(RULE_CONTEXT_V1_PATHS).toContain('process.estimatedValue');
    expect(isRuleContextPath('process.estimatedValue')).toBe(true);
    expect(isRuleContextPath('documents.DFD.isComplete')).toBe(true);
    expect(isRuleContextPath('process.internalCode')).toBe(false);
    expect(isRuleContextPath('process')).toBe(false);
    expect(isRuleContextPath('documents.dfd.exists')).toBe(false);
  });

  it('CONDITION com `method` → operação proibida; REQUIRED_FIELD fora do contexto → caminho desconhecido', () => {
    expect(
      ruleConfigProblems('CONDITION', {
        expression: { method: [{ var: 'process.title' }, 'toUpperCase'] },
      }),
    ).toEqual([expect.objectContaining({ code: 'WF_RULE_OPERATOR_FORBIDDEN' })]);
    expect(ruleConfigProblems('REQUIRED_FIELD', { field: 'process.internalCode' })).toEqual([
      expect.objectContaining({ code: 'WF_RULE_PATH_UNKNOWN' }),
    ]);
    expect(ruleConfigProblems('REQUIRED_DOCUMENT', { documentTypeCode: 'DFD' })).toEqual([
      expect.objectContaining({ code: 'WF_RULE_CONFIG_INVALID' }),
    ]);
    expect(
      ruleConfigProblems('CONDITION', {
        expression: { and: [{ '>': [{ var: 'process.estimatedValue' }, 1000] }, true] },
      }),
    ).toEqual([]);
  });

  it('workflowRuleSchema: erro no campo config para expressão proibida; REQUIRED_FIELD fora do contexto é aceito no rascunho (RN-WF-56)', () => {
    const base = { scope: 'STAGE_EXIT', stageId: ID, name: 'Regra', message: 'Mensagem válida' };
    const forbidden = workflowRuleSchema.safeParse({
      ...base,
      type: 'CONDITION',
      config: { expression: { log: 'x' } },
    });
    expect(codesOf(forbidden)).toEqual(['config:NOT_ALLOWED']);
    const unknownField = workflowRuleSchema.safeParse({
      ...base,
      type: 'REQUIRED_FIELD',
      config: { field: 'process.internalCode' },
    });
    expect(unknownField.success).toBe(true);
    const unknownVariable = workflowRuleSchema.safeParse({
      ...base,
      type: 'CONDITION',
      config: { expression: { '==': [{ var: 'process.internalCode' }, 1] } },
    });
    expect(codesOf(unknownVariable)).toEqual(['config:NOT_ALLOWED']);
    const scope = workflowRuleSchema.safeParse({
      ...base,
      stageId: undefined,
      transitionId: ID,
      type: 'REQUIRED_FIELD',
      config: { field: 'process.year' },
    });
    expect(codesOf(scope)).toEqual(
      expect.arrayContaining(['stageId:CONDITIONAL_REQUIRED', 'transitionId:NOT_ALLOWED']),
    );
  });
});

describe('Schema do RuleContext (WF-19) e teste de regra (WF-23) — US-044', () => {
  it('lista toda folha estática (menos `version`) com rótulo e tipo, e os documentos informados', () => {
    const fields = ruleContextFields(['ETP', 'DFD', 'ETP']);
    const paths = fields.map((field) => field.path);
    expect(paths).not.toContain('version');
    for (const path of RULE_CONTEXT_V1_PATHS.filter((item) => item !== 'version')) {
      const field = fields.find((item) => item.path === path);
      expect(field?.label, path).not.toBe(path);
    }
    expect(fields.find((field) => field.path === 'process.estimatedValue')).toEqual({
      path: 'process.estimatedValue',
      label: 'Processo — valor estimado',
      type: 'number',
    });
    expect(paths.filter((path) => path.startsWith('documents.'))).toHaveLength(12);
    expect(paths.indexOf('documents.DFD.exists')).toBeLessThan(
      paths.indexOf('documents.ETP.exists'),
    );
    expect(fields.find((field) => field.path === 'documents.ETP.isComplete')?.label).toBe(
      'Documento ETP — completo',
    );
    expect(paths.every((path) => isRuleContextPath(path))).toBe(true);
    expect(ruleContextSchemaDtoSchema.safeParse({ version: 1, fields }).success).toBe(true);
  });

  it('código de documento fora do formato não vira campo', () => {
    expect(ruleContextFields(['etp']).some((field) => field.path.startsWith('documents.'))).toBe(
      false,
    );
  });

  it('workflowRuleTestSchema: severidade padrão BLOCKING e processId obrigatório', () => {
    const parsed = workflowRuleTestSchema.parse({
      type: 'REQUIRED_FIELD',
      config: { field: 'process.year' },
      processId: ID,
    });
    expect(parsed.severity).toBe('BLOCKING');
    expect(
      workflowRuleTestSchema.safeParse({ type: 'REQUIRED_FIELD', config: {}, processId: 'x' })
        .success,
    ).toBe(false);
    expect(workflowRuleTestSchema.safeParse({ type: 'X', config: {}, processId: ID }).success).toBe(
      false,
    );
  });
});

describe('inspectJsonLogic (whitelist — ADR-008)', () => {
  const allowAll = { isPathAllowed: () => true };

  it('recusa method, log, operação desconhecida, objeto que não é operação e caminho dinâmico', () => {
    const { issues } = inspectJsonLogic(
      {
        and: [
          { method: ['x', 'y'] },
          { log: 1 },
          { exec: [] },
          { a: 1, b: 2 },
          { var: { cat: ['process.', 'year'] } },
        ],
      },
      allowAll,
    );
    expect(issues.map((issue) => issue.kind)).toEqual([
      'OPERATOR_FORBIDDEN',
      'OPERATOR_FORBIDDEN',
      'OPERATOR_FORBIDDEN',
      'INVALID',
      'PATH_UNKNOWN',
    ]);
  });

  it('não confere `var` relativo dentro de iteradores, mas confere missing/missing_some', () => {
    const known = { isPathAllowed: (path: string) => path.startsWith('process.') };
    expect(
      inspectJsonLogic({ some: [{ var: 'process.tags' }, { '==': [{ var: '' }, 'TI'] }] }, known)
        .issues,
    ).toEqual([]);
    const { issues, paths } = inspectJsonLogic(
      { or: [{ missing: ['process.year', 'risks.count'] }, { missing_some: [1, ['x.y']] }] },
      known,
    );
    expect(paths).toEqual(['process.year', 'risks.count', 'x.y']);
    expect(issues).toHaveLength(2);
  });

  it('profundidade > 20 e tamanho > 10 KB', () => {
    let deep: unknown = true;
    for (let level = 0; level <= JSON_LOGIC_MAX_DEPTH; level += 1) deep = { '!': [deep] };
    expect(inspectJsonLogic(deep, allowAll).issues).toEqual([
      expect.objectContaining({
        kind: 'INVALID',
        detail: expect.stringMatching(/níveis/) as unknown,
      }),
    ]);
    const big = { cat: ['x'.repeat(11 * 1024)] };
    expect(inspectJsonLogic(big, allowAll).issues).toEqual([
      expect.objectContaining({ detail: expect.stringMatching(/10 KB/) as unknown }),
    ]);
  });
});

describe('eventos de workflow (events.md §4)', () => {
  it('routing keys e payloads', () => {
    expect(WorkflowCreated.resolve({ workflowId: ID, key: 'OBRAS' }).routingKey).toBe(
      'workflow.created',
    );
    expect(
      WorkflowVersionPublished.resolve({
        workflowId: ID,
        workflowVersionId: ID2,
        versionNumber: 1,
        definitionHash: 'a'.repeat(64),
      }).routingKey,
    ).toBe('workflow.version_published');
    expect(
      WorkflowVersionRetired.resolve({ workflowId: ID, workflowVersionId: ID2 }).routingKey,
    ).toBe('workflow.version_retired');
    expect(() =>
      WorkflowVersionPublished.resolve({
        workflowId: ID,
        workflowVersionId: ID2,
        versionNumber: 1,
        definitionHash: 'xyz',
      }),
    ).toThrow();
  });
});

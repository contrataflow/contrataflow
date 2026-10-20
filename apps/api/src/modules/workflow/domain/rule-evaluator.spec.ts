import type { DocumentStatus, RuleContextV1, RuleType } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { evaluateRule, isFilled, meetsMinStatus, readContextPath } from './rule-evaluator.js';
import type { EvaluableRule, EvaluationFacts } from './rule-evaluator.js';
import { ABSENT_DOCUMENT, documentStateOf, documentsSectionOf } from './rule-facts.js';
import type { RuleDocumentFact, StagePassFact } from './rule-facts.js';
import { ruleContext, ruleProcess } from '../../../../test/support/workflow-engine-fixtures.js';

/*
 * US-041 — `RuleEvaluator` (RN-WF-26..29): uma estratégia por `RuleType`, fail-closed e sem
 * exceções. Testes de unidade de "Testes necessários": os 5 `minStatus`, `REQUIRED_FIELD`,
 * `REQUIRED_APPROVAL` e `CONDITION` com operações aceitas e recusadas.
 */

const RULE_ID = '0192c000-0000-7000-8000-0000000000a1';

const rule = (type: RuleType, config: Record<string, unknown>): EvaluableRule => ({
  id: RULE_ID,
  type,
  config,
});

const doc = (
  status: DocumentStatus,
  overrides: Partial<RuleDocumentFact> = {},
): RuleDocumentFact => ({
  documentTypeCode: 'ETP',
  status,
  isComplete: false,
  versionNumber: null,
  approvedAt: null,
  ...overrides,
});

const passOf = (overrides: Partial<StagePassFact>): StagePassFact => ({
  processStageId: '0192c000-0000-7000-8000-000000000b01',
  workflowStageId: 'stage-aprovacao',
  sequence: 1,
  status: 'COMPLETED',
  departmentId: 'dep',
  assigneeId: null,
  enteredAt: '2026-10-01T12:00:00.000Z',
  exitedAt: '2026-10-02T12:00:00.000Z',
  ...overrides,
});

function facts(overrides: Partial<EvaluationFacts> = {}): EvaluationFacts {
  const passes = overrides.passes ?? [];
  return {
    context: ruleContext('ESTUDOS_PRELIMINARES'),
    documents: [],
    approvals: [],
    passesOf: (key) =>
      passes.filter((item) => item.workflowStageId === `stage-${key.toLowerCase()}`),
    ...overrides,
    passes,
  };
}

const STATUSES: readonly DocumentStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'RETURNED',
  'FINALIZED',
  'APPROVED',
  'REJECTED',
  'CANCELED',
];

describe('REQUIRED_DOCUMENT — minStatus (RN-WF-26 · DEC-018)', () => {
  // [status do documento] → minStatus satisfeitos (sem completude declarada).
  const expected: Readonly<Record<DocumentStatus, readonly string[]>> = {
    DRAFT: ['EXISTS'],
    IN_REVIEW: ['EXISTS', 'COMPLETE', 'SUBMITTED'],
    RETURNED: ['EXISTS'],
    FINALIZED: ['EXISTS', 'COMPLETE', 'SUBMITTED', 'FINAL'],
    APPROVED: ['EXISTS', 'COMPLETE', 'SUBMITTED', 'FINAL', 'APPROVED'],
    REJECTED: ['EXISTS'],
    CANCELED: [],
  };
  const MIN_STATUSES = ['EXISTS', 'COMPLETE', 'SUBMITTED', 'FINAL', 'APPROVED'] as const;

  for (const status of STATUSES) {
    for (const minStatus of MIN_STATUSES) {
      const satisfied = expected[status].includes(minStatus);
      it(`documento ${status} ${satisfied ? 'satisfaz' : 'não satisfaz'} minStatus ${minStatus}`, () => {
        expect(meetsMinStatus(doc(status), minStatus)).toBe(satisfied);
        const outcome = evaluateRule(
          rule('REQUIRED_DOCUMENT', { documentTypeCode: 'ETP', minStatus }),
          facts({ documents: [doc(status)] }),
        );
        expect(outcome).toEqual({ satisfied });
      });
    }
  }

  it('COMPLETE: rascunho que passa na completude satisfaz; cancelado completo não', () => {
    expect(meetsMinStatus(doc('DRAFT', { isComplete: true }), 'COMPLETE')).toBe(true);
    expect(meetsMinStatus(doc('RETURNED', { isComplete: true }), 'COMPLETE')).toBe(true);
    expect(meetsMinStatus(doc('CANCELED', { isComplete: true }), 'COMPLETE')).toBe(false);
  });

  it('sem documento do tipo não satisfaz; documento de outro tipo não conta', () => {
    const config = { documentTypeCode: 'ETP', minStatus: 'EXISTS' };
    expect(evaluateRule(rule('REQUIRED_DOCUMENT', config), facts()).satisfied).toBe(false);
    expect(
      evaluateRule(
        rule('REQUIRED_DOCUMENT', config),
        facts({ documents: [doc('APPROVED', { documentTypeCode: 'TR' })] }),
      ).satisfied,
    ).toBe(false);
  });

  it('minCount conta só os documentos que atingem o minStatus', () => {
    const config = { documentTypeCode: 'ETP', minStatus: 'FINAL', minCount: 2 };
    const one = [doc('FINALIZED'), doc('DRAFT'), doc('CANCELED')];
    const two = [doc('FINALIZED'), doc('APPROVED'), doc('DRAFT')];
    expect(evaluateRule(rule('REQUIRED_DOCUMENT', config), facts({ documents: one }))).toEqual({
      satisfied: false,
    });
    expect(evaluateRule(rule('REQUIRED_DOCUMENT', config), facts({ documents: two }))).toEqual({
      satisfied: true,
    });
  });

  it('config inválido = não satisfeita com problema CONFIG_INVALID (fail-closed)', () => {
    const outcome = evaluateRule(
      rule('REQUIRED_DOCUMENT', { documentTypeCode: 'ETP', minStatus: 'QUALQUER' }),
      facts({ documents: [doc('APPROVED')] }),
    );
    expect(outcome.satisfied).toBe(false);
    expect(outcome.problem?.kind).toBe('CONFIG_INVALID');
  });
});

describe('REQUIRED_FIELD (RN-WF-27)', () => {
  it.each([
    ['process.modalityCode', 'PREGAO', true],
    ['process.modalityCode', null, false],
    ['process.targetDate', '   ', false],
    ['process.tags', [], false],
    ['process.tags', ['TI'], true],
    ['process.isPriceRegistration', false, true],
    ['process.itemsCount', 0, true],
  ] as const)('%s = %j → satisfeita: %s', (field, value, satisfied) => {
    const [, key] = field.split('.') as [string, keyof RuleContextV1['process']];
    const context = ruleContext('ESTUDOS_PRELIMINARES', {
      process: { ...ruleProcess(), [key]: value },
    });
    expect(evaluateRule(rule('REQUIRED_FIELD', { field }), facts({ context }))).toEqual({
      satisfied,
    });
  });

  it('FA-03: caminho fora do RuleContext v1 = não satisfeita com PATH_UNKNOWN', () => {
    const outcome = evaluateRule(rule('REQUIRED_FIELD', { field: 'process.secret' }), facts());
    expect(outcome).toEqual({
      satisfied: false,
      problem: {
        kind: 'PATH_UNKNOWN',
        detail: expect.stringContaining('process.secret') as unknown,
      },
    });
  });

  it('config sem field = CONFIG_INVALID', () => {
    expect(evaluateRule(rule('REQUIRED_FIELD', {}), facts()).problem?.kind).toBe('CONFIG_INVALID');
  });

  it('caminho do schema ausente no contexto montado = MISSING_PATH', () => {
    const outcome = evaluateRule(
      rule('REQUIRED_FIELD', { field: 'documents.ETP.status' }),
      facts(),
    );
    expect(outcome.satisfied).toBe(false);
    expect(outcome.problem?.kind).toBe('MISSING_PATH');
  });

  it('documento presente no contexto é lido pelo caminho documents.<CÓDIGO>', () => {
    const context = ruleContext('ESTUDOS_PRELIMINARES', {
      documents: { ETP: documentStateOf([doc('FINALIZED', { versionNumber: 2 })]) },
    });
    expect(
      evaluateRule(
        rule('REQUIRED_FIELD', { field: 'documents.ETP.versionNumber' }),
        facts({ context }),
      ),
    ).toEqual({ satisfied: true });
  });
});

describe('REQUIRED_APPROVAL (RN-WF-28)', () => {
  const config = { stageKey: 'APROVACAO' };
  const first = passOf({ processStageId: 'p1', sequence: 2, workflowStageId: 'stage-aprovacao' });
  const last = passOf({ processStageId: 'p2', sequence: 5, workflowStageId: 'stage-aprovacao' });

  it('aprovação APPROVED na última passagem pela etapa satisfaz', () => {
    const outcome = evaluateRule(
      rule('REQUIRED_APPROVAL', config),
      facts({ passes: [first, last], approvals: [{ processStageId: 'p2', status: 'APPROVED' }] }),
    );
    expect(outcome).toEqual({ satisfied: true });
  });

  it('aprovação antiga (passagem anterior) não vale depois de uma nova passagem', () => {
    const outcome = evaluateRule(
      rule('REQUIRED_APPROVAL', config),
      facts({
        passes: [first, last],
        approvals: [
          { processStageId: 'p1', status: 'APPROVED' },
          { processStageId: 'p2', status: 'RETURNED' },
        ],
      }),
    );
    expect(outcome).toEqual({ satisfied: false });
  });

  it('passagens fora de ordem: vale a de maior sequence', () => {
    const outcome = evaluateRule(
      rule('REQUIRED_APPROVAL', config),
      facts({ passes: [last, first], approvals: [{ processStageId: 'p2', status: 'APPROVED' }] }),
    );
    expect(outcome).toEqual({ satisfied: true });
  });

  it('etapa nunca percorrida não satisfaz; config inválido = CONFIG_INVALID', () => {
    expect(evaluateRule(rule('REQUIRED_APPROVAL', config), facts())).toEqual({ satisfied: false });
    expect(evaluateRule(rule('REQUIRED_APPROVAL', { stageKey: 'x' }), facts()).problem?.kind).toBe(
      'CONFIG_INVALID',
    );
  });
});

describe('CONDITION (RN-WF-29 · whitelist DEC-016)', () => {
  const evaluate = (expression: unknown, context = ruleContext('ESTUDOS_PRELIMINARES')) =>
    evaluateRule(rule('CONDITION', { expression }), facts({ context }));

  it.each([
    [{ '>': [{ var: 'process.estimatedValue' }, 100000] }, true],
    [{ '<': [{ var: 'process.estimatedValue' }, 100000] }, false],
    [
      {
        and: [
          { '==': [{ var: 'process.modalityCode' }, 'PREGAO'] },
          { '!': { var: 'process.isBudgetConfidential' } },
        ],
      },
      true,
    ],
    [{ in: ['TI', { var: 'process.tags' }] }, false],
    [{ some: [{ var: 'process.tags' }, { '==': [{ var: '' }, 'TI'] }] }, false],
    [
      { if: [{ var: 'priceResearch.completed' }, true, { '>=': [{ var: 'risks.count' }, 0] }] },
      true,
    ],
    [{ '==': [{ var: 'documents.ETP.exists' }, false] }, true],
    [{ cat: ['a', { var: 'process.year' }] }, true],
  ])('%j → %s', (expression, satisfied) => {
    const context = ruleContext('ESTUDOS_PRELIMINARES', { documents: { ETP: ABSENT_DOCUMENT } });
    expect(evaluate(expression, context)).toEqual({ satisfied });
  });

  it.each([
    [{ method: [{ var: 'process.tags' }, 'push', ['x']] }, 'OPERATOR_FORBIDDEN'],
    [{ log: 'x' }, 'OPERATOR_FORBIDDEN'],
    [{ hack: [1] }, 'OPERATOR_FORBIDDEN'],
    [{ '==': [{ var: 'process.secret' }, 1] }, 'PATH_UNKNOWN'],
    [{ '==': [1, 1], '!=': [1, 2] }, 'CONFIG_INVALID'],
  ])('recusa em runtime %j (%s) — não satisfeita, sem chamar o json-logic', (expression, kind) => {
    const outcome = evaluate(expression);
    expect(outcome.satisfied).toBe(false);
    expect(outcome.problem?.kind).toBe(kind);
  });

  it('[Falha de integração] expressão que lança no json-logic = EVALUATION_FAILED (fail-closed)', () => {
    // Passa na whitelist (e na publicação), mas `*` sem argumentos lança TypeError no json-logic-js.
    const outcome = evaluate({ '*': [] });
    expect(outcome.satisfied).toBe(false);
    expect(outcome.problem).toEqual({
      kind: 'EVALUATION_FAILED',
      detail: expect.stringContaining('TypeError') as unknown,
    });
  });

  it('config sem expression = CONFIG_INVALID', () => {
    expect(evaluateRule(rule('CONDITION', {}), facts()).problem?.kind).toBe('CONFIG_INVALID');
  });
});

describe('robustez e auxiliares', () => {
  it('tipo de regra desconhecido não lança', () => {
    const outcome = evaluateRule({ id: RULE_ID, type: 'OUTRO' as RuleType, config: {} }, facts());
    expect(outcome.problem?.kind).toBe('CONFIG_INVALID');
  });

  it('estratégia que lança vira EVALUATION_FAILED', () => {
    const broken = facts();
    Object.defineProperty(broken, 'documents', {
      get() {
        throw new RangeError('quebrado');
      },
    });
    const outcome = evaluateRule(
      rule('REQUIRED_DOCUMENT', { documentTypeCode: 'ETP', minStatus: 'EXISTS' }),
      broken,
    );
    expect(outcome.problem).toEqual({
      kind: 'EVALUATION_FAILED',
      detail: expect.stringContaining('RangeError') as unknown,
    });
  });

  it('lançamento que não é Error também vira EVALUATION_FAILED', () => {
    const broken = facts();
    Object.defineProperty(broken, 'documents', {
      get() {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- simula biblioteca que lança valor cru
        throw 'falha';
      },
    });
    const outcome = evaluateRule(
      rule('REQUIRED_DOCUMENT', { documentTypeCode: 'ETP', minStatus: 'EXISTS' }),
      broken,
    );
    expect(outcome.problem).toEqual({
      kind: 'EVALUATION_FAILED',
      detail: expect.stringContaining('erro') as unknown,
    });
  });

  it('readContextPath não segue o protótipo', () => {
    const context = ruleContext('X');
    expect(readContextPath(context, 'process.constructor')).toBeUndefined();
    expect(readContextPath(context, 'process.year')).toBe(2026);
    expect(readContextPath(context, 'process.year.x')).toBeUndefined();
  });

  it('isFilled', () => {
    expect([null, undefined, '', ' ', []].map(isFilled)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect([0, false, 'x', ['a'], {}].map(isFilled)).toEqual([true, true, true, true, true]);
  });

  it('documents.<CÓDIGO>: o status mais avançado, contagem sem cancelados e a última aprovação', () => {
    const section = documentsSectionOf([
      doc('CANCELED', { documentTypeCode: 'TR' }),
      doc('DRAFT', { versionNumber: 1 }),
      doc('APPROVED', { versionNumber: 3, approvedAt: '2026-10-02T00:00:00.000Z' }),
      doc('FINALIZED', { versionNumber: 2, approvedAt: '2026-10-05T00:00:00.000Z' }),
      doc('CANCELED', { versionNumber: 9 }),
    ]);
    expect(Object.keys(section)).toEqual(['ETP', 'TR']);
    expect(section).toEqual({
      ETP: {
        exists: true,
        count: 3,
        status: 'APPROVED',
        isComplete: true,
        versionNumber: 3,
        approvedAt: '2026-10-05T00:00:00.000Z',
      },
      TR: ABSENT_DOCUMENT,
    });
    expect(documentStateOf([doc('DRAFT')])).toEqual({
      exists: true,
      count: 1,
      status: 'DRAFT',
      isComplete: false,
      versionNumber: null,
      approvedAt: null,
    });
  });
});

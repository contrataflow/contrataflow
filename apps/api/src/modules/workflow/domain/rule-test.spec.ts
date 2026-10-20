import { describe, expect, it } from 'vitest';

import type { RuleFacts } from './rule-facts.js';
import { CONFIDENTIAL_PLACEHOLDER, maskBudget, ruleTestWarningOf, testRule } from './rule-test.js';
import type { RuleTestInput } from './rule-test.js';
import {
  dec015Workflow,
  pass,
  passesUntilStudies,
  ruleContext,
  ruleProcess,
  snapshotOf,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';

/*
 * US-044 — "Testar regra" (WF-23 · RN-WF-59) no domínio: a regra avulsa passa pelo MESMO
 * `evaluateRule` e pelos mesmos fatos do motor; `contextUsed` lista só caminhos do schema e mascara
 * o orçamento sigiloso (POL-09).
 */

const builder = dec015Workflow(new DefinitionBuilder());
const definition = snapshotOf(builder);

function facts(overrides: Partial<RuleFacts> = {}): RuleFacts {
  return {
    context: ruleContext('ESTUDOS_PRELIMINARES'),
    documents: [],
    passes: passesUntilStudies(builder),
    approvals: [],
    ...overrides,
  };
}

const run = (rule: RuleTestInput['rule'], overrides: Partial<RuleTestInput> = {}) =>
  testRule({ definition, facts: facts(), rule, budgetVisible: true, ...overrides });

describe('testRule — REQUIRED_DOCUMENT', () => {
  const rule = {
    type: 'REQUIRED_DOCUMENT' as const,
    config: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
  };

  it('sem ETP: não satisfeita, documento "ausente" e contagens no contexto usado', () => {
    expect(run(rule)).toEqual({
      satisfied: false,
      contextUsed: {
        'documents.ETP': expect.objectContaining({ exists: false, count: 0 }) as unknown,
        matchingCount: 0,
        requiredCount: 1,
      },
    });
  });

  it('ETP completo: satisfeita', () => {
    const document = {
      documentTypeCode: 'ETP',
      status: 'DRAFT' as const,
      isComplete: true,
      versionNumber: 1,
      approvedAt: null,
    };
    const outcome = run(rule, {
      facts: facts({
        documents: [document],
        context: ruleContext('ESTUDOS_PRELIMINARES', {
          documents: {
            ETP: {
              exists: true,
              count: 1,
              status: 'DRAFT',
              isComplete: true,
              versionNumber: 1,
              approvedAt: null,
            },
          },
        }),
      }),
    });
    expect(outcome.satisfied).toBe(true);
    expect(outcome.contextUsed.matchingCount).toBe(1);
  });

  it('config inválida: não satisfeita com CONFIG_INVALID e contexto vazio', () => {
    const outcome = run({ type: 'REQUIRED_DOCUMENT', config: { documentTypeCode: 'ETP' } });
    expect(outcome).toMatchObject({ satisfied: false, problem: { kind: 'CONFIG_INVALID' } });
    expect(outcome.contextUsed).toEqual({});
  });
});

describe('testRule — REQUIRED_FIELD e CONDITION', () => {
  it('campo preenchido: satisfeita com o valor usado', () => {
    expect(run({ type: 'REQUIRED_FIELD', config: { field: 'process.year' } })).toEqual({
      satisfied: true,
      contextUsed: { 'process.year': 2026 },
    });
  });

  it('FA-04: caminho desconhecido = não satisfeita com PATH_UNKNOWN, sem expor seção', () => {
    const outcome = run({ type: 'REQUIRED_FIELD', config: { field: 'process' } });
    expect(outcome).toMatchObject({ satisfied: false, problem: { kind: 'PATH_UNKNOWN' } });
    expect(outcome.contextUsed).toEqual({});
  });

  it('CONDITION: só caminhos do schema entram no contexto usado', () => {
    const outcome = run({
      type: 'CONDITION',
      config: {
        expression: {
          and: [
            { '>': [{ var: 'process.estimatedValue' }, 100000] },
            { '==': [{ var: 'documents.ETP.exists' }, false] },
          ],
        },
      },
    });
    expect(outcome).toEqual({
      satisfied: true,
      contextUsed: { 'process.estimatedValue': 150000, 'documents.ETP.exists': false },
    });
  });

  it('POL-09: sem acesso ao orçamento sigiloso, o valor sai mascarado (o resultado não muda)', () => {
    const outcome = run(
      {
        type: 'CONDITION',
        config: { expression: { '>': [{ var: 'process.estimatedValue' }, 100000] } },
      },
      {
        budgetVisible: false,
        facts: facts({
          context: ruleContext('ESTUDOS_PRELIMINARES', {
            process: ruleProcess({ isBudgetConfidential: true }),
          }),
        }),
      },
    );
    expect(outcome.satisfied).toBe(true);
    expect(outcome.contextUsed).toEqual({ 'process.estimatedValue': CONFIDENTIAL_PLACEHOLDER });
    expect(maskBudget({ 'priceResearch.totalEstimatedValue': null }, false)).toEqual({
      'priceResearch.totalEstimatedValue': null,
    });
  });
});

describe('testRule — REQUIRED_APPROVAL (última passagem pela etapa na versão fixada)', () => {
  const rule = { type: 'REQUIRED_APPROVAL' as const, config: { stageKey: 'APROVACAO_DFD' } };

  it('passou pela etapa sem aprovação registrada: NOT_APPROVED', () => {
    expect(run(rule)).toEqual({
      satisfied: false,
      contextUsed: { 'approval.APROVACAO_DFD': 'NOT_APPROVED' },
    });
  });

  it('aprovada na última passagem: satisfeita', () => {
    const passes = [pass(builder, 'APROVACAO_DFD', 2)];
    const outcome = run(rule, {
      facts: facts({
        passes,
        approvals: [{ processStageId: passes[0]?.processStageId ?? '', status: 'APPROVED' }],
      }),
    });
    expect(outcome).toEqual({
      satisfied: true,
      contextUsed: { 'approval.APROVACAO_DFD': 'APPROVED' },
    });
  });

  it('versão fixada indisponível: nenhuma passagem casa (NOT_REACHED)', () => {
    expect(run(rule, { definition: null }).contextUsed).toEqual({
      'approval.APROVACAO_DFD': 'NOT_REACHED',
    });
  });
});

describe('ruleTestWarningOf', () => {
  it('traduz cada problema num aviso pt-BR', () => {
    expect(ruleTestWarningOf({ kind: 'PATH_UNKNOWN', detail: 'x' })).toEqual({
      code: 'PATH_UNKNOWN',
      message: 'Campo não reconhecido.',
    });
    expect(ruleTestWarningOf({ kind: 'MISSING_PATH', detail: 'x' }).code).toBe('MISSING_PATH');
    expect(ruleTestWarningOf({ kind: 'EVALUATION_FAILED', detail: 'x' }).code).toBe(
      'EVALUATION_FAILED',
    );
    expect(ruleTestWarningOf({ kind: 'OPERATOR_FORBIDDEN', detail: 'x' }).code).toBe(
      'CONFIG_INVALID',
    );
  });
});

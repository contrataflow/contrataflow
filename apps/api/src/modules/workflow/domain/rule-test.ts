import {
  inspectJsonLogic,
  isRuleContextPath,
  requiredApprovalConfigSchema,
  requiredDocumentConfigSchema,
  requiredFieldConfigSchema,
} from '@contrataflow/validation';
import type { RuleContextV1, RuleTestWarningCode, RuleType } from '@contrataflow/validation';

import { evaluateRule, meetsMinStatus, readContextPath } from './rule-evaluator.js';
import type { EvaluableRule, EvaluationFacts, RuleProblem } from './rule-evaluator.js';
import { ABSENT_DOCUMENT } from './rule-facts.js';
import type { RuleFacts } from './rule-facts.js';
import { evaluationFactsOf } from './workflow-engine.js';
import type { WorkflowSnapshot } from './workflow-snapshot.js';

/*
 * "Testar regra" (US-044 · WF-23 · RN-WF-59): avalia UMA regra avulsa (a `config` do formulário,
 * salva ou não) sobre os fatos de um processo real, com o MESMO `evaluateRule` e os mesmos fatos
 * de avaliação do motor (`evaluationFactsOf`) — "testar" e "executar de verdade" nunca divergem.
 * Puro: nada é persistido. Devolve também os valores do contexto que a regra leu (`contextUsed`),
 * com o orçamento sigiloso mascarado quando o usuário não pode vê-lo (POL-09).
 */

/** O que substitui um valor de orçamento sigiloso em `contextUsed`. */
export const CONFIDENTIAL_PLACEHOLDER = '[sigiloso]';

/** Caminhos que revelam o orçamento estimado (RN-PROC-25 · POL-09). */
const BUDGET_PATHS: ReadonlySet<string> = new Set([
  'process.estimatedValue',
  'priceResearch.totalEstimatedValue',
]);

export interface RuleTestInput {
  /** Etapas da versão FIXADA no processo (`null` = indisponível: nenhuma passagem casa). */
  readonly definition: Pick<WorkflowSnapshot, 'stages'> | null;
  readonly facts: RuleFacts;
  readonly rule: { readonly type: RuleType; readonly config: Readonly<Record<string, unknown>> };
  /** O usuário pode ver o orçamento estimado do processo. */
  readonly budgetVisible: boolean;
}

export interface RuleTestOutcome {
  readonly satisfied: boolean;
  readonly problem?: RuleProblem;
  readonly contextUsed: Record<string, unknown>;
}

const TEST_RULE_ID = 'rule-test';

const defined = (value: unknown) => (value === undefined ? null : value);

function documentUsed(
  rule: EvaluableRule,
  facts: EvaluationFacts,
): Record<string, unknown> | undefined {
  const parsed = requiredDocumentConfigSchema.safeParse(rule.config);
  if (!parsed.success) return undefined;
  const { documentTypeCode, minStatus, minCount } = parsed.data;
  const matchingCount = facts.documents.filter(
    (document) =>
      document.documentTypeCode === documentTypeCode && meetsMinStatus(document, minStatus),
  ).length;
  return {
    [`documents.${documentTypeCode}`]: facts.context.documents[documentTypeCode] ?? ABSENT_DOCUMENT,
    matchingCount,
    requiredCount: minCount ?? 1,
  };
}

function approvalUsed(
  rule: EvaluableRule,
  facts: EvaluationFacts,
): Record<string, unknown> | undefined {
  const parsed = requiredApprovalConfigSchema.safeParse(rule.config);
  if (!parsed.success) return undefined;
  const { stageKey } = parsed.data;
  const passes = facts.passesOf(stageKey);
  const last = passes.reduce<(typeof passes)[number] | null>(
    (latest, pass) => (latest === null || pass.sequence > latest.sequence ? pass : latest),
    null,
  );
  const approved =
    last !== null &&
    facts.approvals.some(
      (approval) =>
        approval.processStageId === last.processStageId && approval.status === 'APPROVED',
    );
  return {
    [`approval.${stageKey}`]:
      last === null ? 'NOT_REACHED' : approved ? 'APPROVED' : 'NOT_APPROVED',
  };
}

/** Só caminhos do schema são lidos: um caminho desconhecido nunca expõe uma seção inteira. */
function pathsUsed(context: RuleContextV1, paths: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set(paths)]
      .filter((path) => isRuleContextPath(path))
      .map((path) => [path, defined(readContextPath(context, path))]),
  );
}

/** Valores do contexto que a regra lê (caminho → valor). */
export function contextUsedOf(
  rule: EvaluableRule,
  facts: EvaluationFacts,
): Record<string, unknown> {
  switch (rule.type) {
    case 'REQUIRED_DOCUMENT':
      return documentUsed(rule, facts) ?? {};
    case 'REQUIRED_APPROVAL':
      return approvalUsed(rule, facts) ?? {};
    case 'REQUIRED_FIELD': {
      const parsed = requiredFieldConfigSchema.safeParse(rule.config);
      return parsed.success ? pathsUsed(facts.context, [parsed.data.field]) : {};
    }
    case 'CONDITION': {
      const { paths } = inspectJsonLogic(rule.config.expression, {
        isPathAllowed: isRuleContextPath,
      });
      return pathsUsed(facts.context, paths);
    }
    default:
      return {};
  }
}

/** POL-09: sem acesso ao orçamento sigiloso, os valores de orçamento saem mascarados. */
export function maskBudget(
  used: Record<string, unknown>,
  budgetVisible: boolean,
): Record<string, unknown> {
  if (budgetVisible) return used;
  return Object.fromEntries(
    Object.entries(used).map(([path, value]) => [
      path,
      BUDGET_PATHS.has(path) && value !== null ? CONFIDENTIAL_PLACEHOLDER : value,
    ]),
  );
}

/** Avalia a regra avulsa (nunca lança — o avaliador é fail-closed). */
export function testRule(input: RuleTestInput): RuleTestOutcome {
  const rule: EvaluableRule = {
    id: TEST_RULE_ID,
    type: input.rule.type,
    config: input.rule.config,
  };
  const facts = evaluationFactsOf(input.definition ?? { stages: [] }, input.facts, [rule]);
  const outcome = evaluateRule(rule, facts);
  return {
    satisfied: outcome.satisfied,
    ...(outcome.problem === undefined ? {} : { problem: outcome.problem }),
    contextUsed: maskBudget(contextUsedOf(rule, facts), input.budgetVisible),
  };
}

/** Aviso exibido junto ao resultado (FA-04: "Campo não reconhecido"). */
export function ruleTestWarningOf(problem: RuleProblem): {
  readonly code: RuleTestWarningCode;
  readonly message: string;
} {
  switch (problem.kind) {
    case 'PATH_UNKNOWN':
      return { code: 'PATH_UNKNOWN', message: 'Campo não reconhecido.' };
    case 'MISSING_PATH':
      return { code: 'MISSING_PATH', message: 'O campo não está disponível para este processo.' };
    case 'EVALUATION_FAILED':
      return { code: 'EVALUATION_FAILED', message: 'A condição não pôde ser avaliada.' };
    default:
      return { code: 'CONFIG_INVALID', message: 'A configuração da regra é inválida.' };
  }
}

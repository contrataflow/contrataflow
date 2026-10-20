import {
  conditionConfigSchema,
  inspectJsonLogic,
  isRuleContextPath,
  requiredApprovalConfigSchema,
  requiredDocumentConfigSchema,
  requiredFieldConfigSchema,
} from '@contrataflow/validation';
import type { DocumentStatus, RuleContextV1, RuleType } from '@contrataflow/validation';
import jsonLogic from 'json-logic-js';
import type { RulesLogic } from 'json-logic-js';

import { isDocumentComplete } from './rule-facts.js';
import type { RuleDocumentFact, RuleFacts, StagePassFact } from './rule-facts.js';

/*
 * `RuleEvaluator` (US-041 · DEC-016/DEC-018 · ADR-008): avalia UMA regra de workflow sobre os fatos
 * já carregados, com uma estratégia por `RuleType`. Puro, determinístico e sem exceções: regra mal
 * configurada (caminho fora do RuleContext, operação fora da whitelist, `config` inválido) ou
 * expressão que falha no `json-logic-js` = regra NÃO satisfeita (fail-closed — RN-WF-27, FA-03), com
 * o problema devolvido para o chamador registrar em log.
 */

/** Por que a regra não pôde ser avaliada normalmente. */
export type RuleProblemKind =
  /** Caminho válido no schema, mas ausente no contexto montado (`warn`). */
  | 'MISSING_PATH'
  /** Caminho fora do RuleContext v1 (deveria ter sido barrado na publicação — `error`). */
  | 'PATH_UNKNOWN'
  | 'OPERATOR_FORBIDDEN'
  | 'CONFIG_INVALID'
  /** O `json-logic-js` lançou ao avaliar a expressão (`error`). */
  | 'EVALUATION_FAILED';

export interface RuleProblem {
  readonly kind: RuleProblemKind;
  /** Detalhe pt-BR sem valores do contexto (só nomes de campo/operação). */
  readonly detail: string;
}

/** Fatos com as passagens resolvidas pela chave da etapa (o motor resolve pelo snapshot). */
export interface EvaluationFacts extends RuleFacts {
  readonly passesOf: (stageKey: string) => readonly StagePassFact[];
}

export interface RuleOutcome {
  readonly satisfied: boolean;
  readonly problem?: RuleProblem;
}

/** A regra como o avaliador a lê (snapshot publicado). */
export interface EvaluableRule {
  readonly id: string;
  readonly type: RuleType;
  readonly config: Readonly<Record<string, unknown>>;
}

const SATISFIED: RuleOutcome = Object.freeze({ satisfied: true });
const UNSATISFIED: RuleOutcome = Object.freeze({ satisfied: false });

const failed = (kind: RuleProblemKind, detail: string): RuleOutcome => ({
  satisfied: false,
  problem: { kind, detail },
});

/** `minStatus` de `REQUIRED_DOCUMENT` (DEC-018). */
type MinStatus = 'EXISTS' | 'COMPLETE' | 'SUBMITTED' | 'FINAL' | 'APPROVED';

const STATUSES_AT_LEAST: Readonly<Record<'SUBMITTED' | 'FINAL' | 'APPROVED', ReadonlySet<string>>> =
  {
    SUBMITTED: new Set<DocumentStatus>(['IN_REVIEW', 'FINALIZED', 'APPROVED']),
    FINAL: new Set<DocumentStatus>(['FINALIZED', 'APPROVED']),
    APPROVED: new Set<DocumentStatus>(['APPROVED']),
  };

/**
 * RN-WF-26 · DEC-018: `EXISTS` = qualquer não cancelado; `COMPLETE` = passa na validação de
 * completude; `SUBMITTED` = em revisão, finalizado ou aprovado; `FINAL` = finalizado ou aprovado;
 * `APPROVED` = aprovado.
 */
export function meetsMinStatus(document: RuleDocumentFact, minStatus: MinStatus): boolean {
  if (document.status === 'CANCELED') return false;
  if (minStatus === 'EXISTS') return true;
  if (minStatus === 'COMPLETE') return isDocumentComplete(document);
  return STATUSES_AT_LEAST[minStatus].has(document.status);
}

/** Valor do caminho em notação de ponto; `undefined` quando algum segmento não existe. */
export function readContextPath(context: RuleContextV1, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** RN-WF-27: "preenchido" = não nulo, texto não vazio e lista não vazia (`false`/`0` contam). */
export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function configInvalid(type: RuleType): RuleOutcome {
  return failed('CONFIG_INVALID', `configuração inválida para ${type}`);
}

function evaluateRequiredDocument(rule: EvaluableRule, facts: EvaluationFacts): RuleOutcome {
  const parsed = requiredDocumentConfigSchema.safeParse(rule.config);
  if (!parsed.success) return configInvalid(rule.type);
  const { documentTypeCode, minStatus, minCount } = parsed.data;
  const matching = facts.documents.filter(
    (document) =>
      document.documentTypeCode === documentTypeCode && meetsMinStatus(document, minStatus),
  ).length;
  return matching >= (minCount ?? 1) ? SATISFIED : UNSATISFIED;
}

function evaluateRequiredField(rule: EvaluableRule, facts: EvaluationFacts): RuleOutcome {
  const parsed = requiredFieldConfigSchema.safeParse(rule.config);
  if (!parsed.success) return configInvalid(rule.type);
  const { field } = parsed.data;
  if (!isRuleContextPath(field)) {
    return failed('PATH_UNKNOWN', `o campo ${field} não pertence ao RuleContext v1`);
  }
  const value = readContextPath(facts.context, field);
  if (value === undefined) {
    return failed('MISSING_PATH', `o campo ${field} não está no contexto montado`);
  }
  return isFilled(value) ? SATISFIED : UNSATISFIED;
}

function evaluateRequiredApproval(rule: EvaluableRule, facts: EvaluationFacts): RuleOutcome {
  const parsed = requiredApprovalConfigSchema.safeParse(rule.config);
  if (!parsed.success) return configInvalid(rule.type);
  const { stageKey } = parsed.data;
  const passes = facts.passesOf(stageKey);
  // RN-WF-28: só a ÚLTIMA passagem pela etapa conta (uma aprovação antiga não vale após devolução).
  const last = passes.reduce<StagePassFact | null>(
    (latest, pass) => (latest === null || pass.sequence > latest.sequence ? pass : latest),
    null,
  );
  if (last === null) return UNSATISFIED;
  return facts.approvals.some(
    (approval) => approval.processStageId === last.processStageId && approval.status === 'APPROVED',
  )
    ? SATISFIED
    : UNSATISFIED;
}

function evaluateCondition(rule: EvaluableRule, facts: EvaluationFacts): RuleOutcome {
  const parsed = conditionConfigSchema.safeParse(rule.config);
  if (!parsed.success) return configInvalid(rule.type);
  const { expression } = parsed.data;
  // A whitelist da escrita vale também na execução (RN-WF-29): nada fora dela chega ao json-logic.
  const [issue] = inspectJsonLogic(expression, { isPathAllowed: isRuleContextPath }).issues;
  if (issue !== undefined) {
    return failed(
      issue.kind === 'OPERATOR_FORBIDDEN'
        ? 'OPERATOR_FORBIDDEN'
        : issue.kind === 'PATH_UNKNOWN'
          ? 'PATH_UNKNOWN'
          : 'CONFIG_INVALID',
      issue.detail,
    );
  }
  try {
    const result: unknown = jsonLogic.apply(expression as RulesLogic, facts.context);
    return jsonLogic.truthy(result) ? SATISFIED : UNSATISFIED;
  } catch (error) {
    return failed(
      'EVALUATION_FAILED',
      `a expressão falhou na avaliação (${error instanceof Error ? error.name : 'erro'})`,
    );
  }
}

const STRATEGIES: Readonly<
  Record<RuleType, (rule: EvaluableRule, facts: EvaluationFacts) => RuleOutcome>
> = {
  REQUIRED_DOCUMENT: evaluateRequiredDocument,
  REQUIRED_FIELD: evaluateRequiredField,
  REQUIRED_APPROVAL: evaluateRequiredApproval,
  CONDITION: evaluateCondition,
};

/** Avalia a regra; nunca lança (fail-closed). */
export function evaluateRule(rule: EvaluableRule, facts: EvaluationFacts): RuleOutcome {
  const strategy = Object.hasOwn(STRATEGIES, rule.type) ? STRATEGIES[rule.type] : undefined;
  if (strategy === undefined) return failed('CONFIG_INVALID', 'tipo de regra desconhecido');
  try {
    return strategy(rule, facts);
  } catch (error) {
    return failed(
      'EVALUATION_FAILED',
      `a regra falhou na avaliação (${error instanceof Error ? error.name : 'erro'})`,
    );
  }
}

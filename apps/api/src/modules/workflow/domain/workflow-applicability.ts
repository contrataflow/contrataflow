import { inspectJsonLogic, isApplicabilityPath } from '@contrataflow/validation';
import type { RuleContextV1 } from '@contrataflow/validation';
import jsonLogic from 'json-logic-js';

import type { RuleProblem } from './rule-evaluator.js';
import type { Workflow } from './workflow-definition.js';

/*
 * Resolução do workflow aplicável (US-042 · RN-WF-39 · RN-PROC-06 · DEC-016): pura e
 * determinística. Considera só workflows ativos com versão publicada, em ordem de
 * `applicabilityPriority` crescente e, no empate, `createdAt` crescente (FA-03 — e o id, para a
 * ordem ser total); vence o primeiro cuja `applicabilityRule` for nula ou verdadeira sobre
 * `RuleContext.process`. Sem correspondência, o `isDefault` (se ativo e publicado); sem nenhum,
 * `null` (`NO_APPLICABLE_WORKFLOW`). Regra fora da whitelist/caminho ou que lança na avaliação NÃO
 * casa (fail-closed, como as regras do motor) e volta como problema para o log.
 */

/** O que a aplicabilidade lê do processo (o processo ainda não existe: só os dados de criação). */
export type ApplicabilityProcess = Partial<RuleContextV1['process']>;

export type ApplicabilityCandidate = Pick<
  Workflow,
  | 'id'
  | 'isActive'
  | 'isDefault'
  | 'applicabilityRule'
  | 'applicabilityPriority'
  | 'createdAt'
  | 'currentPublishedVersionId'
>;

export interface ApplicabilityOutcome {
  readonly matches: boolean;
  readonly problem?: RuleProblem;
}

export interface ApplicabilityResolution<T extends ApplicabilityCandidate> {
  /** Workflow escolhido; `null` = `NO_APPLICABLE_WORKFLOW`. */
  readonly workflow: T | null;
  /** `RULE`: regra casou · `UNCONDITIONAL`: sem regra · `DEFAULT`: rede de segurança. */
  readonly via: 'RULE' | 'UNCONDITIONAL' | 'DEFAULT' | null;
  /** Regras que não puderam ser avaliadas (não casaram). */
  readonly problems: readonly { readonly workflowId: string; readonly problem: RuleProblem }[];
}

/** Avalia a `applicabilityRule` (nula = casa sempre). Nunca lança. */
export function evaluateApplicability(
  rule: unknown,
  process: ApplicabilityProcess,
): ApplicabilityOutcome {
  if (rule === null || rule === undefined) return { matches: true };
  const [issue] = inspectJsonLogic(rule, { isPathAllowed: isApplicabilityPath }).issues;
  if (issue !== undefined) {
    return {
      matches: false,
      problem: {
        kind:
          issue.kind === 'OPERATOR_FORBIDDEN'
            ? 'OPERATOR_FORBIDDEN'
            : issue.kind === 'PATH_UNKNOWN'
              ? 'PATH_UNKNOWN'
              : 'CONFIG_INVALID',
        detail: issue.detail,
      },
    };
  }
  try {
    const result: unknown = jsonLogic.apply(rule, { process });
    return { matches: jsonLogic.truthy(result) };
  } catch (error) {
    return {
      matches: false,
      problem: {
        kind: 'EVALUATION_FAILED',
        detail: `a regra de aplicabilidade falhou na avaliação (${error instanceof Error ? error.name : 'erro'})`,
      },
    };
  }
}

/** RN-WF-39: candidato elegível (ativo e com versão publicada). */
export function isResolvable(workflow: ApplicabilityCandidate): boolean {
  return workflow.isActive && workflow.currentPublishedVersionId !== null;
}

/** Ordem de avaliação: prioridade, depois `createdAt` e o id (FA-03). */
export function compareApplicability(a: ApplicabilityCandidate, b: ApplicabilityCandidate): number {
  return (
    a.applicabilityPriority - b.applicabilityPriority ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function resolveApplicableWorkflow<T extends ApplicabilityCandidate>(
  workflows: readonly T[],
  process: ApplicabilityProcess,
): ApplicabilityResolution<T> {
  const problems: { workflowId: string; problem: RuleProblem }[] = [];
  const candidates = workflows.filter(isResolvable).sort(compareApplicability);
  for (const workflow of candidates) {
    const outcome = evaluateApplicability(workflow.applicabilityRule, process);
    if (outcome.problem) problems.push({ workflowId: workflow.id, problem: outcome.problem });
    if (outcome.matches) {
      const unconditional = workflow.applicabilityRule === null;
      return { workflow, via: unconditional ? 'UNCONDITIONAL' : 'RULE', problems };
    }
  }
  const fallback = candidates.find((workflow) => workflow.isDefault) ?? null;
  return { workflow: fallback, via: fallback ? 'DEFAULT' : null, problems };
}

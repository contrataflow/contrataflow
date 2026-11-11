import {
  APPROVER_LINES_LIMITS,
  approverLineIdentity,
  approversBelowMinimum,
  duplicateApproverIndexes,
} from '@contrataflow/validation';
import type {
  ApprovalDecisionPolicy,
  ApproverLineFields,
  WfApproversInvalidReason,
  WorkflowStageFields,
} from '@contrataflow/validation';

import { canonicalJson } from '#shared/integrity/canonical-json.js';

/*
 * `StageApproversPolicy` (US-132 · DEC-193 · RN-APV-01..10): a política de decisão da etapa
 * `APPROVAL` e a lista ordenada `WorkflowStageApprover`. Puro: a escrita (WF-65), a validação e a
 * publicação (WF-20/21), a cópia (WF-08) e o snapshot usam as mesmas regras. Etapa sem política e
 * sem linhas = `ANY` com o aprovador único do MVP 1 (comportamento idêntico — RN-APV-02/15).
 */

/** Linha da lista (entities.md MVP 2 §4.6). `sequence` 1..n contígua, calculada aqui. */
export interface WorkflowStageApprover extends ApproverLineFields {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowVersionId: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  /** `RuleRef` da alçada (US-198): preservado, nunca editado pelo WF-65 (RN-APV-07). */
  readonly applicabilityRule: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** O que a etapa carrega da aprovação múltipla (ausente = MVP 1: `ANY`, `[]`, sem linhas). */
export interface StageDecisionFields {
  readonly decisionPolicy?: ApprovalDecisionPolicy;
  readonly decisionPolicyRules?: unknown;
  readonly approvers?: readonly WorkflowStageApprover[];
}

export function decisionPolicyOf(stage: StageDecisionFields): ApprovalDecisionPolicy {
  return stage.decisionPolicy ?? 'ANY';
}

/** Linhas da etapa em ordem de `sequence`. */
export function approversOf(stage: StageDecisionFields): readonly WorkflowStageApprover[] {
  return [...(stage.approvers ?? [])].sort((a, b) => a.sequence - b.sequence);
}

/** `decisionPolicyRules` preenchido (alçada da biblioteca de regras — US-198). */
export function hasDecisionPolicyRules(stage: StageDecisionFields): boolean {
  const rules = stage.decisionPolicyRules;
  return Array.isArray(rules) ? rules.length > 0 : rules !== undefined && rules !== null;
}

/** A etapa usa a configuração da US-132 (política diferente de `ANY` ou lista não vazia). */
export function hasDecisionConfiguration(stage: StageDecisionFields): boolean {
  return decisionPolicyOf(stage) !== 'ANY' || approversOf(stage).length > 0;
}

/** Conteúdo da linha, sem ids nem colunas de controle (comparação, snapshot e auditoria). */
export function lineContent(line: ApproverLineFields): ApproverLineFields {
  return {
    approverType: line.approverType,
    approverUserId: line.approverUserId,
    approverRoleId: line.approverRoleId,
    approverDepartmentResolution: line.approverDepartmentResolution,
    approverFixedDepartmentId: line.approverFixedDepartmentId,
    allowDeputy: line.allowDeputy,
    label: line.label,
  };
}

/** RN-APV-09: o mesmo conteúdo já gravado é *no-op* (sem versão nova nem auditoria). */
export function sameDecisionConfiguration(
  stage: StageDecisionFields,
  policy: ApprovalDecisionPolicy,
  lines: readonly ApproverLineFields[],
): boolean {
  return (
    decisionPolicyOf(stage) === policy &&
    canonicalJson(approversOf(stage).map(lineContent)) === canonicalJson(lines.map(lineContent))
  );
}

export interface ApproverLinesTarget {
  readonly tenantId: string;
  readonly workflowVersionId: string;
  readonly workflowStageId: string;
  readonly now: Date;
  readonly userId: string | null;
  readonly newId: () => string;
}

/**
 * Substituição da lista (RN-APV-03/07): `sequence` 1..n pela ordem do array, ids novos e a alçada
 * (`applicabilityRule`) herdada da linha anterior com o mesmo aprovador — a lista é trocada
 * inteira, mas a alçada configurada pela biblioteca de regras não se perde.
 */
export function buildStageApprovers(
  lines: readonly ApproverLineFields[],
  previous: readonly WorkflowStageApprover[],
  target: ApproverLinesTarget,
): WorkflowStageApprover[] {
  const rules = new Map(
    previous.map((line) => [approverLineIdentity(line), line.applicabilityRule] as const),
  );
  return lines.map((line, index) => ({
    ...lineContent(line),
    id: target.newId(),
    tenantId: target.tenantId,
    workflowVersionId: target.workflowVersionId,
    workflowStageId: target.workflowStageId,
    sequence: index + 1,
    applicabilityRule: rules.get(approverLineIdentity(line)) ?? null,
    createdAt: target.now,
    updatedAt: target.now,
    createdById: target.userId,
    updatedById: target.userId,
    version: 1,
  }));
}

type SingleApprover = Pick<
  WorkflowStageFields,
  | 'approverType'
  | 'approverUserId'
  | 'approverRoleId'
  | 'approverDepartmentResolution'
  | 'approverFixedDepartmentId'
  | 'allowDeputy'
>;

/**
 * RN-APV-08: com lista, as colunas do aprovador único espelham a linha 1 (leitores do MVP 1 e o
 * motor seguem funcionando); sem lista, ficam como estão (o aprovador único volta a valer).
 */
export function mirrorFirstLine(
  current: SingleApprover,
  lines: readonly ApproverLineFields[],
): SingleApprover {
  const [first] = lines;
  if (!first) {
    return {
      approverType: current.approverType,
      approverUserId: current.approverUserId,
      approverRoleId: current.approverRoleId,
      approverDepartmentResolution: current.approverDepartmentResolution,
      approverFixedDepartmentId: current.approverFixedDepartmentId,
      allowDeputy: current.allowDeputy,
    };
  }
  return {
    approverType: first.approverType,
    approverUserId: first.approverUserId,
    approverRoleId: first.approverRoleId,
    approverDepartmentResolution: first.approverDepartmentResolution,
    approverFixedDepartmentId: first.approverFixedDepartmentId,
    allowDeputy: first.allowDeputy,
  };
}

/** Referência da linha para auditoria e logs: só ids (nunca nomes — US-132 · Logs). */
function lineReference(line: ApproverLineFields): string | null {
  switch (line.approverType) {
    case 'USER':
      return line.approverUserId;
    case 'ROLE':
      return line.approverRoleId;
    default:
      return line.approverDepartmentResolution === 'FIXED'
        ? `FIXED:${line.approverFixedDepartmentId ?? ''}`
        : line.approverDepartmentResolution;
  }
}

/** `approvers` na auditoria (`workflow.update`): por `sequence`, tipo e referência. */
export function approversAuditValue(
  lines: readonly ApproverLineFields[],
): {
  readonly sequence: number;
  readonly approverType: string;
  readonly reference: string | null;
}[] {
  return lines.map((line, index) => ({
    sequence: index + 1,
    approverType: line.approverType,
    reference: lineReference(line),
  }));
}

/** Problema da política na validação/publicação (`WF_APPROVERS_INVALID` — RN-APV-01/03/05). */
export interface DecisionConfigurationProblem {
  readonly reason: WfApproversInvalidReason;
  /** Linha repetida (`DUPLICATE_APPROVER`). */
  readonly sequence?: number;
}

export function decisionConfigurationProblems(
  stage: StageDecisionFields & Pick<WorkflowStageFields, 'type'>,
): DecisionConfigurationProblem[] {
  const policy = decisionPolicyOf(stage);
  const lines = approversOf(stage);
  if (stage.type !== 'APPROVAL') {
    return policy !== 'ANY' || lines.length > 0 ? [{ reason: 'POLICY_NOT_ALLOWED' }] : [];
  }
  const problems: DecisionConfigurationProblem[] = [];
  if (lines.length > APPROVER_LINES_LIMITS.max) problems.push({ reason: 'TOO_MANY_LINES' });
  if (approversBelowMinimum(policy, lines.length)) problems.push({ reason: 'MIN_LINES' });
  for (const index of duplicateApproverIndexes(lines)) {
    problems.push({ reason: 'DUPLICATE_APPROVER', sequence: lines[index]?.sequence ?? index + 1 });
  }
  return problems;
}

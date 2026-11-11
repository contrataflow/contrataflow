import type {
  StageType,
  TransitionAction,
  WorkflowRuleFields,
  WorkflowStageFields,
  WorkflowTransitionFields,
  WorkflowVersionStatus,
} from '@contrataflow/validation';

import type { StageDecisionFields } from './stage-approvers.js';
import type { WorkflowSnapshot } from './workflow-snapshot.js';

/*
 * Modelo de definição de workflow (US-040 · DEC-014 · entities.md §4.5): `Workflow` 1:N
 * `WorkflowVersion` 1:N (`WorkflowStage`, `WorkflowTransition`, `WorkflowRule`). A versão é o
 * agregado da edição: toda escrita em etapa, transição ou regra acontece com a versão travada e em
 * `DRAFT` (RN-WF-05/06).
 */

/** Colunas de controle comuns (entities.md §1.1). */
export interface Audited {
  readonly id: string;
  readonly tenantId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

export interface Workflow extends Audited {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly isDefault: boolean;
  readonly applicabilityRule: unknown;
  readonly applicabilityPriority: number;
  readonly currentPublishedVersionId: string | null;
}

export interface WorkflowVersion extends Audited {
  readonly workflowId: string;
  readonly versionNumber: number;
  readonly status: WorkflowVersionStatus;
  readonly initialStageId: string | null;
  readonly changeNotes: string | null;
  readonly publishedAt: Date | null;
  readonly publishedById: string | null;
  readonly retiredAt: Date | null;
  readonly retiredById: string | null;
  readonly definitionSnapshot: WorkflowSnapshot | null;
  readonly definitionHash: string | null;
}

/**
 * Etapa da versão. `decisionPolicy`/`decisionPolicyRules`/`approvers` (US-132) vêm sempre do
 * repositório; ausentes (etapas montadas em memória, semente do MVP 1) valem `ANY` sem linhas.
 */
export interface WorkflowStage extends Audited, WorkflowStageFields, StageDecisionFields {
  readonly workflowVersionId: string;
  /**
   * Ramo da etapa (US-123 · RN-WF2-07): gravado só na publicação — no rascunho é `null` (ou
   * ausente nas etapas montadas em memória) e o WF-24 o calcula na hora.
   */
  readonly branchKey?: string | null;
}

export interface WorkflowTransition extends Audited, WorkflowTransitionFields {
  readonly workflowVersionId: string;
}

export interface WorkflowRule extends Audited, WorkflowRuleFields {
  readonly workflowVersionId: string;
  readonly config: Record<string, unknown>;
}

/** Etapas, transições e regras de uma versão. */
export interface WorkflowDefinition {
  readonly stages: readonly WorkflowStage[];
  readonly transitions: readonly WorkflowTransition[];
  readonly rules: readonly WorkflowRule[];
}

export const EMPTY_DEFINITION: WorkflowDefinition = Object.freeze({
  stages: [],
  transitions: [],
  rules: [],
});

/** RN-WF-10 + RN-WF2-05 (US-123): compatibilidade ação × tipo, compartilhada com o editor. */
export {
  ACTION_SOURCES,
  ACTION_TARGETS,
  actionAllowedBetween,
  actionAllowedFrom,
  actionAllowedTo,
} from '@contrataflow/validation';

/** Ações cujo destino deve ser uma etapa ANTERIOR (existe avanço do destino até a origem). */
export const BACKWARD_ACTIONS: readonly TransitionAction[] = ['RETURN', 'REJECT'];

/** RN-WF-17: regras `TRANSITION` só nestas ações. */
export const RULE_TRANSITION_ACTIONS: readonly TransitionAction[] = [
  'FORWARD',
  'COMPLETE',
  'APPROVE',
];

/** RN-WF-09: `RETURN`/`REJECT` sempre exigem comentário. */
export function forcedRequiresComment(action: TransitionAction, requested: boolean): boolean {
  return BACKWARD_ACTIONS.includes(action) ? true : requested;
}

const STAGE_TYPE_LABELS: Readonly<Record<StageType, string>> = {
  START: 'inicial',
  TASK: 'de tarefa',
  APPROVAL: 'de aprovação',
  END: 'final',
  PARALLEL_SPLIT: 'de ramificação',
  PARALLEL_JOIN: 'de junção',
};

/** "inicial", "de aprovação"… para as mensagens pt-BR. */
export function stageTypeLabel(type: StageType): string {
  return STAGE_TYPE_LABELS[type];
}

/** RN-WF-41: por que o workflow não pode ser o padrão (`null` = pode). */
export function defaultIneligibility(
  workflow: Pick<Workflow, 'isActive' | 'currentPublishedVersionId'>,
): 'INACTIVE' | 'NOT_PUBLISHED' | null {
  if (!workflow.isActive) return 'INACTIVE';
  if (workflow.currentPublishedVersionId === null) return 'NOT_PUBLISHED';
  return null;
}

interface DefaultChange {
  readonly now: Date;
  readonly userId: string | null;
}

/** `Workflow.markAsDefault()` (RN-WF-40/41): só ativo e publicado. @throws Error se inelegível */
export function markAsDefault(workflow: Workflow, change: DefaultChange): Workflow {
  const reason = defaultIneligibility(workflow);
  if (reason !== null)
    throw new Error(`Workflow ${workflow.key} não pode ser o padrão (${reason}).`);
  return { ...workflow, isDefault: true, updatedAt: change.now, updatedById: change.userId };
}

/** `Workflow.unmarkAsDefault()`: o padrão anterior na troca (RN-WF-40). */
export function unmarkAsDefault(workflow: Workflow, change: DefaultChange): Workflow {
  return { ...workflow, isDefault: false, updatedAt: change.now, updatedById: change.userId };
}

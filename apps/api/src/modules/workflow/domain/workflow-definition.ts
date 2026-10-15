import type {
  StageType,
  TransitionAction,
  WorkflowRuleFields,
  WorkflowStageFields,
  WorkflowTransitionFields,
  WorkflowVersionStatus,
} from '@contrataflow/validation';

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

export interface WorkflowStage extends Audited, WorkflowStageFields {
  readonly workflowVersionId: string;
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

/** RN-WF-10: tipos de etapa de onde cada ação pode sair. `END` não tem saída. */
export const ACTION_SOURCES: Readonly<Record<TransitionAction, readonly StageType[]>> = {
  FORWARD: ['START', 'TASK'],
  COMPLETE: ['START', 'TASK'],
  APPROVE: ['APPROVAL'],
  RETURN: ['TASK', 'APPROVAL'],
  REJECT: ['APPROVAL'],
};

/** RN-WF-10: tipos de etapa de destino aceitos por ação. */
export const ACTION_TARGETS: Readonly<Record<TransitionAction, readonly StageType[]>> = {
  FORWARD: ['TASK', 'APPROVAL'],
  COMPLETE: ['END'],
  APPROVE: ['TASK', 'APPROVAL', 'END'],
  RETURN: ['START', 'TASK'],
  REJECT: ['START', 'TASK'],
};

/** Ações cujo destino deve ser uma etapa ANTERIOR (existe avanço do destino até a origem). */
export const BACKWARD_ACTIONS: readonly TransitionAction[] = ['RETURN', 'REJECT'];

/** RN-WF-17: regras `TRANSITION` só nestas ações. */
export const RULE_TRANSITION_ACTIONS: readonly TransitionAction[] = [
  'FORWARD',
  'COMPLETE',
  'APPROVE',
];

export function actionAllowedFrom(action: TransitionAction, from: StageType): boolean {
  return ACTION_SOURCES[action].includes(from);
}

export function actionAllowedTo(action: TransitionAction, to: StageType): boolean {
  return ACTION_TARGETS[action].includes(to);
}

/** RN-WF-09: `RETURN`/`REJECT` sempre exigem comentário. */
export function forcedRequiresComment(action: TransitionAction, requested: boolean): boolean {
  return BACKWARD_ACTIONS.includes(action) ? true : requested;
}

const STAGE_TYPE_LABELS: Readonly<Record<StageType, string>> = {
  START: 'inicial',
  TASK: 'de tarefa',
  APPROVAL: 'de aprovação',
  END: 'final',
};

/** "inicial", "de aprovação"… para as mensagens pt-BR. */
export function stageTypeLabel(type: StageType): string {
  return STAGE_TYPE_LABELS[type];
}

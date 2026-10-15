import type {
  WorkflowDto,
  WorkflowRuleDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';

import type {
  Workflow,
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
  WorkflowVersion,
} from '../domain/workflow-definition.js';
import type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

/** Respostas de WF-02..18 (api/10-workflow.md): domínio → DTO. */

export function toWorkflowDto(
  workflow: Workflow,
  current: WorkflowVersion | null,
  draft: WorkflowVersion | null,
): WorkflowDto {
  return {
    id: workflow.id,
    key: workflow.key,
    name: workflow.name,
    description: workflow.description,
    isActive: workflow.isActive,
    isDefault: workflow.isDefault,
    applicabilityRule: workflow.applicabilityRule ?? null,
    applicabilityPriority: workflow.applicabilityPriority,
    currentPublishedVersion: current
      ? {
          id: current.id,
          versionNumber: current.versionNumber,
          publishedAt: current.publishedAt?.toISOString() ?? null,
        }
      : null,
    draftVersion: draft ? { id: draft.id, versionNumber: draft.versionNumber } : null,
    version: workflow.version,
  };
}

export function toVersionSummaryDto(version: WorkflowVersion): WorkflowVersionSummaryDto {
  return {
    id: version.id,
    workflowId: version.workflowId,
    versionNumber: version.versionNumber,
    status: version.status,
    changeNotes: version.changeNotes,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    publishedById: version.publishedById,
    retiredAt: version.retiredAt?.toISOString() ?? null,
    retiredById: version.retiredById,
    definitionHash: version.definitionHash,
    createdAt: version.createdAt.toISOString(),
    createdById: version.createdById,
    version: version.version,
  };
}

export function toStageDto(stage: WorkflowStage): WorkflowStageDto {
  return {
    id: stage.id,
    workflowVersionId: stage.workflowVersionId,
    key: stage.key,
    name: stage.name,
    instructions: stage.instructions,
    type: stage.type,
    groupLabel: stage.groupLabel,
    displayOrder: stage.displayOrder,
    departmentResolution: stage.departmentResolution,
    fixedDepartmentId: stage.fixedDepartmentId,
    assignmentPolicy: stage.assignmentPolicy,
    approverType: stage.approverType,
    approverUserId: stage.approverUserId,
    approverRoleId: stage.approverRoleId,
    approverDepartmentResolution: stage.approverDepartmentResolution,
    approverFixedDepartmentId: stage.approverFixedDepartmentId,
    allowDeputy: stage.allowDeputy,
    approvalDocumentTypeCodes: [...stage.approvalDocumentTypeCodes],
    documentTypeCodes: [...stage.documentTypeCodes],
    slaDays: stage.slaDays,
    slaType: stage.slaType,
    color: stage.color,
    version: stage.version,
  };
}

export function toTransitionDto(transition: WorkflowTransition): WorkflowTransitionDto {
  return {
    id: transition.id,
    workflowVersionId: transition.workflowVersionId,
    key: transition.key,
    name: transition.name,
    description: transition.description,
    fromStageId: transition.fromStageId,
    toStageId: transition.toStageId,
    action: transition.action,
    displayOrder: transition.displayOrder,
    isPrimary: transition.isPrimary,
    requiresComment: transition.requiresComment,
    allowDueDateOverride: transition.allowDueDateOverride,
    version: transition.version,
  };
}

export function toRuleDto(rule: WorkflowRule): WorkflowRuleDto {
  return {
    id: rule.id,
    workflowVersionId: rule.workflowVersionId,
    scope: rule.scope,
    stageId: rule.stageId,
    transitionId: rule.transitionId,
    type: rule.type,
    name: rule.name,
    description: rule.description,
    severity: rule.severity,
    config: rule.config,
    message: rule.message,
    isActive: rule.isActive,
    displayOrder: rule.displayOrder,
    version: rule.version,
  };
}

const byDisplayOrder = (
  a: { displayOrder: number; key?: string },
  b: { displayOrder: number; key?: string },
) => a.displayOrder - b.displayOrder || (a.key ?? '').localeCompare(b.key ?? '');

/** WF-09 de rascunho: lido das tabelas (FA-07). */
export function toVersionDetailDto(
  version: WorkflowVersion,
  definition: WorkflowDefinition,
): WorkflowVersionDetailDto {
  return {
    ...toVersionSummaryDto(version),
    initialStageId: version.initialStageId,
    stages: [...definition.stages].sort(byDisplayOrder).map(toStageDto),
    transitions: [...definition.transitions].sort(byDisplayOrder).map(toTransitionDto),
    rules: [...definition.rules].sort(byDisplayOrder).map(toRuleDto),
  };
}

/** WF-09 de versão publicada/aposentada: servido do `definitionSnapshot` (FA-07). */
export function toVersionDetailFromSnapshot(
  version: WorkflowVersion,
  snapshot: WorkflowSnapshot,
): WorkflowVersionDetailDto {
  const workflowVersionId = version.id;
  return {
    ...toVersionSummaryDto(version),
    initialStageId: snapshot.initialStageId,
    stages: [...snapshot.stages]
      .sort(byDisplayOrder)
      .map((stage) => ({ ...stage, workflowVersionId })),
    transitions: [...snapshot.transitions].sort(byDisplayOrder).map((transition) => {
      const { fromStageKey: _from, toStageKey: _to, ...rest } = transition;
      return { ...rest, workflowVersionId };
    }),
    rules: [...snapshot.rules].sort(byDisplayOrder).map((rule) => {
      const { stageKey: _stage, transitionKey: _transition, ...rest } = rule;
      return { ...rest, workflowVersionId };
    }),
  };
}

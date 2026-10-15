import {
  APPROVER_TYPES,
  DAY_COUNT_TYPES,
  DEPARTMENT_RESOLUTIONS,
  RULE_CONTEXT_VERSION,
  RULE_SCOPES,
  RULE_SEVERITIES,
  RULE_TYPES,
  STAGE_ASSIGNMENT_POLICIES,
  STAGE_DEPARTMENT_RESOLUTIONS,
  STAGE_TYPES,
  TRANSITION_ACTIONS,
} from '@contrataflow/validation';
import type {
  WorkflowRuleFields,
  WorkflowStageFields,
  WorkflowTransitionFields,
} from '@contrataflow/validation';
import { z } from 'zod';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

/*
 * Snapshot canônico da definição publicada (US-040 · RN-WF-20 · DEC-084): etapas, transições e
 * regras SEM colunas de controle (datas, autores, `version`), arrays ordenados de forma
 * determinística (etapas e transições por `key`; regras pelo conteúdo) e referências por id e por
 * chave. `definitionHash` = SHA-256 do JSON canonicalizado pelo JCS (RFC 8785): a mesma definição,
 * inserida em qualquer ordem, gera o mesmo hash; recalcular o hash do snapshot gravado reproduz o
 * valor. É o que o motor (US-041) lê — uma linha, cache imutável por versão.
 */

export const WORKFLOW_SNAPSHOT_SCHEMA_VERSION = 1;

const id = z.uuid();

const snapshotStageSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  instructions: z.string().nullable(),
  type: z.enum(STAGE_TYPES),
  groupLabel: z.string().nullable(),
  displayOrder: z.number().int(),
  departmentResolution: z.enum(STAGE_DEPARTMENT_RESOLUTIONS),
  fixedDepartmentId: id.nullable(),
  assignmentPolicy: z.enum(STAGE_ASSIGNMENT_POLICIES),
  approverType: z.enum(APPROVER_TYPES).nullable(),
  approverUserId: id.nullable(),
  approverRoleId: id.nullable(),
  approverDepartmentResolution: z.enum(DEPARTMENT_RESOLUTIONS).nullable(),
  approverFixedDepartmentId: id.nullable(),
  allowDeputy: z.boolean(),
  approvalDocumentTypeCodes: z.array(z.string()),
  documentTypeCodes: z.array(z.string()),
  slaDays: z.number().int().nullable(),
  slaType: z.enum(DAY_COUNT_TYPES),
  color: z.string().nullable(),
});

const snapshotTransitionSchema = z.object({
  id,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fromStageId: id,
  fromStageKey: z.string(),
  toStageId: id,
  toStageKey: z.string(),
  action: z.enum(TRANSITION_ACTIONS),
  displayOrder: z.number().int(),
  isPrimary: z.boolean(),
  requiresComment: z.boolean(),
  allowDueDateOverride: z.boolean(),
});

const snapshotRuleSchema = z.object({
  id,
  scope: z.enum(RULE_SCOPES),
  stageId: id.nullable(),
  stageKey: z.string().nullable(),
  transitionId: id.nullable(),
  transitionKey: z.string().nullable(),
  type: z.enum(RULE_TYPES),
  name: z.string(),
  description: z.string().nullable(),
  severity: z.enum(RULE_SEVERITIES),
  config: z.record(z.string(), z.unknown()),
  message: z.string(),
  isActive: z.boolean(),
  displayOrder: z.number().int(),
});

export const workflowSnapshotSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SNAPSHOT_SCHEMA_VERSION),
  ruleContextVersion: z.literal(RULE_CONTEXT_VERSION),
  initialStageId: id.nullable(),
  initialStageKey: z.string().nullable(),
  stages: z.array(snapshotStageSchema),
  transitions: z.array(snapshotTransitionSchema),
  rules: z.array(snapshotRuleSchema),
});
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;
export type WorkflowSnapshotStage = z.infer<typeof snapshotStageSchema>;
export type WorkflowSnapshotTransition = z.infer<typeof snapshotTransitionSchema>;
export type WorkflowSnapshotRule = z.infer<typeof snapshotRuleSchema>;

function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const SEPARATOR = String.fromCharCode(0);

/** Ordem das regras: pelo conteúdo canônico sem ids (estável entre versão e clone), depois id. */
function ruleOrder(rule: WorkflowSnapshotRule): string {
  const { id: ruleId, stageId: _stage, transitionId: _transition, ...content } = rule;
  return `${canonicalJson(content)}${SEPARATOR}${ruleId}`;
}

/** Definição de entrada (estrutural: `WorkflowDefinition` satisfaz — sem ciclo de módulos). */
export interface SnapshotSource {
  readonly stages: readonly (WorkflowStageFields & { readonly id: string })[];
  readonly transitions: readonly (WorkflowTransitionFields & { readonly id: string })[];
  readonly rules: readonly (WorkflowRuleFields & {
    readonly id: string;
    readonly config: Record<string, unknown>;
  })[];
}

/** Monta o snapshot canônico da definição (RN-WF-20). */
export function buildWorkflowSnapshot(definition: SnapshotSource): WorkflowSnapshot {
  const stageKeys = new Map(definition.stages.map((stage) => [stage.id, stage.key]));
  const transitionKeys = new Map(
    definition.transitions.map((transition) => [transition.id, transition.key]),
  );
  const start = definition.stages.find((stage) => stage.type === 'START') ?? null;

  const stages = definition.stages
    .map((stage): WorkflowSnapshotStage => ({
      id: stage.id,
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
    }))
    .sort(byKey);

  const transitions = definition.transitions
    .map((transition): WorkflowSnapshotTransition => ({
      id: transition.id,
      key: transition.key,
      name: transition.name,
      description: transition.description,
      fromStageId: transition.fromStageId,
      fromStageKey: stageKeys.get(transition.fromStageId) ?? '',
      toStageId: transition.toStageId,
      toStageKey: stageKeys.get(transition.toStageId) ?? '',
      action: transition.action,
      displayOrder: transition.displayOrder,
      isPrimary: transition.isPrimary,
      requiresComment: transition.requiresComment,
      allowDueDateOverride: transition.allowDueDateOverride,
    }))
    .sort(byKey);

  const rules = definition.rules
    .map((rule): WorkflowSnapshotRule => ({
      id: rule.id,
      scope: rule.scope,
      stageId: rule.stageId,
      stageKey: rule.stageId === null ? null : (stageKeys.get(rule.stageId) ?? null),
      transitionId: rule.transitionId,
      transitionKey:
        rule.transitionId === null ? null : (transitionKeys.get(rule.transitionId) ?? null),
      type: rule.type,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      config: rule.config,
      message: rule.message,
      isActive: rule.isActive,
      displayOrder: rule.displayOrder,
    }))
    .map((rule) => ({ rule, order: ruleOrder(rule) }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map(({ rule }) => rule);

  return {
    schemaVersion: WORKFLOW_SNAPSHOT_SCHEMA_VERSION,
    ruleContextVersion: RULE_CONTEXT_VERSION,
    initialStageId: start?.id ?? null,
    initialStageKey: start?.key ?? null,
    stages,
    transitions,
    rules,
  };
}

/** `definitionHash`: SHA-256 (hex minúsculo) do snapshot canonicalizado (RFC 8785). */
export function workflowSnapshotHash(snapshot: WorkflowSnapshot): string {
  return sha256Hex(canonicalJson(snapshot));
}

const ID_FIELDS = new Set([
  'id',
  'initialStageId',
  'fromStageId',
  'toStageId',
  'stageId',
  'transitionId',
]);

/** O snapshot sem os ids internos da versão — idêntico entre uma versão e o seu clone. */
export function snapshotWithoutIds(snapshot: WorkflowSnapshot): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !ID_FIELDS.has(key))
          .map(([key, child]) => [key, key === 'config' ? child : strip(child)]),
      );
    }
    return value;
  };
  return strip(snapshot);
}

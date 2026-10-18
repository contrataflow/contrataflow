import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { APPROVER_TYPES } from '../document/document-type.js';
import { violationSchema } from '../http/problem.js';
import {
  RULE_SCOPES,
  RULE_TYPES,
  STAGE_DEPARTMENT_RESOLUTIONS,
  STAGE_TYPES,
} from '../workflow/workflow.js';

/*
 * Ações disponíveis (PRC-08) e checklist de pendências (PRC-09) do processo (US-041 · US-004 ·
 * api/02-processes.md): o mesmo contrato no painel situacional (web) e na API. O motor de workflow
 * (`WorkflowFacade.getAvailableActions`/`evaluateRules`) é a única fonte das respostas.
 */

/** `ProcessStatus` (DEC-013). */
export const PROCESS_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
  'SUSPENDED',
  'CANCELED',
  'COMPLETED',
  'PUBLISHED',
] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

/** `ProcessStageStatus` (entities.md §2): cada passagem por uma etapa. */
export const PROCESS_STAGE_STATUSES = ['ACTIVE', 'COMPLETED', 'RETURNED', 'CANCELED'] as const;
export type ProcessStageStatus = (typeof PROCESS_STAGE_STATUSES)[number];

/** `ApprovalStatus` (entities.md §2). */
export const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'RETURNED',
  'REJECTED',
  'CANCELED',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Catálogo de ações do painel (US-004); a US-041 emite avanço, devolução e ciclo de vida. */
export const PROCESS_ACTIONS = [
  'FORWARD',
  'RETURN',
  'CLAIM',
  'ASSIGN',
  'SUSPEND',
  'RESUME',
  'CANCEL',
  'DISCARD',
  'COMPLETE',
  'DECIDE_APPROVAL',
  'EDIT',
  'MANAGE_ITEMS',
  'MANAGE_TAGS',
  'DUPLICATE',
  'MANAGE_PARTICIPANTS',
  'FOLLOW',
  'UNFOLLOW',
  'SET_CONFIDENTIALITY',
] as const;
export type ProcessAction = (typeof PROCESS_ACTIONS)[number];

/** Ações de ciclo de vida, fora do grafo de regras (RN-WF-32). */
export const LIFECYCLE_ACTIONS = ['CLAIM', 'ASSIGN', 'SUSPEND', 'RESUME', 'CANCEL'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** Motivos de indisponibilidade emitidos pelo motor (PRC-08 · notas). */
export const ACTION_REASON_CODES = [
  'TRANSITION_BLOCKED',
  'INVALID_PROCESS_STATUS',
  'NOT_PROCESS_CUSTODIAN',
  'PROCESS_ALREADY_ASSIGNED',
  'PERMISSION_DENIED',
] as const;
export type ActionReasonCode = (typeof ACTION_REASON_CODES)[number];

export const processIdParamsSchema = z.strictObject({ id: uuidV7Schema });

export const actionReasonSchema = z
  .object({
    /** Código estável (`TRANSITION_BLOCKED`, `NOT_PROCESS_CUSTODIAN`…) — a UI escolhe ícone/atalho. */
    code: z.string(),
    /** Texto pt-BR exibido no tooltip; para regra de workflow, a `message` configurada. */
    message: z.string(),
    /** Regra de workflow que bloqueia (só em `TRANSITION_BLOCKED`). */
    ruleId: z.uuid().optional(),
  })
  .meta({ id: 'ActionReason' });
export type ActionReason = z.infer<typeof actionReasonSchema>;

export const actionEntrySchema = z
  .object({
    action: z.enum(PROCESS_ACTIONS),
    /** Transição da entrada (`FORWARD`/`COMPLETE`/`RETURN`): o `transitionId` do PRC-19 (US-047). */
    transitionId: z.uuid().optional(),
    transitionKey: z.string().optional(),
    toStageKey: z.string().optional(),
    /** Nome e tipo da etapa destino ("Para onde" e o resumo do SCR-103 — US-047). */
    toStageName: z.string().optional(),
    toStageType: z.enum(STAGE_TYPES).optional(),
    approvalId: z.uuid().optional(),
    label: z.string(),
    enabled: z.boolean(),
    primary: z.boolean().optional(),
    reasons: z.array(actionReasonSchema),
    /** Prévia de destino (RN-WF-30) — só em `FORWARD`/`COMPLETE`. */
    departmentResolution: z
      .object({
        mode: z.enum(STAGE_DEPARTMENT_RESOLUTIONS),
        departmentId: z.uuid().optional(),
        departmentName: z.string().optional(),
      })
      .optional(),
    requiresComment: z.boolean().optional(),
    allowDueDateOverride: z.boolean().optional(),
    /** Prazo previsto na etapa destino (US-047); `null` quando depende de dado não informado. */
    dueAtPreview: z.iso.datetime({ offset: true }).nullable().optional(),
    /** Aprovador previsto (US-047/US-051); `null` sem etapa `APPROVAL` ou não resolvido. */
    approverPreview: z
      .object({
        type: z.enum(APPROVER_TYPES),
        label: z.string(),
        userId: z.uuid().optional(),
        roleId: z.uuid().optional(),
        departmentId: z.uuid().optional(),
      })
      .nullable()
      .optional(),
  })
  .meta({ id: 'ActionEntry' });
export type ActionEntry = z.infer<typeof actionEntrySchema>;

/** Pendência do checklist: `Violation` (api.md §2.1.2) com os campos do painel (US-004). */
export const checklistViolationSchema = violationSchema
  .extend({
    code: z.literal('WORKFLOW_RULE'),
    ruleId: z.uuid(),
    name: z.string(),
    type: z.enum(RULE_TYPES),
    satisfied: z.boolean(),
    scope: z.enum(RULE_SCOPES),
    transitionId: z.uuid().optional(),
    transitionKey: z.string().optional(),
    /** Regra que não pôde ser avaliada: não satisfeita, com a mensagem padrão (FA-10 da US-004). */
    evaluationFailed: z.boolean().optional(),
  })
  .meta({ id: 'ChecklistViolation' });
export type ChecklistViolation = z.infer<typeof checklistViolationSchema>;

export const processChecklistSchema = z
  .object({ violations: z.array(checklistViolationSchema) })
  .meta({ id: 'ProcessChecklist' });
export type ProcessChecklist = z.infer<typeof processChecklistSchema>;

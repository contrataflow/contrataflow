import { ACTOR_TYPES } from '@contrataflow/types';
import { z } from 'zod';

import { APPROVAL_STATUSES, PROCESS_STATUSES } from './process-actions.js';
import { movementDocumentRefSchema } from './process-forward.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { cursorQuerySchema } from '../http/pagination.js';

/*
 * Histórico de tramitações do processo (US-054 · PRC-11 · SCR-006 aba "Tramitação"): leitura
 * consolidada de `ProcessMovement` (imutável), mais recente primeiro (`sequence DESC` —
 * RN-TRAM-72), com filtros por ação (OU), unidade de origem/destino, ator e período (inclusivo),
 * combinados por E (RN-TRAM-75). O mesmo schema valida a query na API (422 `VALIDATION_ERROR`) e os
 * filtros no front (V-01/V-02).
 */

/** `MovementAction` (entities.md §2). */
export const MOVEMENT_ACTIONS = [
  'CREATE',
  'FORWARD',
  'RETURN',
  'CLAIM',
  'ASSIGN',
  'APPROVE',
  'REJECT',
  'COMPLETE',
  'CANCEL',
  'SUSPEND',
  'RESUME',
] as const;
export type MovementAction = (typeof MOVEMENT_ACTIONS)[number];

export function isMovementAction(value: string): value is MovementAction {
  return (MOVEMENT_ACTIONS as readonly string[]).includes(value);
}

/** `ApprovalDecision` (entities.md §2). */
export const APPROVAL_DECISIONS = ['APPROVE', 'RETURN', 'REJECT'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Mensagens da tabela "Validações" da US-054 (V-01..V-04), compartilhadas com a tela. */
export const PROCESS_MOVEMENTS_MESSAGES = Object.freeze({
  invalidAction: 'Filtro de ação inválido.',
  periodRange: 'O período inicial deve ser anterior ao final.',
  invalidCursor: 'Não foi possível continuar a lista. Recarregue.',
  invalidReference: 'Filtro inválido.',
});

/** Valor de query string: texto com vírgulas ou repetição (`?action=A&action=B`), achatado. */
const rawValues = z.union([z.string(), z.array(z.string())]).transform((value) =>
  (Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== ''),
);

const actionFilter = rawValues
  .superRefine((values, context) => {
    if (values.some((value) => !isMovementAction(value))) {
      context.addIssue({
        code: 'custom',
        message: PROCESS_MOVEMENTS_MESSAGES.invalidAction,
        params: { code: 'INVALID_ENUM' },
      });
    }
  })
  .transform((values) =>
    values.length === 0 ? undefined : [...new Set(values)].map((value) => value as MovementAction),
  )
  .optional();

const referenceFilter = z.uuid({ error: PROCESS_MOVEMENTS_MESSAGES.invalidReference }).optional();

/**
 * PRC-11 (query): cursor, limite (1–100, padrão 50), ação (multi, OU), unidade de origem/destino,
 * ator e período (UTC, inclusivo).
 */
export const processMovementsQuerySchema = cursorQuerySchema
  .extend({
    action: actionFilter,
    fromDepartmentId: referenceFilter,
    toDepartmentId: referenceFilter,
    actorId: referenceFilter,
    occurredFrom: isoDateTimeSchema.optional(),
    occurredTo: isoDateTimeSchema.optional(),
  })
  .superRefine((query, context) => {
    if (
      query.occurredFrom !== undefined &&
      query.occurredTo !== undefined &&
      Date.parse(query.occurredFrom) > Date.parse(query.occurredTo)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['occurredFrom'],
        message: PROCESS_MOVEMENTS_MESSAGES.periodRange,
        params: { code: 'OUT_OF_RANGE' },
      });
    }
  })
  .meta({ id: 'ProcessMovementsQuery' });
export type ProcessMovementsQuery = z.output<typeof processMovementsQuerySchema>;

/** Etapa referenciada (`WorkflowStage`): nome hidratado na leitura; `null` = não encontrado. */
const stageRefSchema = z.object({ id: z.uuid(), name: z.string().nullable() });

/**
 * Unidade ou usuário referenciado: nome hidratado na leitura (`null` = não encontrado) e
 * `isActive = false` para unidade inativada ou vínculo não ativo — selo "(inativo)" (FA-05).
 */
const partyRefSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  isActive: z.boolean(),
});

/** Resumo da aprovação vinculada (FA-03 — link "Ver decisão"). */
export const movementApprovalSummarySchema = z
  .object({
    title: z.string(),
    status: z.enum(APPROVAL_STATUSES),
    /** Só quando já decidida. */
    decision: z.enum(APPROVAL_DECISIONS).nullable(),
  })
  .meta({ id: 'MovementApprovalSummary' });

/** `MovementItem` de PRC-11 (api/02-processes.md · RN-TRAM-73). */
export const movementItemSchema = z
  .object({
    id: z.uuid(),
    /** Numeração canônica 1..n do processo (RN-TRAM-72). */
    sequence: z.int().min(1),
    action: z.enum(MOVEMENT_ACTIONS),
    fromStage: stageRefSchema.nullable(),
    toStage: stageRefSchema.nullable(),
    fromDepartment: partyRefSchema.nullable(),
    toDepartment: partyRefSchema.nullable(),
    fromUser: partyRefSchema.nullable(),
    toUser: partyRefSchema.nullable(),
    statusFrom: z.enum(PROCESS_STATUSES).nullable(),
    statusTo: z.enum(PROCESS_STATUSES).nullable(),
    actor: z.object({
      type: z.enum(ACTOR_TYPES),
      id: z.uuid().nullable(),
      /** `null` para `SYSTEM` (o front exibe "Sistema") ou ator não encontrado. */
      name: z.string().nullable(),
      departmentName: z.string().nullable(),
    }),
    comment: z.string().nullable(),
    dueAt: isoDateTimeSchema.nullable(),
    documents: z.array(movementDocumentRefSchema),
    approvalId: z.uuid().nullable(),
    approvalSummary: movementApprovalSummarySchema.nullable(),
    occurredAt: isoDateTimeSchema,
    /** Só com `AUDIT_VIEW` (RN-TRAM-74); `null` para os demais. */
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    correlationId: z.string(),
  })
  .meta({ id: 'MovementItem' });
export type MovementItemDto = z.infer<typeof movementItemSchema>;

/** `meta` de PRC-11: o cursor e se quem consulta vê o IP (FA-02 — a coluna some sem ele). */
export const processMovementsMetaSchema = z
  .object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    canViewIp: z.boolean(),
  })
  .meta({ id: 'ProcessMovementsMeta' });
export type ProcessMovementsMeta = z.infer<typeof processMovementsMetaSchema>;

export const processMovementsResponseSchema = z.object({
  data: z.array(movementItemSchema),
  meta: processMovementsMetaSchema,
});
export type ProcessMovementsResponse = z.infer<typeof processMovementsResponseSchema>;

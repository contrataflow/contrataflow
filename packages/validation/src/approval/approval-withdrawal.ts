import { z } from 'zod';

import { approvalSchema } from './approval-decision.js';
import { APPROVER_TYPES } from '../document/document-type.js';
import { PROCESS_STATUSES } from '../process/process-actions.js';

/*
 * Retirar ou redirecionar aprovação pendente (US-053 · APV-04/APV-05/DOC-11 ·
 * api/11-approvals-inbox.md): os corpos de `POST /approvals/{id}/withdraw`,
 * `POST /approvals/{id}/reassign` e `POST /documents/{id}/withdraw` e a resposta da retirada. As
 * MESMAS regras validam os diálogos do SCR-015 e a API (V-01); custódia anterior (POL-17),
 * elegibilidade do novo aprovador (POL-03 · RN-TRAM-69) e segregação dependem do estado e ficam
 * com os comandos.
 */

/** Limites da tabela "Campos" da US-053. */
export const APPROVAL_WITHDRAWAL_LIMITS = Object.freeze({
  reasonMax: 2000,
  reassignReasonMin: 10,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-053. */
export const APPROVAL_WITHDRAWAL_MESSAGES = Object.freeze({
  reasonTooLong: 'O motivo pode ter até 2.000 caracteres.',
  reassignReasonRequired: 'Informe o motivo do redirecionamento (mín. 10 caracteres).',
  approverTypeRequired: 'Selecione o tipo do novo aprovador.',
  targetRequired: 'Selecione o novo aprovador.',
  targetNotAllowed: 'Informe somente o aprovador do tipo selecionado.',
  approverNotEligible: 'Selecione um aprovador diferente e elegível para este processo.',
  selfApproval:
    'Este usuário não pode aprovar por ser autor de um dos documentos (segregação de funções).',
  notPending: 'Esta aprovação já foi decidida ou retirada.',
  withdrawDenied: 'Você não pode retirar esta aprovação.',
  reassignDenied: 'Você não pode redirecionar esta aprovação.',
  versionConflict: 'Esta aprovação foi atualizada por outra pessoa. Recarregue.',
  processStatus:
    'Esta aprovação não pode ser retirada nem redirecionada no status atual do processo.',
  /** Texto fixo do `DocumentWithdrawn` (timeline) — nunca o motivo digitado. */
  documentWithdrawn: 'Aprovação retirada',
  /**
   * Comentário da tramitação de devolução quando a retirada vem sem motivo (a `RETURN` exige
   * comentário — `process_movements_comment_required`).
   */
  movementComment: 'Aprovação retirada por quem encaminhou o processo.',
});

const reasonSchema = z
  .string()
  .max(APPROVAL_WITHDRAWAL_LIMITS.reasonMax, { error: APPROVAL_WITHDRAWAL_MESSAGES.reasonTooLong });

/** Corpo de APV-04 e DOC-11 (ESTRITO): motivo opcional, até 2.000 caracteres. */
export const withdrawApprovalSchema = z
  .strictObject({ reason: reasonSchema.optional() })
  .default({})
  .meta({ id: 'WithdrawApprovalRequest' });
export type WithdrawApproval = z.output<typeof withdrawApprovalSchema>;
export type WithdrawApprovalInput = z.input<typeof withdrawApprovalSchema>;

/** O campo do novo aprovador que cada `approverType` exige (RN-TRAM-69). */
export const REASSIGN_TARGET_FIELD = Object.freeze({
  USER: 'targetApproverUserId',
  ROLE: 'targetApproverRoleId',
  DEPARTMENT_HEAD: 'targetApproverDepartmentId',
} as const);
type ReassignTargetField = (typeof REASSIGN_TARGET_FIELD)[keyof typeof REASSIGN_TARGET_FIELD];

export interface ReassignIssue {
  readonly field: 'reason' | 'approverType' | ReassignTargetField;
  readonly code: 'REQUIRED' | 'TOO_SHORT' | 'NOT_ALLOWED';
  readonly message: string;
}

/**
 * V-01 e RN-TRAM-69 (sem o estado): motivo com 10 a 2.000 caracteres (sem os espaços das pontas)
 * e exatamente o campo `targetApprover*` do `approverType` escolhido.
 */
export function reassignIssues(body: {
  readonly approverType?: (typeof APPROVER_TYPES)[number] | null | undefined;
  readonly targetApproverUserId?: string | null | undefined;
  readonly targetApproverRoleId?: string | null | undefined;
  readonly targetApproverDepartmentId?: string | null | undefined;
  readonly reason?: string | null | undefined;
}): ReassignIssue[] {
  const issues: ReassignIssue[] = [];
  const reason = (body.reason ?? '').trim();
  if (reason.length === 0) {
    issues.push({
      field: 'reason',
      code: 'REQUIRED',
      message: APPROVAL_WITHDRAWAL_MESSAGES.reassignReasonRequired,
    });
  } else if (reason.length < APPROVAL_WITHDRAWAL_LIMITS.reassignReasonMin) {
    issues.push({
      field: 'reason',
      code: 'TOO_SHORT',
      message: APPROVAL_WITHDRAWAL_MESSAGES.reassignReasonRequired,
    });
  }
  if (body.approverType === undefined || body.approverType === null) {
    issues.push({
      field: 'approverType',
      code: 'REQUIRED',
      message: APPROVAL_WITHDRAWAL_MESSAGES.approverTypeRequired,
    });
    return issues;
  }
  const expected = REASSIGN_TARGET_FIELD[body.approverType];
  for (const field of Object.values(REASSIGN_TARGET_FIELD)) {
    const value = body[field];
    const present = value !== undefined && value !== null && value !== '';
    if (field === expected && !present) {
      issues.push({
        field,
        code: 'REQUIRED',
        message: APPROVAL_WITHDRAWAL_MESSAGES.targetRequired,
      });
    } else if (field !== expected && present) {
      issues.push({
        field,
        code: 'NOT_ALLOWED',
        message: APPROVAL_WITHDRAWAL_MESSAGES.targetNotAllowed,
      });
    }
  }
  return issues;
}

/**
 * Corpo de APV-05 (ESTRITO): `approverType` e o `targetApprover*` correspondente (exatamente um) e o
 * motivo obrigatório (≥ 10 e ≤ 2.000).
 */
export const reassignApprovalSchema = z
  .strictObject({
    approverType: z.enum(APPROVER_TYPES, {
      error: APPROVAL_WITHDRAWAL_MESSAGES.approverTypeRequired,
    }),
    targetApproverUserId: z.uuid({ error: APPROVAL_WITHDRAWAL_MESSAGES.targetRequired }).optional(),
    targetApproverRoleId: z.uuid({ error: APPROVAL_WITHDRAWAL_MESSAGES.targetRequired }).optional(),
    targetApproverDepartmentId: z
      .uuid({ error: APPROVAL_WITHDRAWAL_MESSAGES.targetRequired })
      .optional(),
    reason: reasonSchema.optional(),
  })
  .superRefine((body, context) => {
    for (const issue of reassignIssues(body)) {
      context.addIssue({
        code: 'custom',
        path: [issue.field],
        message: issue.message,
        params: { code: issue.code },
      });
    }
  })
  .meta({ id: 'ReassignApprovalRequest' });
export type ReassignApproval = z.output<typeof reassignApprovalSchema>;
export type ReassignApprovalInput = z.input<typeof reassignApprovalSchema>;

/** APV-04 — `data` da resposta: a aprovação cancelada e a etapa/status atuais do processo. */
export const withdrawnApprovalSchema = approvalSchema
  .extend({
    /** Etapa em que o processo ficou; `null` na avulsa (FA-01). */
    processStage: z.object({ key: z.string(), name: z.string() }).nullable(),
    processStatus: z.enum(PROCESS_STATUSES).nullable(),
  })
  .meta({ id: 'WithdrawnApproval' });
export type WithdrawnApprovalDto = z.infer<typeof withdrawnApprovalSchema>;

import { z } from 'zod';

import { APPROVAL_SUBJECT_TYPES } from './events.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { APPROVER_TYPES, DOCUMENT_STATUSES } from '../document/document-type.js';
import {
  APPROVAL_STATUSES,
  PROCESS_STATUSES,
  checklistViolationSchema,
} from '../process/process-actions.js';
import { APPROVAL_DECISIONS } from '../process/process-movements.js';
import type { ApprovalDecision } from '../process/process-movements.js';
import { STAGE_TYPES } from '../workflow/workflow.js';

/*
 * Decidir aprovação (US-052 · APV-02/APV-03 · api/11-approvals-inbox.md): o corpo de
 * `POST /approvals/{id}/decide`, o detalhe `GET /approvals/{id}` e a resposta da decisão. As MESMAS
 * regras validam o painel SCR-015 e a API (RN-TRAM-55); designação, segregação, regras do workflow
 * e o destino da devolução dependem do estado e ficam com o comando (POL-03 · RN-TRAM-56/62).
 */

/** Limites de RN-TRAM-55 (tabela "Campos" da US-052). */
export const APPROVAL_DECISION_LIMITS = Object.freeze({
  commentMin: 10,
  commentMax: 5000,
  acknowledgedWarningsMax: 100,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-052. */
export const APPROVAL_DECISION_MESSAGES = Object.freeze({
  decisionRequired: 'Selecione uma decisão.',
  commentRequired: 'Informe o motivo (mín. 10 caracteres).',
  commentTooLong: 'O comentário pode ter até 5.000 caracteres.',
  transitionInvalid: 'Escolha uma opção de decisão válida.',
  returnTargetRequired: 'Escolha a etapa para a qual o processo será devolvido.',
  transitionNotAvailable: 'Esta opção de decisão não está disponível para a etapa atual.',
  warningsNotAcknowledged: 'Confirme que está ciente dos avisos para continuar.',
  transitionBlocked: 'Não é possível concluir esta decisão agora.',
  notPending: 'Esta aprovação já foi decidida.',
  approverUnresolved:
    'Não foi possível determinar quem deve aprovar a próxima etapa. Contate o administrador.',
  versionConflict: 'Esta aprovação foi atualizada por outra pessoa. Recarregue.',
  notDesignated: 'Você não pode decidir esta aprovação.',
  selfApproval:
    'Você não pode decidir esta aprovação: é autor de um documento coberto (segregação de funções).',
  notFound: 'Não encontramos a aprovação solicitada.',
  processStatus: 'Esta aprovação não pode ser decidida no status atual do processo.',
});

/** RN-TRAM-55: o comentário é obrigatório para devolver e indeferir. */
export function decisionRequiresComment(decision: ApprovalDecision): boolean {
  return decision === 'RETURN' || decision === 'REJECT';
}

export interface DecisionCommentIssue {
  readonly field: 'comment';
  readonly code: 'REQUIRED' | 'TOO_SHORT' | 'TOO_LONG';
  readonly message: string;
}

/**
 * RN-TRAM-55 (V-02): comentário ausente ou curto em `RETURN`/`REJECT`; informado (em qualquer
 * decisão), entre 10 e 5.000 caracteres, sem contar os espaços das pontas.
 */
export function decisionCommentIssues(
  decision: ApprovalDecision,
  comment: string | null | undefined,
): DecisionCommentIssue[] {
  const text = (comment ?? '').trim();
  if (text.length === 0) {
    return decisionRequiresComment(decision)
      ? [
          {
            field: 'comment',
            code: 'REQUIRED',
            message: APPROVAL_DECISION_MESSAGES.commentRequired,
          },
        ]
      : [];
  }
  if (text.length < APPROVAL_DECISION_LIMITS.commentMin) {
    return [
      { field: 'comment', code: 'TOO_SHORT', message: APPROVAL_DECISION_MESSAGES.commentRequired },
    ];
  }
  if (text.length > APPROVAL_DECISION_LIMITS.commentMax) {
    return [
      { field: 'comment', code: 'TOO_LONG', message: APPROVAL_DECISION_MESSAGES.commentTooLong },
    ];
  }
  return [];
}

/**
 * Corpo de APV-03. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). `transitionId` escolhe a
 * devolução quando a etapa tem mais de uma `RETURN` para etapas percorridas (RN-TRAM-56); nas
 * demais decisões é opcional e, se enviado, precisa ser a transição da decisão.
 */
export const decideApprovalSchema = z
  .strictObject({
    decision: z.enum(APPROVAL_DECISIONS, { error: APPROVAL_DECISION_MESSAGES.decisionRequired }),
    comment: z.string({ error: APPROVAL_DECISION_MESSAGES.commentRequired }).optional(),
    acknowledgedWarnings: z
      .array(z.uuid({ error: APPROVAL_DECISION_MESSAGES.warningsNotAcknowledged }))
      .max(APPROVAL_DECISION_LIMITS.acknowledgedWarningsMax)
      .optional(),
    transitionId: z.uuid({ error: APPROVAL_DECISION_MESSAGES.transitionInvalid }).optional(),
  })
  .superRefine((body, context) => {
    for (const issue of decisionCommentIssues(body.decision, body.comment)) {
      context.addIssue({
        code: 'custom',
        path: [issue.field],
        message: issue.message,
        params: { code: issue.code },
      });
    }
  })
  .meta({ id: 'DecideApprovalRequest' });
export type DecideApproval = z.output<typeof decideApprovalSchema>;
export type DecideApprovalInput = z.input<typeof decideApprovalSchema>;

/** Pessoa referenciada: nome hidratado na leitura (`null` = não encontrado). */
const personSchema = z.object({ id: z.uuid(), name: z.string().nullable() });

/** Documento coberto e a versão exata analisada (`ApprovalDocument` — RN-TRAM-46). */
export const approvalDocumentSchema = z
  .object({
    documentId: z.uuid(),
    documentVersionId: z.uuid(),
    versionNumber: z.int().min(1).nullable(),
    code: z.string().nullable(),
    title: z.string(),
    typeCode: z.string(),
    typeName: z.string().nullable(),
    /** Status atual do documento (DEC-018). */
    status: z.enum(DOCUMENT_STATUSES),
  })
  .meta({ id: 'ApprovalDocument' });
export type ApprovalDocumentDto = z.infer<typeof approvalDocumentSchema>;

/** `Approval` (entities.md §4.6) como APV-02/APV-03 a devolvem. */
export const approvalSchema = z
  .object({
    id: z.uuid(),
    subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
    status: z.enum(APPROVAL_STATUSES),
    title: z.string(),
    process: z.object({ id: z.uuid(), code: z.string().nullable(), title: z.string() }),
    processStageId: z.uuid().nullable(),
    documentId: z.uuid().nullable(),
    requestedBy: personSchema,
    requestedAt: isoDateTimeSchema,
    requestComment: z.string().nullable(),
    dueAt: isoDateTimeSchema.nullable(),
    approver: z.object({
      type: z.enum(APPROVER_TYPES),
      userId: z.uuid().nullable(),
      roleId: z.uuid().nullable(),
      departmentId: z.uuid().nullable(),
      /** "Marta Ribeiro (titular da Secretaria de Obras)", o perfil ou a pessoa. */
      label: z.string(),
    }),
    allowDeputy: z.boolean(),
    decision: z.enum(APPROVAL_DECISIONS).nullable(),
    decidedBy: personSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decisionComment: z.string().nullable(),
    decidedAsDeputy: z.boolean(),
    documents: z.array(approvalDocumentSchema),
    version: z.int().min(1),
  })
  .meta({ id: 'Approval' });
export type ApprovalDto = z.infer<typeof approvalSchema>;

/**
 * Ações da aprovação em `meta.allowedActions` (api.md §1.5): decidir (US-052), retirar (POL-17) e
 * redirecionar (`APPROVAL_REASSIGN`) — US-053.
 */
export const APPROVAL_ACTIONS = ['DECIDE', 'WITHDRAW', 'REASSIGN'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** Por que quem consulta não pode decidir (SCR-015 "oculta ações; explica o motivo"). */
export const APPROVAL_DECISION_BLOCKERS = [
  'NOT_PENDING',
  'PERMISSION_DENIED',
  'NOT_DESIGNATED_APPROVER',
  'SELF_APPROVAL_FORBIDDEN',
  'INVALID_PROCESS_STATUS',
] as const;
export type ApprovalDecisionBlocker = (typeof APPROVAL_DECISION_BLOCKERS)[number];

/**
 * Uma opção de decisão (SCR-015): a transição do workflow (devolução: uma por etapa percorrida), o
 * destino e as regras `TRANSITION` não satisfeitas — `BLOCKING` desabilita; `WARNING` exige
 * reconhecimento (DEC-016). Na avulsa (`DOCUMENT`), sem transição nem destino.
 */
export const approvalDecisionOptionSchema = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    transitionId: z.uuid().nullable(),
    label: z.string(),
    toStage: z
      .object({
        id: z.uuid(),
        key: z.string(),
        name: z.string(),
        type: z.enum(STAGE_TYPES),
      })
      .nullable(),
    requiresComment: z.boolean(),
    enabled: z.boolean(),
    violations: z.array(checklistViolationSchema),
  })
  .meta({ id: 'ApprovalDecisionOption' });
export type ApprovalDecisionOption = z.infer<typeof approvalDecisionOptionSchema>;

/** `meta` de APV-02: ações, opções de decisão e o motivo de não poder decidir. */
export const approvalMetaSchema = z
  .object({
    allowedActions: z.array(z.enum(APPROVAL_ACTIONS)),
    decisionOptions: z.array(approvalDecisionOptionSchema),
    /** Quem consulta decide como substituto (FA-02). */
    decidesAsDeputy: z.boolean(),
    decisionBlocker: z.enum(APPROVAL_DECISION_BLOCKERS).nullable(),
  })
  .meta({ id: 'ApprovalMeta' });
export type ApprovalMeta = z.infer<typeof approvalMetaSchema>;

/** APV-03 — `data` da resposta: a aprovação decidida e a nova etapa/status do processo. */
export const decidedApprovalSchema = approvalSchema
  .extend({
    /** Etapa em que o processo ficou; `null` na avulsa (FA-01). */
    processStage: z.object({ key: z.string(), name: z.string() }).nullable(),
    processStatus: z.enum(PROCESS_STATUSES).nullable(),
    /** Próxima aprovação aberta pelo encadeamento (RN-TRAM-60). */
    chainedApprovalId: z.uuid().nullable(),
  })
  .meta({ id: 'DecidedApproval' });
export type DecidedApprovalDto = z.infer<typeof decidedApprovalSchema>;

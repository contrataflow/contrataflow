import { z } from 'zod';

import {
  APPROVAL_APPROVER_STATUSES,
  APPROVAL_LINES_MAX,
  APPROVAL_SKIPPED_REASONS,
} from './approval-approvers.js';
import { approvalProgressSchema } from './approval-progress.js';
import { APPROVAL_SUBJECT_TYPES } from './events.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { APPROVAL_DECISION_POLICIES } from '../document/approver-lines.js';
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
  // US-134 (decisão por linha — V-03/V-04/V-06/V-07/V-08 e "Casos de erro").
  lineRequired: 'Escolha em qual linha você vai decidir.',
  notLineApprover: 'Você não é o aprovador desta linha.',
  lineWaiting: 'Ainda não é a sua vez de decidir esta aprovação.',
  lineNotPending: 'Esta linha já foi decidida.',
  alreadyVoted: 'Você já votou nesta aprovação.',
});

/**
 * US-134 (passo 8): o que a tela diz depois do voto — "Seu voto foi registrado. Faltam {n}
 * aprovação(ões)." quando a aprovação continua aberta; "Aprovação decidida: {decisão}." no
 * encerramento.
 */
export function voteRecordedMessage(remaining: number): string {
  return `Seu voto foi registrado. Faltam ${String(remaining)} ${remaining === 1 ? 'aprovação' : 'aprovações'}.`;
}

const CLOSED_OUTCOME_LABELS = {
  APPROVED: 'aprovada',
  RETURNED: 'devolvida para ajuste',
  REJECTED: 'indeferida',
} as const;

export function approvalClosedMessage(outcome: keyof typeof CLOSED_OUTCOME_LABELS): string {
  return `Aprovação decidida: ${CLOSED_OUTCOME_LABELS[outcome]}.`;
}

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
    /**
     * US-134 (RN-APV-33): a linha `ApprovalApprover` decidida. Opcional quando só uma linha
     * `PENDING` cabe a quem decide; obrigatória (422 `CONDITIONAL_REQUIRED`) quando há mais de uma.
     */
    approvalApproverId: z.uuid({ error: APPROVAL_DECISION_MESSAGES.notLineApprover }).optional(),
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

/**
 * Linha `ApprovalApprover` (US-133 · DEC-193) como APV-02 a devolve: ordem, estado, aprovador
 * resolvido com o rótulo e a decisão da linha, quando houver.
 */
export const approvalApproverSchema = z
  .object({
    id: z.uuid(),
    sequence: z.int().min(1).max(APPROVAL_LINES_MAX),
    status: z.enum(APPROVAL_APPROVER_STATUSES),
    approverType: z.enum(APPROVER_TYPES),
    userId: z.uuid().nullable(),
    roleId: z.uuid().nullable(),
    departmentId: z.uuid().nullable(),
    allowDeputy: z.boolean(),
    /** "Marta Ribeiro (titular da Secretaria de Obras)", o perfil ou a pessoa. */
    label: z.string(),
    /** Quando passou a `PENDING` (`null` em `WAITING`). */
    activatedAt: isoDateTimeSchema.nullable(),
    /** Prazo próprio da linha (SLA — EP-030); `null` = vale o `dueAt` da aprovação. */
    dueAt: isoDateTimeSchema.nullable(),
    decision: z.enum(APPROVAL_DECISIONS).nullable(),
    decidedBy: personSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decidedAsDeputy: z.boolean(),
    skippedReason: z.enum(APPROVAL_SKIPPED_REASONS).nullable(),
    /** US-136 (aditivo · RN-APV-68/72): o comentário da decisão da linha (visível a quem vê a aprovação). */
    decisionComment: z.string().nullable().optional(),
    /**
     * US-135 (aditivo): a linha cancelada pelo redirecionamento que esta substitui (mesmo
     * `sequence` — RN-APV-52); `null` na linha original.
     */
    reassignedFromId: z.uuid().nullable().optional(),
    /** US-134 (aditivo): versão da linha — o `If-Match` do voto em `ALL`/`SEQUENTIAL` (RN-APV-41). */
    version: z.int().min(1),
  })
  .meta({ id: 'ApprovalApprover' });
export type ApprovalApproverDto = z.infer<typeof approvalApproverSchema>;

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
    /** US-133 (aditivo): a política copiada na solicitação (`ANY` nas aprovações do MVP 1). */
    decisionPolicy: z.enum(APPROVAL_DECISION_POLICIES),
    /**
     * US-133 (aditivo): as linhas em ordem de `sequence` (uma nas aprovações do MVP 1). US-136
     * (RN-APV-68): só a composição vigente — as `CANCELED` ficam no histórico (APV-31).
     */
    approvers: z.array(approvalApproverSchema),
    /** US-136 (aditivo · RN-APV-70): o andamento, com o mesmo texto da caixa e da lista. */
    progress: approvalProgressSchema.optional(),
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

/**
 * Por que quem consulta não pode decidir (SCR-015 "oculta ações; explica o motivo"). US-134
 * (lacuna 4, aditivo): `ALREADY_VOTED` (a pessoa já decidiu uma linha desta aprovação) e
 * `LINE_NOT_PENDING` (a linha dela já foi decidida por outro detentor ou dispensada). Linha
 * `WAITING` continua `NOT_DESIGNATED_APPROVER` (com `meta.myLine.status = WAITING`).
 */
export const APPROVAL_DECISION_BLOCKERS = [
  'NOT_PENDING',
  'PERMISSION_DENIED',
  'NOT_DESIGNATED_APPROVER',
  'ALREADY_VOTED',
  'LINE_NOT_PENDING',
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
    /**
     * US-134 (aditivo): o voto por esta opção encerra a aprovação (última linha a aprovar ou decisão
     * negativa). Só a opção que encerra avalia as regras `TRANSITION` (RN-APV-38): na que não
     * encerra, `violations` vem vazio e a opção habilitada.
     */
    closesApproval: z.boolean(),
  })
  .meta({ id: 'ApprovalDecisionOption' });
export type ApprovalDecisionOption = z.infer<typeof approvalDecisionOptionSchema>;

/**
 * US-134 (aditivo): a linha de quem consulta (`meta.myLine`). `etag` é o valor exato do `If-Match`
 * do voto (RN-APV-41): a versão da aprovação em `ANY`, a da linha em `ALL`/`SEQUENTIAL`.
 */
export const approvalMyLineSchema = z
  .object({
    id: z.uuid(),
    sequence: z.int().min(1).max(APPROVAL_LINES_MAX),
    status: z.enum(APPROVAL_APPROVER_STATUSES),
    etag: z.string(),
  })
  .meta({ id: 'ApprovalMyLine' });
export type ApprovalMyLine = z.infer<typeof approvalMyLineSchema>;

/** US-136 (RN-APV-68): ações por linha — `DECIDE` (US-134) e `REASSIGN` (US-135). */
export const APPROVAL_LINE_ACTIONS = ['DECIDE', 'REASSIGN'] as const;
export type ApprovalLineAction = (typeof APPROVAL_LINE_ACTIONS)[number];

export const approvalLineActionsSchema = z
  .object({
    approvalApproverId: z.uuid(),
    actions: z.array(z.enum(APPROVAL_LINE_ACTIONS)),
  })
  .meta({ id: 'ApprovalLineActions' });
export type ApprovalLineActionsDto = z.infer<typeof approvalLineActionsSchema>;

/** `meta` de APV-02: ações, opções de decisão e o motivo de não poder decidir. */
export const approvalMetaSchema = z
  .object({
    allowedActions: z.array(z.enum(APPROVAL_ACTIONS)),
    decisionOptions: z.array(approvalDecisionOptionSchema),
    /** Quem consulta decide como substituto (FA-02). */
    decidesAsDeputy: z.boolean(),
    decisionBlocker: z.enum(APPROVAL_DECISION_BLOCKERS).nullable(),
    /** US-134 (aditivo): a linha de quem consulta (`null` = nenhuma linha cabe a ele). */
    myLine: approvalMyLineSchema.nullable(),
    /**
     * US-134 (aditivo · FA-03): linhas `PENDING` que quem consulta pode decidir; mais de uma = o
     * painel pede a escolha (`approvalApproverId` obrigatório).
     */
    decidableLineIds: z.array(z.uuid()),
    /** US-136 (aditivo · RN-APV-68): o id de `myLine` (`null` sem linha). */
    myApproverLineId: z.uuid().nullable().optional(),
    /** US-136 (aditivo · RN-APV-68): as ações de quem consulta em cada linha vigente. */
    lineActions: z.array(approvalLineActionsSchema).optional(),
    /** US-136 (aditivo · RN-APV-68): a linha corrente em `SEQUENTIAL` pendente; senão `null`. */
    waitingFor: z
      .object({ sequence: z.int().min(1).max(APPROVAL_LINES_MAX), label: z.string() })
      .nullable()
      .optional(),
  })
  .meta({ id: 'ApprovalMeta' });
export type ApprovalMeta = z.infer<typeof approvalMetaSchema>;

/** US-134: o que o voto produziu (`meta.outcome` de APV-03). */
export const APPROVAL_DECISION_OUTCOMES = [
  'VOTE_RECORDED',
  'APPROVED',
  'RETURNED',
  'REJECTED',
] as const;
export type ApprovalDecisionOutcome = (typeof APPROVAL_DECISION_OUTCOMES)[number];

/** `meta` de APV-03 (US-134, aditivo): resultado do voto e o que falta. */
export const decideApprovalMetaSchema = z
  .object({
    outcome: z.enum(APPROVAL_DECISION_OUTCOMES),
    /** Linhas ainda `PENDING` depois do voto (0 no encerramento). */
    remainingPending: z.int().min(0),
    /** Linhas ainda `WAITING` depois do voto (0 no encerramento). */
    remainingWaiting: z.int().min(0),
    /** `SEQUENTIAL`: a linha que passou a `PENDING` (`null` sem ativação). */
    activatedApproverId: z.uuid().nullable(),
    /** A linha decidida por este voto. */
    approvalApproverId: z.uuid(),
  })
  .meta({ id: 'DecideApprovalMeta' });
export type DecideApprovalMeta = z.infer<typeof decideApprovalMetaSchema>;

/**
 * APV-03 — `data` da resposta: a aprovação decidida e a nova etapa/status do processo. US-134: no
 * voto que não encerra (`meta.outcome = VOTE_RECORDED`) nada muda no processo — `processStage` e
 * `chainedApprovalId` vêm nulos e `processStatus` é o atual (`AWAITING_APPROVAL`).
 */
export const decidedApprovalSchema = approvalSchema
  .extend({
    /** Etapa em que o processo ficou; `null` na avulsa (FA-01) e no voto que não encerra. */
    processStage: z.object({ key: z.string(), name: z.string() }).nullable(),
    processStatus: z.enum(PROCESS_STATUSES).nullable(),
    /** Próxima aprovação aberta pelo encadeamento (RN-TRAM-60). */
    chainedApprovalId: z.uuid().nullable(),
  })
  .meta({ id: 'DecidedApproval' });
export type DecidedApprovalDto = z.infer<typeof decidedApprovalSchema>;

/** APV-31 (US-136 · RN-APV-69): `includeHistory` só aceita `true`/`false` (padrão `true`). */
export const approvalLinesQuerySchema = z
  .object({
    includeHistory: z
      .string()
      .optional()
      .transform((value, context) => {
        if (value === undefined || value === 'true') return true;
        if (value === 'false') return false;
        context.addIssue({
          code: 'custom',
          message: 'Informe "true" ou "false" em "includeHistory".',
          params: { code: 'INVALID_FORMAT' },
        });
        return z.NEVER;
      }),
  })
  .meta({ id: 'ApprovalLinesQuery' });
export type ApprovalLinesQuery = z.output<typeof approvalLinesQuerySchema>;

/**
 * APV-31 (US-136 · RN-APV-69): todas as linhas da aprovação, inclusive as `CANCELED` substituídas
 * por redirecionamento (`reassignedFromId` na nova), em ordem de `sequence` e criação.
 */
export const approvalLinesResponseSchema = z.object({
  data: z.array(approvalApproverSchema),
  meta: z.object({
    decisionPolicy: z.enum(APPROVAL_DECISION_POLICIES),
    /** Linhas vigentes (sem as `CANCELED`). */
    totalLines: z.int().min(0),
    approvalStatus: z.enum(APPROVAL_STATUSES),
  }),
});
export type ApprovalLinesResponse = z.infer<typeof approvalLinesResponseSchema>;

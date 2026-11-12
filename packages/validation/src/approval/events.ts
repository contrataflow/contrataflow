import { z } from 'zod';

import { APPROVAL_APPROVER_STATUSES, APPROVAL_LINES_MAX } from './approval-approvers.js';
import { APPROVAL_DECISION_POLICIES } from '../document/approver-lines.js';
import { APPROVER_TYPES } from '../document/document-type.js';
import { defineDomainEvent } from '../events/define.js';
import { APPROVAL_DECISIONS } from '../process/process-movements.js';

/*
 * Eventos do agregado `Approval` (events.md §4.2). `ApprovalRequested` (US-047/US-051): a aprovação
 * `PENDING` foi aberta — pela entrada em etapa `APPROVAL` no encaminhamento (`PROCESS_STAGE`) ou
 * pela submissão avulsa (`DOCUMENT`). Consumidores: `TimelineProjector` (`APPROVAL_REQUESTED`) e
 * `ProcessAccessProjector` (concessão `APPROVER`) no mesmo `tx`; no worker, `APPROVAL_REQUESTED` ao
 * aprovador (in-app obrigatória) e métricas. Só ids e o prazo.
 */

const uuid = z.uuid();

export const APPROVAL_SUBJECT_TYPES = ['PROCESS_STAGE', 'DOCUMENT'] as const;
export type ApprovalSubjectType = (typeof APPROVAL_SUBJECT_TYPES)[number];

/**
 * Linha `ApprovalApprover` no `ApprovalRequested` (US-133 · RN-APV-26): ids e estado, nunca nomes.
 * `allowDeputy` (aditivo ao events.md) diz se o substituto da unidade também é avisado e ganha o
 * `APPROVER` (RN-APV-25/27).
 */
export const approvalRequestedLineSchema = z.strictObject({
  approvalApproverId: uuid,
  sequence: z.int().min(1).max(APPROVAL_LINES_MAX),
  approverType: z.enum(APPROVER_TYPES),
  approverUserId: uuid.nullable(),
  approverRoleId: uuid.nullable(),
  approverDepartmentId: uuid.nullable(),
  allowDeputy: z.boolean(),
  status: z.enum(APPROVAL_APPROVER_STATUSES),
});
export type ApprovalRequestedLine = z.infer<typeof approvalRequestedLineSchema>;

/*
 * US-133: `decisionPolicy` e `approvers[]` são aditivos e opcionais no esquema — os eventos do MVP 1
 * ainda no outbox não os têm (o aprovador único continua nas colunas espelhadas da linha 1/corrente,
 * RN-APV-24). Toda solicitação nova grava os dois.
 */
export const ApprovalRequested = defineDomainEvent({
  eventType: 'ApprovalRequested',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: z.strictObject({
    approvalId: uuid,
    subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
    processStageId: uuid.nullable(),
    documentId: uuid.nullable(),
    /** Versões exatas em análise (`ApprovalDocument.documentVersionId`). */
    documentVersionIds: z.array(uuid).max(100),
    approverType: z.enum(APPROVER_TYPES),
    approverUserId: uuid.nullable(),
    approverRoleId: uuid.nullable(),
    approverDepartmentId: uuid.nullable(),
    allowDeputy: z.boolean(),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    decisionPolicy: z.enum(APPROVAL_DECISION_POLICIES).optional(),
    approvers: z.array(approvalRequestedLineSchema).min(1).max(APPROVAL_LINES_MAX).optional(),
  }),
  routingKey: 'approval.requested',
});

/** Por que a aprovação pendente foi cancelada (events.md §4.2 · `ApprovalCanceled.reason`). */
export const APPROVAL_CANCEL_REASONS = ['WITHDRAWN', 'PROCESS_CANCELED', 'REASSIGNED'] as const;
export type ApprovalCancelReason = (typeof APPROVAL_CANCEL_REASONS)[number];

/**
 * `ApprovalCanceled` (events.md §4.2): a aprovação `PENDING` foi encerrada sem decisão — retirada da
 * submissão (US-053), cancelamento do processo (US-009, `PROCESS_CANCELED`, no mesmo `tx`) ou
 * reatribuição. Consumidores: `TimelineProjector` (`APPROVAL_CANCELED`) e, na retirada (US-135),
 * `ProcessAccessProjector` (revoga o `APPROVER` das linhas canceladas) no mesmo `tx`; no worker, só
 * métricas. Só ids e o motivo codificado.
 */
export const ApprovalCanceled = defineDomainEvent({
  eventType: 'ApprovalCanceled',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: z.strictObject({
    approvalId: uuid,
    reason: z.enum(APPROVAL_CANCEL_REASONS),
    /**
     * US-135 (aditivo · RN-APV-57): as linhas não decididas canceladas com a aprovação — origem
     * (`sourceId`) das concessões `APPROVER` que o `ProcessAccessProjector` revoga. Ausente nos
     * eventos anteriores (e no cancelamento do processo).
     */
    approvalApproverIds: z.array(uuid).max(APPROVAL_LINES_MAX).optional(),
  }),
  routingKey: 'approval.canceled',
});

/**
 * `ApprovalReassigned` (events.md §4.2 · US-053 · APV-05): o aprovador da aprovação `PENDING` foi
 * trocado (título, prazo e cobertura preservados — RN-TRAM-70). Consumidores: `TimelineProjector`
 * (`APPROVAL_REASSIGNED`) e `ProcessAccessProjector` (revoga o `APPROVER` da aprovação e concede ao
 * novo aprovador — e ao substituto, com `allowDeputy`) no mesmo `tx`; no worker,
 * `APPROVAL_REASSIGNED` ao novo e ao anterior aprovador. Só ids — nunca o motivo (pode conter dado
 * pessoal sensível, ex.: licença médica).
 */
export const ApprovalReassigned = defineDomainEvent({
  eventType: 'ApprovalReassigned',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: z.strictObject({
    approvalId: uuid,
    fromApproverType: z.enum(APPROVER_TYPES),
    fromApproverUserId: uuid.nullable(),
    fromApproverRoleId: uuid.nullable(),
    fromApproverDepartmentId: uuid.nullable(),
    approverType: z.enum(APPROVER_TYPES),
    toApproverUserId: uuid.nullable(),
    toApproverRoleId: uuid.nullable(),
    toApproverDepartmentId: uuid.nullable(),
    allowDeputy: z.boolean(),
    hasReason: z.boolean(),
    /**
     * US-133 (aditivo): a linha `ApprovalApprover` redirecionada — origem (`sourceId`) das
     * concessões `APPROVER` a revogar e a conceder (RN-APV-25). Ausente nos eventos do MVP 1.
     */
    approvalApproverId: uuid.optional(),
    /**
     * US-135 (aditivo · RN-APV-60): a posição da linha redirecionada e a linha antiga, cancelada
     * (`REASSIGNED`) — origem das concessões `APPROVER` a revogar. Ausentes nos eventos anteriores.
     */
    sequence: z.int().min(1).max(APPROVAL_LINES_MAX).optional(),
    fromApprovalApproverId: uuid.optional(),
  }),
  routingKey: 'approval.reassigned',
});

/** Voto de uma linha no encerramento (US-134 · RN-APV-39): só ids e a decisão, nunca o comentário. */
export const approvalVoteSchema = z.strictObject({
  approvalApproverId: uuid,
  sequence: z.int().min(1).max(APPROVAL_LINES_MAX),
  decision: z.enum(APPROVAL_DECISIONS),
  decidedById: uuid,
  decidedAsDeputy: z.boolean(),
});
export type ApprovalVote = z.infer<typeof approvalVoteSchema>;

/*
 * Decisão da aprovação (US-052 · events.md §4.2): `ApprovalCompleted` (`APPROVE`),
 * `ApprovalReturned` (`RETURN`) e `ApprovalRejected` (`REJECT`). Consumidores: `TimelineProjector`
 * (`APPROVAL_DECIDED`) no mesmo `tx`; no worker, `APPROVAL_DECIDED` ao solicitante e aos
 * responsáveis dos documentos cobertos e métricas. Só ids — nunca o comentário da decisão. US-134
 * (aditivo, ausentes nos eventos do MVP 1 ainda no outbox): a política, a linha que encerrou e os
 * votos (`votes[]` — linhas decididas, em ordem de `sequence`).
 */
const approvalDecisionPayload = z.strictObject({
  approvalId: uuid,
  subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
  decidedById: uuid,
  decidedAsDeputy: z.boolean(),
  /** Versões exatas decididas (`ApprovalDocument.documentVersionId`). */
  documentVersionIds: z.array(uuid).max(100),
  hasComment: z.boolean(),
  decisionPolicy: z.enum(APPROVAL_DECISION_POLICIES).optional(),
  decidingApprovalApproverId: uuid.optional(),
  votes: z.array(approvalVoteSchema).max(APPROVAL_LINES_MAX).optional(),
});

export const ApprovalCompleted = defineDomainEvent({
  eventType: 'ApprovalCompleted',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: approvalDecisionPayload,
  routingKey: 'approval.completed',
});

export const ApprovalReturned = defineDomainEvent({
  eventType: 'ApprovalReturned',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: approvalDecisionPayload,
  routingKey: 'approval.returned',
});

export const ApprovalRejected = defineDomainEvent({
  eventType: 'ApprovalRejected',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: approvalDecisionPayload,
  routingKey: 'approval.rejected',
});

/**
 * `ApprovalVoteRecorded` (events.md §4.2 · US-134 · RN-APV-35/36): voto positivo de uma linha que
 * NÃO encerra a aprovação (`ALL`/`SEQUENTIAL`). Consumidores: `TimelineProjector`
 * (`APPROVAL_VOTE_RECORDED`) no mesmo `tx`; no worker, `APPROVAL_VOTE_RECORDED` ao solicitante e
 * métricas. `approvedLines`/`totalLines` (aditivos ao events.md) compõem o "{votesLabel}" da
 * timeline. Só ids — nunca o comentário.
 */
export const ApprovalVoteRecorded = defineDomainEvent({
  eventType: 'ApprovalVoteRecorded',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: z.strictObject({
    approvalId: uuid,
    approvalApproverId: uuid,
    sequence: z.int().min(1).max(APPROVAL_LINES_MAX),
    decisionPolicy: z.enum(APPROVAL_DECISION_POLICIES),
    decidedById: uuid,
    decidedAsDeputy: z.boolean(),
    remainingPending: z.int().min(0).max(APPROVAL_LINES_MAX),
    remainingWaiting: z.int().min(0).max(APPROVAL_LINES_MAX),
    approvedLines: z.int().min(1).max(APPROVAL_LINES_MAX),
    totalLines: z.int().min(1).max(APPROVAL_LINES_MAX),
  }),
  routingKey: 'approval.vote_recorded',
});

/**
 * `ApprovalApproverActivated` (events.md §4.2 · US-134 · RN-APV-36): em `SEQUENTIAL`, a próxima linha
 * passou de `WAITING` a `PENDING`. Consumidores: `TimelineProjector` (`APPROVAL_TURN`) no mesmo `tx`;
 * no worker, `APPROVAL_REQUESTED` ao aprovador da linha (titular + substituto com `allowDeputy`;
 * detentores do perfil) e métricas. `dueAt` nulo até o SLA por linha (EP-030 · lacuna 5).
 */
export const ApprovalApproverActivated = defineDomainEvent({
  eventType: 'ApprovalApproverActivated',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: z.strictObject({
    approvalId: uuid,
    approvalApproverId: uuid,
    sequence: z.int().min(1).max(APPROVAL_LINES_MAX),
    approverType: z.enum(APPROVER_TYPES),
    approverUserId: uuid.nullable(),
    approverRoleId: uuid.nullable(),
    approverDepartmentId: uuid.nullable(),
    allowDeputy: z.boolean(),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  routingKey: 'approval.approver_activated',
});

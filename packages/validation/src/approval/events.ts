import { z } from 'zod';

import { APPROVER_TYPES } from '../document/document-type.js';
import { defineDomainEvent } from '../events/define.js';

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
  }),
  routingKey: 'approval.requested',
});

/** Por que a aprovação pendente foi cancelada (events.md §4.2 · `ApprovalCanceled.reason`). */
export const APPROVAL_CANCEL_REASONS = ['WITHDRAWN', 'PROCESS_CANCELED', 'REASSIGNED'] as const;
export type ApprovalCancelReason = (typeof APPROVAL_CANCEL_REASONS)[number];

/**
 * `ApprovalCanceled` (events.md §4.2): a aprovação `PENDING` foi encerrada sem decisão — retirada da
 * submissão (US-053), cancelamento do processo (US-009, `PROCESS_CANCELED`, no mesmo `tx`) ou
 * reatribuição. Consumidor: `TimelineProjector` (`APPROVAL_CANCELED`) no mesmo `tx`; no worker, só
 * métricas. Só ids e o motivo codificado.
 */
export const ApprovalCanceled = defineDomainEvent({
  eventType: 'ApprovalCanceled',
  eventVersion: 1,
  aggregateType: 'Approval',
  payload: z.strictObject({
    approvalId: uuid,
    reason: z.enum(APPROVAL_CANCEL_REASONS),
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
  }),
  routingKey: 'approval.reassigned',
});

/*
 * Decisão da aprovação (US-052 · events.md §4.2): `ApprovalCompleted` (`APPROVE`),
 * `ApprovalReturned` (`RETURN`) e `ApprovalRejected` (`REJECT`). Consumidores: `TimelineProjector`
 * (`APPROVAL_DECIDED`) no mesmo `tx`; no worker, `APPROVAL_DECIDED` ao solicitante e aos
 * responsáveis dos documentos cobertos e métricas. Só ids — nunca o comentário da decisão.
 */
const approvalDecisionPayload = z.strictObject({
  approvalId: uuid,
  subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
  decidedById: uuid,
  decidedAsDeputy: z.boolean(),
  /** Versões exatas decididas (`ApprovalDocument.documentVersionId`). */
  documentVersionIds: z.array(uuid).max(100),
  hasComment: z.boolean(),
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

import { APPROVAL_WITHDRAWAL_MESSAGES, ApprovalCanceled } from '@contrataflow/validation';
import type { ProcessStatus } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApprovalSubjectRegistry } from '#shared/approval/approval-subject.js';
import type {
  ApprovalSubjectHandler,
  DecisionSubjectFacts,
  SubjectWithdrawalResult,
  WithdrawalSubject,
} from '#shared/approval/approval-subject.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { DocumentWithdrawalRequest } from '#shared/document/document-approval.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { approvalNotFound } from './approval-decision.policy.js';
import { APPROVAL_CLOCK, APPROVAL_REPOSITORY } from './ports.js';
import type { ApprovalClock, ApprovalRepository, ApprovalWithCoverage } from './ports.js';
import { isDecidableProcessStatus } from '../domain/approval-decision.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';
import { WITHDRAWN, withdrawApproval } from '../domain/approval-withdrawal.js';

/** 409 `APPROVAL_NOT_PENDING` (RN-TRAM-65 · V-03): a situação registrada vai na extensão. */
export function approvalNoLongerPending(approval: ApprovalRecord): ApiError {
  return new ApiError('APPROVAL_NOT_PENDING', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.notPending,
    extensions: { status: approval.status, decision: approval.decision },
  });
}

/** 412 `VERSION_CONFLICT` (RN-TRAM-71): `If-Match` diferente da versão da aprovação. */
export function withdrawalVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 409 `INVALID_PROCESS_STATUS`: processo suspenso ou em status final (pré-condição da US-053). */
export function processNotWithdrawable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.processStatus,
    extensions: { processStatus: status },
  });
}

/** 403 `PERMISSION_DENIED` (V-04 · POL-17): sem custódia anterior; auditado como `access.denied`. */
export function withdrawalDenied(approvalId: string): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.withdrawDenied,
    auditReasonCode: 'APPROVAL_WITHDRAW',
    auditEntity: { type: 'Approval', id: approvalId },
  });
}

/** A aprovação lida como sujeito da retirada (com o solicitante — POL-17). */
export function withdrawalSubjectOf({
  approval,
  coverage,
}: ApprovalWithCoverage): WithdrawalSubject {
  return {
    approvalId: approval.id,
    processId: approval.processId,
    subjectType: approval.subjectType,
    processStageId: approval.processStageId,
    documentId: approval.documentId,
    requestedById: approval.requestedById,
    coverage: coverage.map((item) => ({
      documentId: item.documentId,
      documentVersionId: item.documentVersionId,
    })),
  };
}

export interface WithdrawalRequest {
  readonly approvalId: string;
  /** `If-Match` da aprovação (APV-04); `null` no DOC-11 (o `If-Match` é o do documento). */
  readonly expectedVersion: number | null;
  readonly reason: string | null;
  readonly idempotencyKey: string | null;
}

export interface WithdrawalOutcome {
  readonly canceled: ApprovalRecord;
  readonly subject: WithdrawalSubject;
  readonly handler: ApprovalSubjectHandler;
  readonly facts: DecisionSubjectFacts;
  readonly effects: SubjectWithdrawalResult;
}

/**
 * Retirada da aprovação pendente (US-053 · APV-04 e DOC-11 · RN-TRAM-64..68/71 · POL-17), sem
 * transação própria: roda no `tx` do comando (APV-04) ou da retirada do documento (DOC-11, pela
 * porta `DocumentApprovalRegistry`). Ordem (passos 4.1–4.8): a aprovação do tenant (404) → o dono
 * do sujeito trava o processo (ordem processo → aprovação → documentos) → `SELECT … FOR UPDATE` na
 * aprovação: não `PENDING` = 409 `APPROVAL_NOT_PENDING` antes do `If-Match` (412) → POL-17 (403
 * auditado) → processo suspenso/final = 409 → `CANCELED` (`WITHDRAWN`; `WHERE status = PENDING AND
 * version`) e `ApprovalCanceled` (timeline `APPROVAL_CANCELED` no mesmo `tx`) → efeitos do dono do
 * sujeito (documentos e, na etapa, a devolução com `metadata.withdrawn`) → `approval.withdraw`. O
 * motivo nunca vai a log nem a payload.
 */
@Injectable()
export class ApprovalWithdrawalService {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(APPROVAL_CLOCK) private readonly clock: ApprovalClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly subjects: ApprovalSubjectRegistry,
  ) {}

  async withdrawIn(tx: TenantTx, request: WithdrawalRequest): Promise<WithdrawalOutcome> {
    const userId = requireRequestContext().actor.userId ?? '';
    const now = this.clock();

    // 4.1 — a aprovação do tenant; o dono do sujeito trava o processo ANTES da aprovação.
    const found = await this.approvals.findById(tx, request.approvalId);
    if (found === null) throw approvalNotFound();
    const handler = this.subjects.handlerFor(found.approval.subjectType);
    if (handler === null) throw approvalNotFound();
    const subject = withdrawalSubjectOf(found);
    const facts = await handler.prepareDecision(tx, subject);
    if (facts === null) throw approvalNotFound();
    const approval = await this.approvals.lockForUpdate(tx, request.approvalId);
    if (approval === null) throw approvalNotFound();
    if (approval.status !== 'PENDING') throw approvalNoLongerPending(approval);
    if (request.expectedVersion !== null && request.expectedVersion !== approval.version) {
      throw withdrawalVersionConflict(request.expectedVersion, approval.version);
    }

    // 4.2 — POL-17 (custódia anterior / permissão de submissão) e processo nem suspenso nem final.
    if (!(await handler.canWithdraw(tx, subject, userId))) throw withdrawalDenied(approval.id);
    if (!isDecidableProcessStatus(facts.processStatus)) {
      throw processNotWithdrawable(facts.processStatus);
    }

    // 4.3 — a aprovação cancelada (a trava garante a versão; o WHERE é a rede) e o evento.
    const canceled = withdrawApproval(approval, { withdrawnById: userId, now });
    if (!(await this.approvals.recordWithdrawal(tx, canceled, approval.version))) {
      throw withdrawalVersionConflict(
        request.expectedVersion ?? approval.version,
        canceled.version,
      );
    }
    await this.outbox.record(
      tx,
      ApprovalCanceled.of({
        aggregateId: canceled.id,
        processId: canceled.processId,
        payload: { approvalId: canceled.id, reason: WITHDRAWN },
      }),
    );

    // 4.4–4.7 — documentos cobertos e, na etapa, a devolução à passagem de origem.
    const effects = await handler.applyWithdrawal(tx, {
      subject,
      reason: request.reason,
      withdrawnById: userId,
      now,
    });

    // 4.8 — auditoria (timeline e acessos já vieram com os eventos, no mesmo `tx`).
    await this.audit.record(tx, {
      action: 'approval.withdraw',
      entityType: 'Approval',
      entityId: canceled.id,
      processId: canceled.processId,
      changes: [{ path: 'status', old: approval.status, new: canceled.status }],
      metadata: {
        processCode: facts.processCode,
        documentCodes: [...effects.documentCodes],
        subjectType: canceled.subjectType,
        documentIds: subject.coverage.map((item) => item.documentId),
        fromStatus: effects.fromStatus,
        toStatus: effects.toStatus,
        movementId: effects.movementId,
        toStageKey: effects.processStage?.key ?? null,
        hasReason: request.reason !== null,
        idempotencyKey: request.idempotencyKey,
      },
    });
    return { canceled, subject, handler, facts, effects };
  }

  /** DOC-11 pela porta `DocumentApprovalRegistry` (o documento já foi travado e autorizado). */
  async withdrawForDocument(tx: TenantTx, request: DocumentWithdrawalRequest): Promise<void> {
    await this.withdrawIn(tx, {
      approvalId: request.approvalId,
      expectedVersion: null,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
    });
  }
}

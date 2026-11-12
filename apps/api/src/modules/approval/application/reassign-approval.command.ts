import { APPROVAL_WITHDRAWAL_MESSAGES, ApprovalReassigned } from '@contrataflow/validation';
import type { ApprovalDto, ApproverType, ReassignApproval } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApprovalSubjectRegistry } from '#shared/approval/approval-subject.js';
import type { DecisionSubject, DecisionSubjectFacts } from '#shared/approval/approval-subject.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { ProcessAccessRegistry } from '#shared/auth/process-access.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { ApprovalDecisionPolicy, approvalNotFound } from './approval-decision.policy.js';
import {
  approvalNoLongerPending,
  processNotWithdrawable,
  withdrawalSubjectOf,
  withdrawalVersionConflict,
} from './approval-withdrawal.service.js';
import { ApprovalPresenter } from './approval.presenter.js';
import { ApproverResolver } from './approver-resolver.js';
import { APPROVAL_CLOCK, APPROVAL_REPOSITORY, APPROVAL_TRANSACTIONS } from './ports.js';
import type { ApprovalClock, ApprovalRepository, ApprovalTransactions } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { ApprovalNotPendingError, isDecidableProcessStatus } from '../domain/approval-decision.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';
import {
  ApprovalLineNotFoundError,
  ApprovalLineNotReassignableError,
  ApprovalLineRequiredError,
  ReassignDuplicatedError,
  ReassignSelfApprovalError,
  assertNotInOtherLine,
  guardLineTarget,
  isSameLineApprover,
  reassignLine,
  reassignableLineOf,
  singleLineOf,
} from '../domain/approval-line-reassignment.js';
import type { GuardedLineTarget } from '../domain/approval-line-reassignment.js';
import type { ApprovalApprover } from '../domain/approval-lines.js';
import { approverConfigOfTarget, violatesSegregation } from '../domain/approval-withdrawal.js';
import type { ReassignTarget } from '../domain/approval-withdrawal.js';
import type { RequestingUnitsOf, ResolvedApprover } from '../domain/approval.js';

export interface ReassignApprovalInput {
  readonly approvalId: string;
  /**
   * US-135: a linha redirecionada (APV-06 — o `If-Match` é a versão DELA); `null` = APV-05 (a
   * única linha da aprovação — o `If-Match` é a versão da aprovação, como no MVP 1).
   */
  readonly approvalApproverId: string | null;
  readonly body: ReassignApproval;
  /** `If-Match` (DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição (auditoria `approval.reassign`). */
  readonly idempotencyKey: string | null;
}

export interface ReassignedApproval {
  readonly dto: ApprovalDto;
  readonly processId: string;
  /** A linha nova (APV-06 `meta.newApproverId`). */
  readonly newApproverId: string;
  readonly sequence: number;
  readonly fromType: ApproverType;
  readonly toType: ApproverType;
}

/** 422 `APPROVER_NOT_ELIGIBLE` (V-03 · RN-APV-53): igual ao atual ou inelegível. */
function approverNotEligible(): ApiError {
  return new ApiError('APPROVER_NOT_ELIGIBLE', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.approverNotEligible,
  });
}

/** 403 `SELF_APPROVAL_FORBIDDEN` (V-04 · RN-APV-53): auditado como `access.denied`. */
function reassignSelfApproval(approvalId: string, lineId: string): ApiError {
  return new ApiError('SELF_APPROVAL_FORBIDDEN', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.selfApproval,
    auditReasonCode: 'APPROVAL_REASSIGN',
    auditEntity: { type: 'Approval', id: approvalId },
    auditMetadata: { approvalApproverId: lineId },
  });
}

/** 422 `APPROVER_DUPLICATED` (V-05 · RN-APV-53): a pessoa já participa de outra linha. */
function approverDuplicated(error: ReassignDuplicatedError): ApiError {
  return new ApiError('APPROVER_DUPLICATED', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.approverDuplicated,
    extensions: { meta: { sequences: [error.otherSequence, error.sequence] } },
  });
}

/** 409 `APPROVAL_LINE_NOT_PENDING` (V-07 · RN-APV-51): a linha já foi decidida, pulada ou cancelada. */
function lineNotPending(line: ApprovalApprover): ApiError {
  return new ApiError('APPROVAL_LINE_NOT_PENDING', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.lineNotPending,
    extensions: { meta: { approvalApproverId: line.id, lineStatus: line.status } },
  });
}

/** 422 `APPROVAL_LINE_REQUIRED` (V-08 · RN-APV-60): APV-05 numa aprovação com várias linhas. */
function lineRequired(linesCount: number): ApiError {
  return new ApiError('APPROVAL_LINE_REQUIRED', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.lineRequired,
    extensions: { meta: { linesCount } },
  });
}

/**
 * `ReassignApprovalCommand` — APV-06 (US-135 · redirecionar UMA linha) e APV-05 (US-053, agora a
 * mesma lógica sobre a única linha — RN-APV-60), no padrão `TransactionalCommandHandler`, sem tocar
 * etapa, tramitação nem documentos. Em UMA transação do tenant: a aprovação do tenant (404) → o
 * dono do sujeito trava o processo (ordem processo → aprovação) → `SELECT … FOR UPDATE` e as linhas
 * relidas sob a trava → (RN-APV-59) não `PENDING` = 409 `APPROVAL_NOT_PENDING`; linha decidida,
 * dispensada ou cancelada = 409 `APPROVAL_LINE_NOT_PENDING`; `If-Match` (412 — da linha no APV-06,
 * da aprovação no APV-05; APV-05 com várias linhas = 422 `APPROVAL_LINE_REQUIRED`) →
 * `APPROVAL_REASSIGN` cobrindo o processo (403 auditado) → processo nem suspenso nem final (409) →
 * o novo aprovador pela resolução da US-051 — inelegível ou igual ao atual = 422
 * `APPROVER_NOT_ELIGIBLE`; segregação (403 `SELF_APPROVAL_FORBIDDEN`; no APV-06 o titular autor vai
 * para o substituto — RN-APV-20); outra linha = 422 `APPROVER_DUPLICATED` → "cancelar e criar"
 * (RN-APV-52) → `ApprovalReassigned` (timeline e troca do `ProcessAccess` `APPROVER` no mesmo `tx`)
 * → `approval.reassign`. O motivo nunca vai a log, banco nem payload — só `hasReason`.
 */
@Injectable()
export class ReassignApprovalCommand extends TransactionalCommandHandler<
  ReassignApprovalInput,
  void,
  ReassignedApproval
> {
  constructor(
    @Inject(APPROVAL_TRANSACTIONS) transactions: ApprovalTransactions,
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(APPROVAL_CLOCK) private readonly clock: ApprovalClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly subjects: ApprovalSubjectRegistry,
    private readonly processes: ProcessAccessRegistry,
    private readonly access: AccessFacade,
    private readonly resolver: ApproverResolver,
    private readonly policy: ApprovalDecisionPolicy,
    private readonly presenter: ApprovalPresenter,
  ) {
    super('approval.reassign', transactions);
  }

  override async execute(input: ReassignApprovalInput): Promise<ReassignedApproval> {
    try {
      return await super.execute(input);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        // Recusa de regra (4xx): só o código — nunca o motivo do redirecionamento.
        this.logger.warn(
          {
            event: 'approval.reassign_rejected',
            approvalId: input.approvalId,
            approvalApproverId: input.approvalApproverId,
            code: error.code,
            reason: rejectionReasonOf(error.code),
            correlationId: requireRequestContext().correlationId,
          },
          'approval.reassign_rejected',
        );
      }
      throw error;
    }
  }

  protected prepare(): Promise<void> {
    return Promise.resolve();
  }

  protected async handle(tx: TenantTx, input: ReassignApprovalInput): Promise<ReassignedApproval> {
    const userId = requireRequestContext().actor.userId ?? '';
    const now = this.clock();

    // A aprovação do tenant; o dono do sujeito trava o processo ANTES da aprovação.
    const found = await this.approvals.findById(tx, input.approvalId);
    if (found === null) throw approvalNotFound();
    const handler = this.subjects.handlerFor(found.approval.subjectType);
    if (handler === null) throw approvalNotFound();
    const subject: DecisionSubject = withdrawalSubjectOf(found);
    const facts = await handler.prepareDecision(tx, subject);
    if (facts === null) throw approvalNotFound();
    const approval = await this.approvals.lockForUpdate(tx, input.approvalId);
    if (approval === null) throw approvalNotFound();
    if (approval.status !== 'PENDING') throw approvalNoLongerPending(approval);

    // RN-APV-59: a linha (relida sob a trava) e o `If-Match`.
    const lines = await this.approvals.findLines(tx, approval.id);
    const line = this.targetLine(approval, lines, input);

    // APPROVAL_REASSIGN cobrindo o processo (403 + `access.denied`) e processo em andamento.
    const target = await this.processes.load(tx, approval.processId);
    if (target === null) throw approvalNotFound();
    await this.access.assertCanOnProcess(
      'APPROVAL_REASSIGN',
      target,
      APPROVAL_WITHDRAWAL_MESSAGES.reassignDenied,
    );
    if (!isDecidableProcessStatus(facts.processStatus)) {
      throw processNotWithdrawable(facts.processStatus);
    }

    // RN-APV-53 — o novo aprovador: elegível, diferente do atual, sem autoria e em linha única.
    const resolved = await this.eligibleApprover(tx, input.body, facts, now);
    if (resolved === null || isSameLineApprover(line, resolved)) throw approverNotEligible();
    const guarded = await this.segregated(tx, input, approval, line, resolved, facts, now);
    try {
      assertNotInOtherLine(lines, line.sequence, guarded);
    } catch (error) {
      if (error instanceof ReassignDuplicatedError) throw approverDuplicated(error);
      throw error;
    }

    // RN-APV-52 — "cancelar e criar" (a trava garante as versões; os WHERE são a rede).
    const write = reassignLine(approval, lines, line, guarded, { now, newId, userId });
    const recorded = await this.approvals.recordLineReassignment(
      tx,
      {
        approval: write.approval,
        lineBefore: line,
        canceled: write.canceled,
        created: write.created,
      },
      approval.version,
      userId,
    );
    if (!recorded) throw withdrawalVersionConflict(input.expectedVersion, approval.version + 1);
    const { created } = write;
    await this.outbox.record(
      tx,
      ApprovalReassigned.of({
        aggregateId: approval.id,
        processId: approval.processId,
        payload: {
          approvalId: approval.id,
          fromApproverType: line.approverType,
          fromApproverUserId: line.approverUserId,
          fromApproverRoleId: line.approverRoleId,
          fromApproverDepartmentId: line.approverDepartmentId,
          approverType: created.approverType,
          toApproverUserId: created.approverUserId,
          toApproverRoleId: created.approverRoleId,
          toApproverDepartmentId: created.approverDepartmentId,
          allowDeputy: created.allowDeputy,
          hasReason: true,
          approvalApproverId: created.id,
          sequence: created.sequence,
          fromApprovalApproverId: line.id,
        },
      }),
    );
    await this.audit.record(tx, {
      action: 'approval.reassign',
      entityType: 'Approval',
      entityId: approval.id,
      processId: approval.processId,
      changes: [
        { path: 'approverType', old: line.approverType, new: created.approverType },
        { path: 'approverUserId', old: line.approverUserId, new: created.approverUserId },
        { path: 'approverRoleId', old: line.approverRoleId, new: created.approverRoleId },
        {
          path: 'approverDepartmentId',
          old: line.approverDepartmentId,
          new: created.approverDepartmentId,
        },
      ],
      metadata: {
        processCode: facts.processCode,
        subjectType: approval.subjectType,
        approvalId: approval.id,
        approvalApproverId: created.id,
        fromApprovalApproverId: line.id,
        sequence: created.sequence,
        decisionPolicy: approval.decisionPolicy ?? 'ANY',
        allowDeputy: created.allowDeputy,
        selfApprovalAvoided: guarded.selfApprovalAvoided,
        hasReason: true,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const view = (await handler.describeSubject(tx, subject)) ?? { ...facts, documents: [] };
    return {
      dto: await this.presenter.present(tx, write.approval, view),
      processId: approval.processId,
      newApproverId: created.id,
      sequence: created.sequence,
      fromType: line.approverType,
      toType: created.approverType,
    };
  }

  protected override committed(result: ReassignedApproval, durationMs: number): void {
    // Só ids e tipos: nunca o motivo, nomes ou e-mails (story · Logs).
    this.logger.log(
      {
        event: 'approval.line_reassigned',
        approvalId: result.dto.id,
        processId: result.processId,
        approvalApproverId: result.newApproverId,
        sequence: result.sequence,
        fromType: result.fromType,
        toType: result.toType,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'approval.line_reassigned',
    );
  }

  /**
   * RN-APV-59/60: APV-06 — a linha pedida (de outra aprovação = 404), ainda `PENDING`/`WAITING`
   * (409), na versão do `If-Match` (412); APV-05 — `If-Match` da aprovação (412) e a única linha
   * (várias = 422 `APPROVAL_LINE_REQUIRED`).
   */
  private targetLine(
    approval: ApprovalRecord,
    lines: readonly ApprovalApprover[],
    input: ReassignApprovalInput,
  ): ApprovalApprover {
    try {
      if (input.approvalApproverId !== null) {
        const line = reassignableLineOf(lines, input.approvalApproverId);
        if (input.expectedVersion !== line.version) {
          throw withdrawalVersionConflict(input.expectedVersion, line.version);
        }
        return line;
      }
      if (input.expectedVersion !== approval.version) {
        throw withdrawalVersionConflict(input.expectedVersion, approval.version);
      }
      return singleLineOf(lines);
    } catch (error) {
      if (error instanceof ApprovalLineNotFoundError) throw approvalNotFound();
      if (error instanceof ApprovalLineNotReassignableError) throw lineNotPending(error.line);
      if (error instanceof ApprovalLineRequiredError) throw lineRequired(error.linesCount);
      if (error instanceof ApprovalNotPendingError) throw approvalNoLongerPending(approval);
      throw error;
    }
  }

  /**
   * Segregação do novo aprovador (`approval.preventSelfApproval`): no APV-05, a regra do MVP 1
   * (RN-TRAM-62 — autor = recusa); no APV-06, a da linha (RN-APV-53 → RN-APV-20 — titular autor vai
   * para o substituto ativo da unidade, `allowDeputy = false`; sem ele, recusa).
   */
  private async segregated(
    tx: TenantTx,
    input: ReassignApprovalInput,
    approval: ApprovalRecord,
    line: ApprovalApprover,
    resolved: ResolvedApprover,
    facts: DecisionSubjectFacts,
    now: Date,
  ): Promise<GuardedLineTarget> {
    const preventSelfApproval = await this.policy.preventsSelfApprovalIn(tx);
    if (input.approvalApproverId === null) {
      if (violatesSegregation(resolved, facts.authorIds, preventSelfApproval)) {
        throw reassignSelfApproval(approval.id, line.id);
      }
      return { ...resolved, selfApprovalAvoided: false };
    }
    const authorIds = new Set(facts.authorIds);
    const headIsAuthor =
      preventSelfApproval &&
      resolved.approverType === 'DEPARTMENT_HEAD' &&
      resolved.approverUserId !== null &&
      authorIds.has(resolved.approverUserId);
    const deputyUserId =
      headIsAuthor && resolved.approverDepartmentId !== null
        ? await this.resolver.activeDeputyOf(tx, resolved.approverDepartmentId, now)
        : null;
    try {
      return guardLineTarget(line.sequence, resolved, {
        preventSelfApproval,
        authorIds,
        deputyUserId,
      });
    } catch (error) {
      if (error instanceof ReassignSelfApprovalError) {
        throw reassignSelfApproval(approval.id, line.id);
      }
      throw error;
    }
  }

  /**
   * POL-03 · DEC-022 (RN-APV-53 · RN-TRAM-69): a resolução da US-051 sobre o alvo (`USER` com
   * vínculo ativo; `ROLE` ativo, com `APPROVAL_DECIDE` e detentor competente sobre a unidade
   * solicitante; `DEPARTMENT_HEAD` = titular atual ativo da unidade). `null` = inelegível — inclusive
   * alvo de outro tenant, que a RLS não deixa ler.
   */
  private async eligibleApprover(
    tx: TenantTx,
    body: ReassignApproval,
    facts: RequestingUnitsOf,
    now: Date,
  ): Promise<ResolvedApprover | null> {
    const target: ReassignTarget = {
      approverType: body.approverType,
      targetApproverUserId: body.targetApproverUserId ?? null,
      targetApproverRoleId: body.targetApproverRoleId ?? null,
      targetApproverDepartmentId: body.targetApproverDepartmentId ?? null,
    };
    if (target.approverType === 'ROLE') {
      const role = await this.access.findRoleForApproval(tx, target.targetApproverRoleId ?? '');
      if (role === null || !role.isActive || !role.canDecideApprovals) return null;
    }
    return this.resolver.preview(tx, approverConfigOfTarget(target), facts, now);
  }
}

/** `warn approval.reassign_rejected` (story · Logs): o motivo codificado da recusa. */
function rejectionReasonOf(code: string): string {
  switch (code) {
    case 'APPROVER_NOT_ELIGIBLE':
      return 'NOT_ELIGIBLE';
    case 'APPROVER_DUPLICATED':
      return 'DUPLICATED';
    case 'APPROVAL_LINE_NOT_PENDING':
      return 'LINE_NOT_PENDING';
    default:
      return code;
  }
}

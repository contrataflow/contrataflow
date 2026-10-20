import { APPROVAL_WITHDRAWAL_MESSAGES, ApprovalReassigned } from '@contrataflow/validation';
import type { ApprovalDto, ReassignApproval } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApprovalSubjectRegistry } from '#shared/approval/approval-subject.js';
import type { DecisionSubject } from '#shared/approval/approval-subject.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { ProcessAccessRegistry } from '#shared/auth/process-access.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
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
import { isDecidableProcessStatus } from '../domain/approval-decision.js';
import {
  approverConfigOfTarget,
  isSameApprover,
  reassignApproval,
  violatesSegregation,
} from '../domain/approval-withdrawal.js';
import type { ReassignTarget } from '../domain/approval-withdrawal.js';
import type { RequestingUnitsOf, ResolvedApprover } from '../domain/approval.js';

export interface ReassignApprovalInput {
  readonly approvalId: string;
  readonly body: ReassignApproval;
  /** `If-Match` (a versão lida em APV-02 — DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição (auditoria `approval.reassign`). */
  readonly idempotencyKey: string | null;
}

export interface ReassignedApproval {
  readonly dto: ApprovalDto;
  readonly processId: string;
  readonly fromApproverId: string | null;
  readonly toApproverId: string | null;
}

/** 422 `APPROVER_NOT_ELIGIBLE` (V-02 · RN-TRAM-69): igual ao atual ou inelegível. */
function approverNotEligible(): ApiError {
  return new ApiError('APPROVER_NOT_ELIGIBLE', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.approverNotEligible,
  });
}

/** 403 `SELF_APPROVAL_FORBIDDEN` (V-05 · RN-TRAM-62): auditado como `access.denied`. */
function reassignSelfApproval(approvalId: string): ApiError {
  return new ApiError('SELF_APPROVAL_FORBIDDEN', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.selfApproval,
    auditReasonCode: 'APPROVAL_REASSIGN',
    auditEntity: { type: 'Approval', id: approvalId },
  });
}

/** Id de quem o registro nomeia (usuário, perfil ou unidade) — logs, nunca o nome. */
function approverIdOf(approver: ResolvedApprover): string | null {
  switch (approver.approverType) {
    case 'USER':
      return approver.approverUserId;
    case 'ROLE':
      return approver.approverRoleId;
    case 'DEPARTMENT_HEAD':
      return approver.approverDepartmentId;
  }
}

/**
 * `ReassignApprovalCommand` — APV-05 (US-053 · FA-02 · RN-TRAM-69..71): o padrão
 * `TransactionalCommandHandler` coordenado pelo `approval`, sem tocar etapa, tramitação nem
 * documentos. Em UMA transação do tenant: a aprovação do tenant (404) → o dono do sujeito trava o
 * processo (ordem processo → aprovação) → `SELECT … FOR UPDATE`: não `PENDING` = 409 antes do
 * `If-Match` (412) → `APPROVAL_REASSIGN` cobrindo o processo (403 auditado) → processo nem suspenso
 * nem final (409) → o novo aprovador pela resolução da US-051 (vínculo ativo; perfil com
 * `APPROVAL_DECIDE` e detentor competente; titular atual da unidade) — inelegível ou igual ao atual
 * = 422 `APPROVER_NOT_ELIGIBLE`; autor de documento coberto = 403 `SELF_APPROVAL_FORBIDDEN` → a
 * troca (`WHERE status = PENDING AND version`) → `ApprovalReassigned` (timeline e troca do
 * `ProcessAccess` `APPROVER` no mesmo `tx`) → `approval.reassign`. O motivo nunca vai a log nem a
 * payload (pode conter dado pessoal sensível).
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
        this.logger.log(
          {
            event: 'approval.reassign_rejected',
            approvalId: input.approvalId,
            code: error.code,
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
    const { body } = input;

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
    if (input.expectedVersion !== approval.version) {
      throw withdrawalVersionConflict(input.expectedVersion, approval.version);
    }

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

    // RN-TRAM-69 — o novo aprovador: elegível, diferente do atual e sem autoria de documento.
    const resolved = await this.eligibleApprover(tx, body, facts, now);
    if (resolved === null || isSameApprover(approval, resolved)) throw approverNotEligible();
    if (
      violatesSegregation(resolved, facts.authorIds, await this.policy.preventsSelfApprovalIn(tx))
    ) {
      throw reassignSelfApproval(approval.id);
    }

    // RN-TRAM-70 — só o aprovador muda (a trava garante a versão; o WHERE é a rede).
    const reassigned = reassignApproval(approval, resolved, now);
    if (!(await this.approvals.recordReassignment(tx, reassigned, approval.version, userId))) {
      throw withdrawalVersionConflict(input.expectedVersion, reassigned.version);
    }
    await this.outbox.record(
      tx,
      ApprovalReassigned.of({
        aggregateId: reassigned.id,
        processId: reassigned.processId,
        payload: {
          approvalId: reassigned.id,
          fromApproverType: approval.approverType,
          fromApproverUserId: approval.approverUserId,
          fromApproverRoleId: approval.approverRoleId,
          fromApproverDepartmentId: approval.approverDepartmentId,
          approverType: reassigned.approverType,
          toApproverUserId: reassigned.approverUserId,
          toApproverRoleId: reassigned.approverRoleId,
          toApproverDepartmentId: reassigned.approverDepartmentId,
          allowDeputy: reassigned.allowDeputy,
          hasReason: true,
        },
      }),
    );
    await this.audit.record(tx, {
      action: 'approval.reassign',
      entityType: 'Approval',
      entityId: reassigned.id,
      processId: reassigned.processId,
      changes: [
        { path: 'approverType', old: approval.approverType, new: reassigned.approverType },
        { path: 'approverUserId', old: approval.approverUserId, new: reassigned.approverUserId },
        { path: 'approverRoleId', old: approval.approverRoleId, new: reassigned.approverRoleId },
        {
          path: 'approverDepartmentId',
          old: approval.approverDepartmentId,
          new: reassigned.approverDepartmentId,
        },
      ],
      metadata: {
        processCode: facts.processCode,
        subjectType: reassigned.subjectType,
        allowDeputy: reassigned.allowDeputy,
        hasReason: true,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const view = (await handler.describeSubject(tx, subject)) ?? { ...facts, documents: [] };
    return {
      dto: await this.presenter.present(tx, reassigned, view),
      processId: reassigned.processId,
      fromApproverId: approverIdOf(approval),
      toApproverId: approverIdOf(reassigned),
    };
  }

  protected override committed(result: ReassignedApproval): void {
    // Nunca logar o motivo (story · Logs — ex.: licença médica).
    this.logger.log(
      {
        event: 'approval.reassigned',
        approvalId: result.dto.id,
        processId: result.processId,
        fromApproverId: result.fromApproverId,
        toApproverId: result.toApproverId,
        correlationId: requireRequestContext().correlationId,
      },
      'approval.reassigned',
    );
  }

  /**
   * POL-03 · DEC-022 (RN-TRAM-69): a resolução da US-051 sobre o alvo (`USER` com vínculo ativo;
   * `ROLE` ativo, com `APPROVAL_DECIDE` e detentor competente sobre a unidade solicitante;
   * `DEPARTMENT_HEAD` = titular atual ativo da unidade). `null` = inelegível.
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

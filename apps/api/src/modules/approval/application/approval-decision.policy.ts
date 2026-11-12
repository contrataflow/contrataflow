import { APPROVAL_DECISION_MESSAGES } from '@contrataflow/validation';
import type { ProcessStatus } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { DecisionSubjectFacts } from '#shared/approval/approval-subject.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { ApprovalRecord, ApproverUnit } from '../domain/approval-decision.js';
import type { ApprovalApprover } from '../domain/approval-lines.js';
import type { LineDesignationFacts, LineSelectionProblem } from '../domain/approval-vote.js';

const PREVENT_SELF_APPROVAL = 'approval.preventSelfApproval';

/**
 * POL-03 (permissions.md §6 · DEC-022 · US-052 → US-134 por linha): lê no `tx` do chamador o que a
 * designação de cada linha precisa — detentores competentes de cada perfil
 * (`AccessFacade.roleHoldersInScopeIn`, o mesmo predicado da solicitação — US-051), o titular e o
 * substituto ATUAIS de cada unidade aprovadora — e a configuração `approval.preventSelfApproval`
 * (segregação — RN-TRAM-62/RN-APV-43). A decisão é de `lineDesignationOf`/`selectVoteLine`.
 */
@Injectable()
export class ApprovalDecisionPolicy {
  constructor(
    private readonly access: AccessFacade,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
  ) {}

  /**
   * US-134: o que a designação das linhas precisa, numa leitura por perfil e uma por unidade
   * distintos (até 20 linhas — RN-APV-17). Linhas canceladas não contam.
   */
  async lineDesignationFactsIn(
    tx: TenantTx,
    lines: readonly ApprovalApprover[],
    facts: DecisionSubjectFacts,
    userId: string,
    now: Date,
  ): Promise<LineDesignationFacts> {
    const live = lines.filter((line) => line.status !== 'CANCELED');
    const roleIds = new Set(
      live.flatMap((line) =>
        line.approverType === 'ROLE' && line.approverRoleId !== null ? [line.approverRoleId] : [],
      ),
    );
    const departmentIds = new Set(
      live.flatMap((line) =>
        line.approverType === 'DEPARTMENT_HEAD' && line.approverDepartmentId !== null
          ? [line.approverDepartmentId]
          : [],
      ),
    );
    const roleHolders = new Map<string, readonly string[]>();
    for (const roleId of roleIds) {
      roleHolders.set(
        roleId,
        await this.access.roleHoldersInScopeIn(
          tx,
          roleId,
          {
            organizationId: facts.organizationId,
            departmentIds: [facts.requestingSecretariatId, facts.requestingDepartmentId],
          },
          now,
        ),
      );
    }
    const units = new Map<string, ApproverUnit | null>();
    for (const departmentId of departmentIds) {
      const unit = await this.organization.findDepartmentForApproval(tx, departmentId);
      units.set(
        departmentId,
        unit === null ? null : { headUserId: unit.headUserId, deputyUserId: unit.deputyUserId },
      );
    }
    return { userId, roleHolders, units };
  }

  /** `approval.preventSelfApproval` (padrão `true` — settings.ts). */
  async preventsSelfApprovalIn(tx: TenantTx): Promise<boolean> {
    const value = (await this.tenancy.settingValues(tx, [PREVENT_SELF_APPROVAL])).get(
      PREVENT_SELF_APPROVAL,
    );
    return value !== false;
  }
}

/** 404 `APPROVAL_NOT_FOUND`: inexistente, de outro tenant ou não visível (api.md §1.5). */
export function approvalNotFound(): ApiError {
  return new ApiError('APPROVAL_NOT_FOUND', { detail: APPROVAL_DECISION_MESSAGES.notFound });
}

/** 409 `APPROVAL_NOT_PENDING` (V-05 · RN-TRAM-63): a decisão registrada vai na extensão. */
export function approvalNotPending(approval: ApprovalRecord): ApiError {
  return new ApiError('APPROVAL_NOT_PENDING', {
    detail: APPROVAL_DECISION_MESSAGES.notPending,
    extensions: { status: approval.status, decision: approval.decision },
  });
}

/** 412 `VERSION_CONFLICT` (RN-TRAM-63): `If-Match` diferente da versão da aprovação. */
export function approvalVersionConflict(sentVersion: number, currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: APPROVAL_DECISION_MESSAGES.versionConflict,
    extensions: { currentVersion, sentVersion },
  });
}

/** 403 `NOT_DESIGNATED_APPROVER` (POL-03): auditado como `access.denied` (`APPROVAL_DECIDE`). */
export function notDesignatedApprover(approvalId: string): ApiError {
  return new ApiError('NOT_DESIGNATED_APPROVER', {
    detail: APPROVAL_DECISION_MESSAGES.notDesignated,
    auditReasonCode: 'APPROVAL_DECIDE',
    auditEntity: { type: 'Approval', id: approvalId },
    auditMetadata: { approvalId },
  });
}

/**
 * US-134 — recusas da escolha da linha (RN-APV-33/40): 422 `CONDITIONAL_REQUIRED` em
 * `approvalApproverId` (V-03), 403 `NOT_DESIGNATED_APPROVER` (V-04; V-07 com `meta.reason =
 * LINE_WAITING`, ambos `access.denied` com a linha) e 409 `APPROVAL_LINE_NOT_PENDING` (V-06).
 */
export function lineSelectionRefused(
  approvalId: string,
  problem: LineSelectionProblem,
  line: Pick<ApprovalApprover, 'id' | 'status'> | null,
): ApiError {
  switch (problem) {
    case 'LINE_REQUIRED':
      return validationError([
        {
          field: 'approvalApproverId',
          code: 'CONDITIONAL_REQUIRED',
          message: APPROVAL_DECISION_MESSAGES.lineRequired,
        },
      ]);
    case 'NOT_LINE_APPROVER':
      return new ApiError('NOT_DESIGNATED_APPROVER', {
        detail: APPROVAL_DECISION_MESSAGES.notLineApprover,
        auditReasonCode: 'APPROVAL_DECIDE',
        auditEntity: { type: 'Approval', id: approvalId },
        auditMetadata: { approvalId, approvalApproverId: line?.id ?? null },
        extensions: { meta: { reason: 'NOT_LINE_APPROVER' } },
      });
    case 'LINE_WAITING':
      return new ApiError('NOT_DESIGNATED_APPROVER', {
        detail: APPROVAL_DECISION_MESSAGES.lineWaiting,
        auditReasonCode: 'APPROVAL_DECIDE',
        auditEntity: { type: 'Approval', id: approvalId },
        auditMetadata: { approvalId, approvalApproverId: line?.id ?? null },
        extensions: { meta: { reason: 'LINE_WAITING', approvalApproverId: line?.id ?? null } },
      });
    case 'LINE_NOT_PENDING':
      return new ApiError('APPROVAL_LINE_NOT_PENDING', {
        detail: APPROVAL_DECISION_MESSAGES.lineNotPending,
        extensions: {
          meta: { approvalApproverId: line?.id ?? null, lineStatus: line?.status ?? null },
        },
      });
  }
}

/** 409 `APPROVER_ALREADY_VOTED` (RN-APV-33 · FA-03 · V-08): a pessoa já decidiu outra linha. */
export function approverAlreadyVoted(): ApiError {
  return new ApiError('APPROVER_ALREADY_VOTED', {
    detail: APPROVAL_DECISION_MESSAGES.alreadyVoted,
  });
}

/** 403 `SELF_APPROVAL_FORBIDDEN` (RN-TRAM-62 · RN-APV-43): auditado como `access.denied`. */
export function selfApprovalForbidden(
  approvalId: string,
  approvalApproverId: string | null = null,
): ApiError {
  return new ApiError('SELF_APPROVAL_FORBIDDEN', {
    detail: APPROVAL_DECISION_MESSAGES.selfApproval,
    auditReasonCode: 'APPROVAL_DECIDE',
    auditEntity: { type: 'Approval', id: approvalId },
    auditMetadata:
      approvalApproverId === null ? { approvalId } : { approvalId, approvalApproverId },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (POL-03): processo suspenso ou em status final. */
export function processNotDecidable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: APPROVAL_DECISION_MESSAGES.processStatus,
    extensions: { processStatus: status },
  });
}

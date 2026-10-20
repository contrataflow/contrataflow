import { APPROVAL_DECISION_MESSAGES } from '@contrataflow/validation';
import type { ProcessStatus } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { DecisionSubjectFacts } from '#shared/approval/approval-subject.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { designationOf } from '../domain/approval-decision.js';
import type { ApprovalRecord, Designation } from '../domain/approval-decision.js';

const PREVENT_SELF_APPROVAL = 'approval.preventSelfApproval';

/**
 * POL-03 (permissions.md §6 · DEC-022 · US-052): lê no `tx` do chamador o que a designação precisa
 * — detentores competentes do perfil (`AccessFacade.roleHoldersInScopeIn`, o mesmo predicado da
 * solicitação — US-051), o titular e o substituto ATUAIS da unidade aprovadora — e a configuração
 * `approval.preventSelfApproval` (segregação — RN-TRAM-62). A decisão é de `designationOf`.
 */
@Injectable()
export class ApprovalDecisionPolicy {
  constructor(
    private readonly access: AccessFacade,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
  ) {}

  async designationIn(
    tx: TenantTx,
    approval: ApprovalRecord,
    facts: DecisionSubjectFacts,
    userId: string,
    now: Date,
  ): Promise<Designation> {
    const roleHolderIds =
      approval.approverType === 'ROLE' && approval.approverRoleId !== null
        ? await this.access.roleHoldersInScopeIn(
            tx,
            approval.approverRoleId,
            {
              organizationId: facts.organizationId,
              departmentIds: [facts.requestingSecretariatId, facts.requestingDepartmentId],
            },
            now,
          )
        : [];
    const unit =
      approval.approverType === 'DEPARTMENT_HEAD' && approval.approverDepartmentId !== null
        ? await this.organization.findDepartmentForApproval(tx, approval.approverDepartmentId)
        : null;
    return designationOf(approval, {
      userId,
      roleHolderIds,
      unit: unit === null ? null : { headUserId: unit.headUserId, deputyUserId: unit.deputyUserId },
    });
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
  });
}

/** 403 `SELF_APPROVAL_FORBIDDEN` (RN-TRAM-62): auditado como `access.denied`. */
export function selfApprovalForbidden(approvalId: string): ApiError {
  return new ApiError('SELF_APPROVAL_FORBIDDEN', {
    detail: APPROVAL_DECISION_MESSAGES.selfApproval,
    auditReasonCode: 'APPROVAL_DECIDE',
    auditEntity: { type: 'Approval', id: approvalId },
  });
}

/** 409 `INVALID_PROCESS_STATUS` (POL-03): processo suspenso ou em status final. */
export function processNotDecidable(status: ProcessStatus): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    detail: APPROVAL_DECISION_MESSAGES.processStatus,
    extensions: { processStatus: status },
  });
}

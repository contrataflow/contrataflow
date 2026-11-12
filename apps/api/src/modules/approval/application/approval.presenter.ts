import type { ApprovalApproverDto, ApprovalDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { DecisionSubjectView } from '#shared/approval/approval-subject.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { ApproverResolver } from './approver-resolver.js';
import { APPROVAL_REPOSITORY } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';

/**
 * `Approval` de APV-02/APV-03 (US-052): os nomes de quem solicitou e decidiu, o rótulo do aprovador
 * (o mesmo da solicitação — US-051) e os documentos cobertos lidos pelo dono do sujeito. US-133
 * (aditivo): a política e as linhas (`approvers[]`) como estão no `tx` — sempre depois da escrita.
 */
@Injectable()
export class ApprovalPresenter {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    private readonly identity: IdentityFacade,
    private readonly resolver: ApproverResolver,
  ) {}

  async present(
    tx: TenantTx,
    approval: ApprovalRecord,
    subject: DecisionSubjectView,
  ): Promise<ApprovalDto> {
    const lines = await this.approvals.findLines(tx, approval.id);
    const userIds = [
      approval.requestedById,
      approval.decidedById,
      ...lines.map((line) => line.decidedById),
    ].filter((id): id is string => id !== null);
    const names = await this.identity.userDisplayNames(tx, [...new Set(userIds)]);
    const person = (id: string) => ({ id, name: names.get(id) ?? null });
    const approvers: ApprovalApproverDto[] = [];
    for (const line of lines) {
      approvers.push({
        id: line.id,
        sequence: line.sequence,
        status: line.status,
        approverType: line.approverType,
        userId: line.approverUserId,
        roleId: line.approverRoleId,
        departmentId: line.approverDepartmentId,
        allowDeputy: line.allowDeputy,
        label: await this.resolver.labelOf(tx, line),
        activatedAt: line.activatedAt?.toISOString() ?? null,
        dueAt: line.dueAt?.toISOString() ?? null,
        decision: line.decision,
        decidedBy: line.decidedById === null ? null : person(line.decidedById),
        decidedAt: line.decidedAt?.toISOString() ?? null,
        decidedAsDeputy: line.decidedAsDeputy,
        skippedReason: line.skippedReason,
        version: line.version,
      });
    }
    return {
      id: approval.id,
      subjectType: approval.subjectType,
      status: approval.status,
      title: approval.title,
      process: { id: approval.processId, code: subject.processCode, title: subject.processTitle },
      processStageId: approval.processStageId,
      documentId: approval.documentId,
      requestedBy: person(approval.requestedById),
      requestedAt: approval.requestedAt.toISOString(),
      requestComment: approval.requestComment,
      dueAt: approval.dueAt?.toISOString() ?? null,
      approver: {
        type: approval.approverType,
        userId: approval.approverUserId,
        roleId: approval.approverRoleId,
        departmentId: approval.approverDepartmentId,
        label: await this.resolver.labelOf(tx, approval),
      },
      allowDeputy: approval.allowDeputy,
      decision: approval.decision,
      decidedBy: approval.decidedById === null ? null : person(approval.decidedById),
      decidedAt: approval.decidedAt?.toISOString() ?? null,
      decisionComment: approval.decisionComment,
      decidedAsDeputy: approval.decidedAsDeputy,
      documents: [...subject.documents],
      decisionPolicy: approval.decisionPolicy ?? 'ANY',
      approvers,
      version: approval.version,
    };
  }
}

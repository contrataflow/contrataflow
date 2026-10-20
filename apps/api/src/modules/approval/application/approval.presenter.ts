import type { ApprovalDto } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { DecisionSubjectView } from '#shared/approval/approval-subject.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { ApproverResolver } from './approver-resolver.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';

/**
 * `Approval` de APV-02/APV-03 (US-052): os nomes de quem solicitou e decidiu, o rótulo do aprovador
 * (o mesmo da solicitação — US-051) e os documentos cobertos lidos pelo dono do sujeito.
 */
@Injectable()
export class ApprovalPresenter {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly resolver: ApproverResolver,
  ) {}

  async present(
    tx: TenantTx,
    approval: ApprovalRecord,
    subject: DecisionSubjectView,
  ): Promise<ApprovalDto> {
    const userIds = [approval.requestedById, approval.decidedById].filter(
      (id): id is string => id !== null,
    );
    const names = await this.identity.userDisplayNames(tx, userIds);
    const person = (id: string) => ({ id, name: names.get(id) ?? null });
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
      version: approval.version,
    };
  }
}

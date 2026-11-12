import { approvalLineCountsOf, approvalProgressOf } from '@contrataflow/validation';
import type { ApprovalApproverDto, ApprovalDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { DecisionSubjectView } from '#shared/approval/approval-subject.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ProcessBranchContextRegistry } from '#shared/process/process-branch-context.js';
import type { StageBranchContext } from '#shared/process/process-branch-context.js';

import { ApproverResolver } from './approver-resolver.js';
import { APPROVAL_REPOSITORY } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';
import type { ApprovalApprover } from '../domain/approval-lines.js';
import { currentLineOf } from '../domain/approval-list.js';

/** US-125 (aditivo · RN-WF2-37): os campos de ramo, só na aprovação de etapa de ramo. */
export function branchFieldsOf(context: StageBranchContext | undefined) {
  if (context === undefined) return {};
  return {
    branchKey: context.branchKey,
    branchLabel: context.branchLabel,
    siblings: [...context.siblings],
    siblingsMore: context.siblingsMore,
  };
}

/**
 * `Approval` de APV-02/APV-03 (US-052): os nomes de quem solicitou e decidiu, o rótulo do aprovador
 * (o mesmo da solicitação — US-051) e os documentos cobertos lidos pelo dono do sujeito. US-133
 * (aditivo): a política e as linhas (`approvers[]`) como estão no `tx` — sempre depois da escrita.
 * US-136 (aditivo): o comentário da decisão por linha, o andamento (RN-APV-70) e, no APV-02
 * (`liveOnly`), só a composição vigente — as `CANCELED` ficam no histórico (APV-31 · RN-APV-68).
 */
@Injectable()
export class ApprovalPresenter {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    private readonly identity: IdentityFacade,
    private readonly resolver: ApproverResolver,
    private readonly branches: ProcessBranchContextRegistry,
  ) {}

  async present(
    tx: TenantTx,
    approval: ApprovalRecord,
    subject: DecisionSubjectView,
    options: { readonly liveOnly?: boolean } = {},
  ): Promise<ApprovalDto> {
    const all = await this.approvals.findLines(tx, approval.id);
    const lines = options.liveOnly === true ? all.filter((l) => l.status !== 'CANCELED') : all;
    const approvers = await this.presentLines(tx, lines);
    const policy = approval.decisionPolicy ?? 'ANY';
    const current = currentLineOf(policy, approval.status, approvers);
    const names = await this.identity.userDisplayNames(
      tx,
      [approval.requestedById, approval.decidedById].filter((id): id is string => id !== null),
    );
    const person = (id: string) => ({ id, name: names.get(id) ?? null });
    // US-125 (RN-WF2-37): o ramo da etapa da aprovação e os irmãos (só aprovação de ramo).
    const branch =
      approval.processStageId === null
        ? undefined
        : (
            await this.branches.forStages(tx, [
              { processId: approval.processId, processStageId: approval.processStageId },
            ])
          ).get(approval.processStageId);
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
      decisionPolicy: policy,
      approvers,
      progress: approvalProgressOf({
        policy,
        approvalStatus: approval.status,
        counts: approvalLineCountsOf(all),
        current: current === null ? null : { sequence: current.sequence, label: current.label },
      }),
      version: approval.version,
      ...branchFieldsOf(branch),
    };
  }

  /** As linhas como APV-02/APV-31 as devolvem (nomes de quem decidiu por lote). */
  async presentLines(
    tx: TenantTx,
    lines: readonly ApprovalApprover[],
  ): Promise<ApprovalApproverDto[]> {
    const names = await this.identity.userDisplayNames(tx, [
      ...new Set(lines.flatMap((line) => (line.decidedById === null ? [] : [line.decidedById]))),
    ]);
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
        decisionComment: line.decisionComment,
        skippedReason: line.skippedReason,
        reassignedFromId: line.reassignedFromId,
        version: line.version,
      });
    }
    return approvers;
  }
}

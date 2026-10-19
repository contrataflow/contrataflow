import type { ApprovalDto, ApprovalMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApprovalSubjectRegistry } from '#shared/approval/approval-subject.js';
import type { DecisionSubject } from '#shared/approval/approval-subject.js';
import { ProcessAccessRegistry, isProcessVisible } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ApprovalDecisionPolicy, approvalNotFound } from './approval-decision.policy.js';
import { ApprovalPresenter } from './approval.presenter.js';
import { APPROVAL_CLOCK, APPROVAL_REPOSITORY, APPROVAL_TRANSACTIONS } from './ports.js';
import type { ApprovalClock, ApprovalRepository, ApprovalTransactions } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { decisionBlockerOf, isSelfApproval } from '../domain/approval-decision.js';
import type { ApprovalRecord, Designation } from '../domain/approval-decision.js';

export interface ApprovalDetail {
  readonly dto: ApprovalDto;
  readonly meta: ApprovalMeta;
}

/**
 * APV-02 — detalhe da aprovação (US-052 · SCR-015), somente leitura. Visível a quem está designado
 * (titular, substituto ou detentor competente do perfil — POL-03), a quem solicitou ou decidiu e,
 * com `APPROVAL_VIEW`, a quem vê o processo (DEC-024); visível sem a permissão = 403
 * `PERMISSION_DENIED`; inexistente, de outro tenant ou não visível = 404 `APPROVAL_NOT_FOUND`.
 * `meta.allowedActions`/`decisionBlocker` repetem as checagens do APV-03 (SCR-015 oculta as ações
 * e explica o motivo) e `decisionOptions` traz as saídas do workflow com as regras `TRANSITION`.
 */
@Injectable()
export class GetApprovalQuery {
  constructor(
    @Inject(APPROVAL_TRANSACTIONS) private readonly transactions: ApprovalTransactions,
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(APPROVAL_CLOCK) private readonly clock: ApprovalClock,
    private readonly subjects: ApprovalSubjectRegistry,
    private readonly policy: ApprovalDecisionPolicy,
    private readonly presenter: ApprovalPresenter,
    private readonly access: AccessFacade,
    private readonly processes: ProcessAccessRegistry,
  ) {}

  execute(approvalId: string): Promise<ApprovalDetail> {
    return this.transactions.read(async (tx) => {
      const userId = requireRequestContext().actor.userId ?? '';
      const found = await this.approvals.findById(tx, approvalId);
      if (found === null) throw approvalNotFound();
      const { approval } = found;
      const handler = this.subjects.handlerFor(approval.subjectType);
      const subject: DecisionSubject = {
        approvalId: approval.id,
        processId: approval.processId,
        subjectType: approval.subjectType,
        processStageId: approval.processStageId,
        documentId: approval.documentId,
        coverage: found.coverage.map((item) => ({
          documentId: item.documentId,
          documentVersionId: item.documentVersionId,
        })),
      };
      const view = handler === null ? null : await handler.describeSubject(tx, subject);
      if (handler === null || view === null) throw approvalNotFound();
      const designation = await this.policy.designationIn(tx, approval, view, userId, this.clock());
      await this.assertVisible(tx, approval, designation, userId);

      const selfApproval = isSelfApproval(
        view.authorIds,
        userId,
        await this.policy.preventsSelfApprovalIn(tx),
      );
      const blocker = decisionBlockerOf({
        status: approval.status,
        canDecide: this.access.can('APPROVAL_DECIDE'),
        designation,
        selfApproval,
        processStatus: view.processStatus,
      });
      const decisionOptions = blocker === null ? await handler.decisionOptions(tx, subject) : [];
      return {
        dto: await this.presenter.present(tx, approval, view),
        meta: {
          allowedActions: blocker === null ? ['DECIDE'] : [],
          decisionOptions,
          decidesAsDeputy: designation.asDeputy,
          decisionBlocker: blocker,
        },
      };
    });
  }

  /** DEC-024 · api.md §1.5: designado/envolvido vê; senão, processo visível + `APPROVAL_VIEW`. */
  private async assertVisible(
    tx: TenantTx,
    approval: ApprovalRecord,
    designation: Designation,
    userId: string,
  ): Promise<void> {
    if (
      designation.designated ||
      approval.requestedById === userId ||
      approval.decidedById === userId
    ) {
      return;
    }
    const target = await this.processes.load(tx, approval.processId);
    if (target === null || !isProcessVisible(await this.access.processVisibilityScope(), target)) {
      throw approvalNotFound();
    }
    if (!this.access.can('APPROVAL_VIEW')) {
      throw new ApiError('PERMISSION_DENIED', {
        detail: 'Você não tem permissão para ver esta aprovação.',
        auditReasonCode: 'APPROVAL_VIEW',
      });
    }
  }
}

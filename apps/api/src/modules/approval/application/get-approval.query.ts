import type {
  ApprovalAction,
  ApprovalDecisionOption,
  ApprovalDto,
  ApprovalMeta,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApprovalSubjectRegistry } from '#shared/approval/approval-subject.js';
import { ProcessAccessRegistry, isProcessVisible } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ApprovalDecisionPolicy, approvalNotFound } from './approval-decision.policy.js';
import { ApprovalWithdrawalService, withdrawalSubjectOf } from './approval-withdrawal.service.js';
import { ApprovalPresenter } from './approval.presenter.js';
import { APPROVAL_CLOCK, APPROVAL_REPOSITORY, APPROVAL_TRANSACTIONS } from './ports.js';
import type { ApprovalClock, ApprovalRepository, ApprovalTransactions } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { isDecidableProcessStatus, isSelfApproval } from '../domain/approval-decision.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';
import type { ApprovalApprover } from '../domain/approval-lines.js';
import {
  coveredLinesOf,
  lineDecisionBlockerOf,
  voteClosesApproval,
  voteExpectedVersion,
} from '../domain/approval-vote.js';

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
 * US-053: `WITHDRAW` (POL-17, pelo dono do sujeito) e `REASSIGN` (`APPROVAL_REASSIGN` cobrindo o
 * processo) enquanto a aprovação está pendente e o processo nem suspenso nem final. US-134 (por
 * linha, aditivo): `meta.myLine` (a linha de quem consulta e o `If-Match` do voto), as linhas que
 * ele pode decidir (`decidableLineIds`), `decisionOptions[].closesApproval` (só a opção que encerra
 * avalia as regras `TRANSITION` — RN-APV-38) e os bloqueios `ALREADY_VOTED`/`LINE_NOT_PENDING`.
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
    private readonly withdrawals: ApprovalWithdrawalService,
  ) {}

  execute(approvalId: string): Promise<ApprovalDetail> {
    return this.transactions.read(async (tx) => {
      const userId = requireRequestContext().actor.userId ?? '';
      const found = await this.approvals.findById(tx, approvalId);
      if (found === null) throw approvalNotFound();
      const { approval } = found;
      const handler = this.subjects.handlerFor(approval.subjectType);
      const subject = withdrawalSubjectOf(found);
      const view = handler === null ? null : await handler.describeSubject(tx, subject);
      if (handler === null || view === null) throw approvalNotFound();
      const { lines } = found;
      const facts = await this.policy.lineDesignationFactsIn(tx, lines, view, userId, this.clock());
      const covered = coveredLinesOf(lines, facts);
      const alreadyVoted = lines.some(
        (line) => line.decision !== null && line.decidedById === userId,
      );
      await this.assertVisible(tx, approval, covered.length > 0 || alreadyVoted, userId);

      // A linha de quem consulta: a `PENDING` de menor ordem, senão a em espera, a que ele decidiu
      // ou a primeira coberta (para explicar o bloqueio).
      const decidable = covered.filter((item) => item.line.status === 'PENDING');
      const mine =
        decidable[0] ??
        covered.find((item) => item.line.status === 'WAITING') ??
        covered.find((item) => item.line.decidedById === userId) ??
        covered[0] ??
        null;
      const selfApproval = isSelfApproval(
        view.authorIds,
        userId,
        await this.policy.preventsSelfApprovalIn(tx),
      );
      const blocker = lineDecisionBlockerOf({
        status: approval.status,
        canDecide: this.access.can('APPROVAL_DECIDE'),
        line: mine?.line ?? null,
        alreadyVoted,
        selfApproval,
        processStatus: view.processStatus,
      });
      const decisionOptions =
        blocker !== null || mine === null
          ? []
          : withClosure(approval, lines, mine.line, await handler.decisionOptions(tx, subject));
      const allowedActions: ApprovalAction[] = blocker === null ? ['DECIDE'] : [];
      // US-053: retirar (POL-17; US-135: também o gestor com `PROCESS_ASSIGN` amplo) e redirecionar
      // (`APPROVAL_REASSIGN` cobrindo o processo — por linha na aprovação múltipla, APV-06).
      if (approval.status === 'PENDING' && isDecidableProcessStatus(view.processStatus)) {
        if ((await this.withdrawals.withdrawerRoleIn(tx, handler, subject, userId)) !== null) {
          allowedActions.push('WITHDRAW');
        }
        const target = await this.processes.load(tx, approval.processId);
        if (target !== null && (await this.access.canOnProcess('APPROVAL_REASSIGN', target))) {
          allowedActions.push('REASSIGN');
        }
      }
      return {
        dto: await this.presenter.present(tx, approval, view),
        meta: {
          allowedActions,
          decisionOptions,
          decidesAsDeputy: mine?.designation.asDeputy ?? false,
          decisionBlocker: blocker,
          myLine:
            mine === null
              ? null
              : {
                  id: mine.line.id,
                  sequence: mine.line.sequence,
                  status: mine.line.status,
                  etag: `"${String(voteExpectedVersion(approval, mine.line))}"`,
                },
          decidableLineIds: blocker === null ? decidable.map((item) => item.line.id) : [],
        },
      };
    });
  }

  /** DEC-024 · api.md §1.5: designado/envolvido vê; senão, processo visível + `APPROVAL_VIEW`. */
  private async assertVisible(
    tx: TenantTx,
    approval: ApprovalRecord,
    designated: boolean,
    userId: string,
  ): Promise<void> {
    if (designated || approval.requestedById === userId || approval.decidedById === userId) {
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

/**
 * US-134 (RN-APV-38): `closesApproval` por opção, na linha de quem consulta. A opção que NÃO
 * encerra (voto positivo com outras linhas vivas) não avalia as regras `TRANSITION`: sem violações
 * e habilitada (avisos e bloqueios só valem para o voto que encerra).
 */
function withClosure(
  approval: ApprovalRecord,
  lines: readonly ApprovalApprover[],
  line: ApprovalApprover,
  options: readonly Omit<ApprovalDecisionOption, 'closesApproval'>[],
): ApprovalDecisionOption[] {
  const policy = approval.decisionPolicy ?? 'ANY';
  return options.map((option) => {
    const closesApproval = voteClosesApproval(policy, lines, line.id, option.decision);
    return closesApproval
      ? { ...option, closesApproval }
      : { ...option, closesApproval, enabled: true, violations: [] };
  });
}

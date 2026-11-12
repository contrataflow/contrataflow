import type {
  ApprovalAction,
  ApprovalApproverDto,
  ApprovalDecisionOption,
  ApprovalDto,
  ApprovalLineAction,
  ApprovalLinesResponse,
  ApprovalMeta,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

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
import { currentLineOf } from '../domain/approval-list.js';
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
  private readonly logger = new Logger('ApprovalLines');

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
      const dto = await this.presenter.present(tx, approval, view, { liveOnly: true });
      const decidableLineIds = blocker === null ? decidable.map((item) => item.line.id) : [];
      const waiting = currentLineOf(dto.decisionPolicy, approval.status, dto.approvers);
      return {
        dto,
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
          decidableLineIds,
          // US-136 (aditivo · RN-APV-68).
          myApproverLineId: mine?.line.id ?? null,
          lineActions: lineActionsOf(dto.approvers, decidableLineIds, allowedActions),
          waitingFor:
            waiting === null ? null : { sequence: waiting.sequence, label: waiting.label },
        },
      };
    });
  }

  /**
   * APV-31 (US-136 · RN-APV-69): todas as linhas, inclusive as `CANCELED` substituídas por
   * redirecionamento (com `includeHistory`), em ordem de `sequence` e criação, com a MESMA
   * autorização do APV-02. Somente leitura: sem auditoria (exceto o `access.denied` do 403).
   */
  lines(approvalId: string, includeHistory: boolean): Promise<ApprovalLinesResponse> {
    const startedAt = performance.now();
    return this.transactions.read(async (tx) => {
      const context = requireRequestContext();
      const userId = context.actor.userId ?? '';
      const found = await this.approvals.findById(tx, approvalId);
      if (found === null) throw approvalNotFound();
      const { approval, lines } = found;
      const handler = this.subjects.handlerFor(approval.subjectType);
      const view =
        handler === null ? null : await handler.describeSubject(tx, withdrawalSubjectOf(found));
      if (view === null) throw approvalNotFound();
      const facts = await this.policy.lineDesignationFactsIn(tx, lines, view, userId, this.clock());
      const involved =
        coveredLinesOf(lines, facts).length > 0 ||
        lines.some((line) => line.decidedById === userId);
      await this.assertVisible(tx, approval, involved, userId);
      const shown = includeHistory ? lines : lines.filter((line) => line.status !== 'CANCELED');
      const data: ApprovalApproverDto[] = await this.presenter.presentLines(tx, shown);
      this.logger.log(
        {
          event: 'approvals.lines_query',
          approvalId,
          includeHistory,
          linesCount: data.length,
          durationMs: Math.round(performance.now() - startedAt),
          tenantId: context.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'approvals.lines_query',
      );
      return {
        data,
        meta: {
          decisionPolicy: approval.decisionPolicy ?? 'ANY',
          totalLines: lines.filter((line) => line.status !== 'CANCELED').length,
          approvalStatus: approval.status,
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
      // US-136: o `access.denied` registra a aprovação negada (`approvalId`).
      throw new ApiError('PERMISSION_DENIED', {
        detail: 'Você não tem permissão para ver esta aprovação.',
        auditReasonCode: 'APPROVAL_VIEW',
        auditEntity: { type: 'Approval', id: approval.id },
        auditMetadata: { approvalId: approval.id },
      });
    }
  }
}

/**
 * US-136 (RN-APV-68): as ações de quem consulta em cada linha vigente — `DECIDE` nas linhas que ele
 * pode decidir agora (US-134) e `REASSIGN` nas vivas (`PENDING`/`WAITING`) quando pode redirecionar
 * (US-135). Nada é executado aqui.
 */
function lineActionsOf(
  lines: readonly ApprovalApproverDto[],
  decidableLineIds: readonly string[],
  allowedActions: readonly ApprovalAction[],
): { approvalApproverId: string; actions: ApprovalLineAction[] }[] {
  const canReassign = allowedActions.includes('REASSIGN');
  return lines.map((line) => {
    const actions: ApprovalLineAction[] = [];
    if (decidableLineIds.includes(line.id)) actions.push('DECIDE');
    if (canReassign && (line.status === 'PENDING' || line.status === 'WAITING')) {
      actions.push('REASSIGN');
    }
    return { approvalApproverId: line.id, actions };
  });
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

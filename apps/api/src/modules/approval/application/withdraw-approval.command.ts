import type { WithdrawApproval, WithdrawnApprovalDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { ApprovalSubjectKind } from '#shared/approval/approval-subject.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ApprovalWithdrawalService } from './approval-withdrawal.service.js';
import { ApprovalPresenter } from './approval.presenter.js';
import { APPROVAL_TRANSACTIONS } from './ports.js';
import type { ApprovalTransactions } from './ports.js';

export interface WithdrawApprovalInput {
  readonly approvalId: string;
  readonly body: WithdrawApproval;
  /** `If-Match` (a versão lida em APV-02 — DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição (auditoria `approval.withdraw`). */
  readonly idempotencyKey: string | null;
}

export interface WithdrawnApproval {
  readonly dto: WithdrawnApprovalDto;
  readonly processId: string;
  readonly documentId: string | null;
  readonly subjectType: ApprovalSubjectKind;
}

/**
 * `WithdrawApprovalCommand` — APV-04 (US-053 · fluxo principal, passo 4): o padrão
 * `TransactionalCommandHandler` com o `ApprovalWithdrawalService` (o mesmo núcleo do DOC-11). Em UMA
 * transação do tenant: cancela a aprovação (`WITHDRAWN`), devolve o processo à passagem de origem
 * (etapa) ou o documento a `DRAFT` (avulsa) e audita `approval.withdraw`; qualquer falha desfaz
 * tudo. Resposta: a aprovação cancelada com a etapa e o status atuais do processo. O motivo nunca
 * vai a log nem a payload.
 */
@Injectable()
export class WithdrawApprovalCommand extends TransactionalCommandHandler<
  WithdrawApprovalInput,
  void,
  WithdrawnApproval
> {
  constructor(
    @Inject(APPROVAL_TRANSACTIONS) transactions: ApprovalTransactions,
    private readonly withdrawals: ApprovalWithdrawalService,
    private readonly presenter: ApprovalPresenter,
  ) {
    super('approval.withdraw', transactions);
  }

  override async execute(input: WithdrawApprovalInput): Promise<WithdrawnApproval> {
    try {
      return await super.execute(input);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        // Recusa de regra (4xx): só o código — nunca o motivo da retirada.
        this.logger.log(
          {
            event: 'approval.withdraw_rejected',
            approvalId: input.approvalId,
            code: error.code,
            correlationId: requireRequestContext().correlationId,
          },
          'approval.withdraw_rejected',
        );
      }
      throw error;
    }
  }

  protected prepare(): Promise<void> {
    return Promise.resolve();
  }

  protected async handle(tx: TenantTx, input: WithdrawApprovalInput): Promise<WithdrawnApproval> {
    const reason = input.body.reason?.trim() ?? '';
    const outcome = await this.withdrawals.withdrawIn(tx, {
      approvalId: input.approvalId,
      expectedVersion: input.expectedVersion,
      reason: reason === '' ? null : reason,
      idempotencyKey: input.idempotencyKey,
    });
    const { canceled, subject, handler, facts, effects } = outcome;
    const view = (await handler.describeSubject(tx, subject)) ?? { ...facts, documents: [] };
    const dto = await this.presenter.present(tx, canceled, view);
    return {
      dto: { ...dto, processStage: effects.processStage, processStatus: effects.toStatus },
      processId: canceled.processId,
      documentId: canceled.documentId,
      subjectType: canceled.subjectType,
    };
  }

  protected override committed(result: WithdrawnApproval): void {
    // Nunca logar o motivo (texto livre — story · Logs).
    this.logger.log(
      {
        event: 'approval.withdrawn',
        approvalId: result.dto.id,
        processId: result.processId,
        documentId: result.documentId,
        subjectType: result.subjectType,
        correlationId: requireRequestContext().correlationId,
      },
      'approval.withdrawn',
    );
  }
}

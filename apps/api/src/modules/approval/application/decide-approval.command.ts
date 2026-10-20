import { withSpan } from '@contrataflow/observability';
import { ApprovalCompleted, ApprovalRejected, ApprovalReturned } from '@contrataflow/validation';
import type {
  ApprovalDecision,
  DecideApproval,
  DecidedApprovalDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApprovalSubjectRegistry } from '#shared/approval/approval-subject.js';
import type {
  ApprovalSubjectHandler,
  DecisionSubject,
  SubjectDecisionResult,
} from '#shared/approval/approval-subject.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import {
  TransactionalCommandHandler,
  failureCodeOf,
} from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { isTransientDatabaseError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  ApprovalDecisionPolicy,
  approvalNotFound,
  approvalNotPending,
  approvalVersionConflict,
  notDesignatedApprover,
  processNotDecidable,
  selfApprovalForbidden,
} from './approval-decision.policy.js';
import { recordApprovalDecided, recordApprovalDecideFailed } from './approval-telemetry.js';
import { ApprovalPresenter } from './approval.presenter.js';
import { APPROVAL_CLOCK, APPROVAL_REPOSITORY, APPROVAL_TRANSACTIONS } from './ports.js';
import type {
  ApprovalClock,
  ApprovalRepository,
  ApprovalTransactions,
  ApprovalWithCoverage,
} from './ports.js';
import {
  decideApproval,
  isDecidableProcessStatus,
  isSelfApproval,
} from '../domain/approval-decision.js';

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly body: DecideApproval;
  /** `If-Match` (a versão lida em APV-02 — DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição (auditoria `approval.decide`). */
  readonly idempotencyKey: string | null;
}

export interface DecidedApproval {
  readonly dto: DecidedApprovalDto;
  readonly processId: string;
  readonly subjectType: DecisionSubject['subjectType'];
  readonly decision: ApprovalDecision;
  readonly decidedAsDeputy: boolean;
  readonly effects: SubjectDecisionResult;
}

interface Prepared {
  readonly now: Date;
}

const EVENT_OF = {
  APPROVE: ApprovalCompleted,
  RETURN: ApprovalReturned,
  REJECT: ApprovalRejected,
} as const satisfies Record<ApprovalDecision, unknown>;

function subjectOf({ approval, coverage }: ApprovalWithCoverage): DecisionSubject {
  return {
    approvalId: approval.id,
    processId: approval.processId,
    subjectType: approval.subjectType,
    processStageId: approval.processStageId,
    documentId: approval.documentId,
    coverage: coverage.map((item) => ({
      documentId: item.documentId,
      documentVersionId: item.documentVersionId,
    })),
  };
}

/**
 * `DecideApprovalCommand` — APV-03 (US-052 · fluxo principal, passo 6): o padrão
 * `TransactionalCommandHandler` coordenado pelo `approval` (domains.md §4.4). Em UMA transação do
 * tenant: a aprovação do tenant (404) → o dono do sujeito trava o processo e lê os fatos (ordem de
 * bloqueio processo → aprovação → documentos) → `SELECT … FOR UPDATE` na aprovação: já decidida =
 * 409 `APPROVAL_NOT_PENDING` (antes do `If-Match`: quem perdeu a corrida recebe a decisão registrada
 * — FA-05), `If-Match` divergente = 412 → POL-03 (designação 403 `NOT_DESIGNATED_APPROVER`;
 * segregação 403 `SELF_APPROVAL_FORBIDDEN`; ambos `access.denied`) e processo decidível (409) → o
 * plano do sujeito SEM escrita (regras `TRANSITION`, destino, aprovador da próxima etapa) → a
 * decisão na `Approval` (`WHERE status = PENDING AND version`) e o evento → os efeitos do sujeito
 * (documentos, etapa, status, encadeamento) → `approval.decide`. Qualquer falha desfaz tudo; a
 * renderização `APPROVAL_STAMPED` só é enfileirada depois do commit. O comentário nunca vai a log
 * nem a payload.
 */
@Injectable()
export class DecideApprovalCommand extends TransactionalCommandHandler<
  DecideApprovalInput,
  Prepared,
  DecidedApproval
> {
  constructor(
    @Inject(APPROVAL_TRANSACTIONS) transactions: ApprovalTransactions,
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(APPROVAL_CLOCK) private readonly clock: ApprovalClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly subjects: ApprovalSubjectRegistry,
    private readonly policy: ApprovalDecisionPolicy,
    private readonly presenter: ApprovalPresenter,
  ) {
    super('approval.decide', transactions);
  }

  override async execute(input: DecideApprovalInput): Promise<DecidedApproval> {
    let result: DecidedApproval;
    try {
      result = await super.execute(input);
    } catch (error) {
      const context = requireRequestContext();
      if (error instanceof ApiError && error.status < 500) {
        // Recusa de regra (4xx): só o código — nunca o comentário da decisão.
        this.logger.log(
          {
            event: 'approval.decide_rejected',
            approvalId: input.approvalId,
            code: error.code,
            correlationId: context.correlationId,
          },
          'approval.decide_rejected',
        );
      } else {
        recordApprovalDecideFailed(
          isTransientDatabaseError(error) ? 'DEPENDENCY_UNAVAILABLE' : failureCodeOf(error),
        );
      }
      throw error;
    }
    // RN-TRAM-58: depois do commit — fila fora deixa a renderização `PENDING` (nunca bloqueia).
    for (const effect of result.effects.afterCommit) await effect();
    return result;
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: DecideApprovalInput,
    { now }: Prepared,
  ): Promise<DecidedApproval> {
    const userId = requireRequestContext().actor.userId ?? '';
    const { body } = input;

    // 6.1 — a aprovação do tenant; o dono do sujeito trava o processo ANTES da aprovação.
    const found = await this.approvals.findById(tx, input.approvalId);
    if (found === null) throw approvalNotFound();
    const handler: ApprovalSubjectHandler | null = this.subjects.handlerFor(
      found.approval.subjectType,
    );
    if (handler === null) throw approvalNotFound();
    const subject = subjectOf(found);
    const facts = await handler.prepareDecision(tx, subject);
    if (facts === null) throw approvalNotFound();
    const approval = await this.approvals.lockForUpdate(tx, input.approvalId);
    if (approval === null) throw approvalNotFound();
    if (approval.status !== 'PENDING') throw approvalNotPending(approval);
    if (input.expectedVersion !== approval.version) {
      throw approvalVersionConflict(input.expectedVersion, approval.version);
    }

    // 6.2 — POL-03: designação e segregação de funções; processo decidível.
    const designation = await this.policy.designationIn(tx, approval, facts, userId, now);
    if (!designation.designated) throw notDesignatedApprover(approval.id);
    if (isSelfApproval(facts.authorIds, userId, await this.policy.preventsSelfApprovalIn(tx))) {
      throw selfApprovalForbidden(approval.id);
    }
    if (!isDecidableProcessStatus(facts.processStatus)) {
      throw processNotDecidable(facts.processStatus);
    }

    // 6.3 — o plano do sujeito, sem escrita (regras, destino e aprovador da próxima etapa).
    const comment = body.comment === undefined || body.comment.trim() === '' ? null : body.comment;
    const plan = await withSpan(
      'approval.decide.plan',
      { 'approval.subject_type': subject.subjectType },
      () =>
        handler.planDecision(tx, {
          subject,
          decision: body.decision,
          comment,
          acknowledgedWarnings: body.acknowledgedWarnings ?? [],
          transitionId: body.transitionId ?? null,
          decidedById: userId,
          now,
        }),
    );

    // 6.4 — a decisão na aprovação (a trava garante a versão; o WHERE é a rede) e o evento.
    const decided = decideApproval(approval, {
      decision: body.decision,
      comment,
      decidedById: userId,
      asDeputy: designation.asDeputy,
      now,
    });
    if (!(await this.approvals.recordDecision(tx, decided, approval.version))) {
      throw approvalVersionConflict(input.expectedVersion, approval.version + 1);
    }
    const documentVersionIds = subject.coverage.map((item) => item.documentVersionId);
    await this.outbox.record(
      tx,
      EVENT_OF[body.decision].of({
        aggregateId: decided.id,
        processId: decided.processId,
        payload: {
          approvalId: decided.id,
          subjectType: decided.subjectType,
          decidedById: userId,
          decidedAsDeputy: decided.decidedAsDeputy,
          documentVersionIds,
          hasComment: comment !== null,
        },
      }),
    );

    // 6.5–6.10 — os efeitos do sujeito (documentos, etapa, status, encadeamento).
    const effects = await withSpan(
      'approval.decide.effects',
      { 'approval.subject_type': subject.subjectType },
      () => handler.applyDecision(tx, plan),
    );

    // 6.11 — auditoria (timeline e acessos já vieram com os eventos, no mesmo `tx`).
    await this.audit.record(tx, {
      action: 'approval.decide',
      entityType: 'Approval',
      entityId: decided.id,
      processId: decided.processId,
      changes: [
        { path: 'status', old: approval.status, new: decided.status },
        { path: 'decision', old: null, new: body.decision },
      ],
      metadata: {
        processCode: facts.processCode,
        subjectType: decided.subjectType,
        fromStatus: effects.fromStatus,
        toStatus: effects.toStatus,
        documentIds: subject.coverage.map((item) => item.documentId),
        documentVersionIds,
        warningsAcknowledged: effects.warningsAcknowledged,
        decidedAsDeputy: decided.decidedAsDeputy,
        movementId: effects.movementId,
        nextStageKey: effects.processStage?.key ?? null,
        chainedApprovalId: effects.chainedApprovalId,
        hasComment: comment !== null,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const view = (await handler.describeSubject(tx, subject)) ?? { ...facts, documents: [] };
    const dto = await this.presenter.present(tx, decided, view);
    return {
      dto: {
        ...dto,
        processStage: effects.processStage,
        processStatus: effects.toStatus,
        chainedApprovalId: effects.chainedApprovalId,
      },
      processId: decided.processId,
      subjectType: decided.subjectType,
      decision: body.decision,
      decidedAsDeputy: decided.decidedAsDeputy,
      effects,
    };
  }

  protected override committed(result: DecidedApproval, durationMs: number): void {
    const chained = result.effects.chainedApprovalId !== null;
    recordApprovalDecided(
      result.decision,
      result.subjectType,
      { asDeputy: result.decidedAsDeputy, chained },
      durationMs,
    );
    // Nunca logar o comentário da decisão nem conteúdo de documentos (story · Logs).
    this.logger.log(
      {
        event: 'approval.decided',
        approvalId: result.dto.id,
        processId: result.processId,
        decision: result.decision,
        decidedAsDeputy: result.decidedAsDeputy,
        nextStageKey: result.effects.processStage?.key ?? null,
        chainedApprovalId: result.effects.chainedApprovalId,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'approval.decided',
    );
  }
}

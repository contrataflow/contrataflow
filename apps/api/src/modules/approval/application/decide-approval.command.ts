import { withSpan } from '@contrataflow/observability';
import {
  ApprovalApproverActivated,
  ApprovalCompleted,
  ApprovalRejected,
  ApprovalReturned,
  ApprovalVoteRecorded,
} from '@contrataflow/validation';
import type {
  ApprovalDecision,
  ApprovalDecisionOutcome,
  ApprovalDecisionPolicy as DecisionPolicyName,
  DecideApproval,
  DecideApprovalMeta,
  DecidedApprovalDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ApprovalSubjectRegistry } from '#shared/approval/approval-subject.js';
import type {
  ApprovalSubjectHandler,
  DecisionSubject,
  DecisionSubjectFacts,
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
  approverAlreadyVoted,
  lineSelectionRefused,
  notDesignatedApprover,
  processNotDecidable,
  selfApprovalForbidden,
} from './approval-decision.policy.js';
import {
  recordApprovalDecided,
  recordApprovalDecideFailed,
  recordApprovalVote,
} from './approval-telemetry.js';
import { ApprovalPresenter } from './approval.presenter.js';
import { APPROVAL_CLOCK, APPROVAL_REPOSITORY, APPROVAL_TRANSACTIONS } from './ports.js';
import type {
  ApprovalClock,
  ApprovalRepository,
  ApprovalTransactions,
  ApprovalWithCoverage,
} from './ports.js';
import { isDecidableProcessStatus, isSelfApproval } from '../domain/approval-decision.js';
import type { ApprovalRecord } from '../domain/approval-decision.js';
import type { ApprovalApprover } from '../domain/approval-lines.js';
import {
  LineSelectionError,
  castVote,
  selectVoteLine,
  voteExpectedVersion,
} from '../domain/approval-vote.js';
import type { VoteResult } from '../domain/approval-vote.js';

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly body: DecideApproval;
  /**
   * `If-Match` (DEC-104; o 428 é do guard): a versão da aprovação em `ANY` ou a da linha de quem
   * decide em `ALL`/`SEQUENTIAL` (`meta.myLine.etag` de APV-02 — RN-APV-41).
   */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição (auditoria `approval.decide`/`approval.vote`). */
  readonly idempotencyKey: string | null;
}

export interface DecidedApproval {
  readonly dto: DecidedApprovalDto;
  readonly meta: DecideApprovalMeta;
  readonly processId: string;
  readonly subjectType: DecisionSubject['subjectType'];
  readonly decision: ApprovalDecision;
  readonly decisionPolicy: DecisionPolicyName;
  readonly decidedAsDeputy: boolean;
  /** `null` no voto que não encerra (nenhum efeito no sujeito — RN-APV-38). */
  readonly effects: SubjectDecisionResult | null;
}

interface Prepared {
  readonly now: Date;
}

/** O voto a aplicar, já validado (POL-03 por linha e processo decidível). */
interface VoteContext {
  readonly tx: TenantTx;
  readonly input: DecideApprovalInput;
  readonly userId: string;
  readonly now: Date;
  readonly comment: string | null;
  readonly handler: ApprovalSubjectHandler;
  readonly subject: DecisionSubject;
  readonly facts: DecisionSubjectFacts;
  readonly approval: ApprovalRecord;
  readonly linesBefore: readonly ApprovalApprover[];
  readonly vote: VoteResult;
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
 * `DecideApprovalCommand` — APV-03 (US-052 → US-134, decisão por linha): o padrão
 * `TransactionalCommandHandler` coordenado pelo `approval` (domains.md §4.4). Em UMA transação do
 * tenant: a aprovação do tenant (404) → o dono do sujeito trava o processo e lê os fatos (ordem de
 * bloqueio processo → aprovação → linhas → documentos) → `SELECT … FOR UPDATE` na aprovação e as
 * linhas relidas sob a trava → verificações na ordem de RN-APV-40: (1) aprovação não `PENDING` =
 * 409 `APPROVAL_NOT_PENDING`; a linha de quem decide (`approvalApproverId` ou a única `PENDING`
 * dele; 422 `CONDITIONAL_REQUIRED` se ambígua; 403 se a informada não é dele) — (2) decidida,
 * dispensada ou cancelada = 409 `APPROVAL_LINE_NOT_PENDING`; (3) `WAITING` = 403
 * `NOT_DESIGNATED_APPROVER` (`LINE_WAITING`); (4) `If-Match` (412 — versão da aprovação em `ANY`,
 * da linha nas demais); (5) POL-03 por linha: sem linha = 403 `NOT_DESIGNATED_APPROVER`, já votou =
 * 409 `APPROVER_ALREADY_VOTED`, autor = 403 `SELF_APPROVAL_FORBIDDEN`; processo decidível (409) →
 * a política (`castVote`). Voto que NÃO encerra: linha `APPROVED`, ativação da próxima em
 * `SEQUENTIAL`, `approval.vote` e `ApprovalVoteRecorded` (+ `ApprovalApproverActivated`) — nada no
 * documento, na etapa nem no prazo. Voto que encerra: o plano do sujeito SEM escrita (regras
 * `TRANSITION`, destino, aprovador da próxima etapa) → aprovação e linhas → evento com
 * `decisionPolicy`/`decidingApprovalApproverId`/`votes[]` → os efeitos da US-052 (uma única vez) →
 * `approval.decide`. Qualquer falha desfaz tudo; a renderização `APPROVAL_STAMPED` só é enfileirada
 * depois do commit. O comentário nunca vai a log nem a payload.
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
    for (const effect of result.effects?.afterCommit ?? []) await effect();
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

    // 5.1 — a aprovação do tenant; o dono do sujeito trava o processo ANTES da aprovação.
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
    // (1) RN-APV-40: quem perdeu a corrida para o encerramento recebe a decisão registrada.
    if (approval.status !== 'PENDING') {
      this.conflict(approval.id, 'NOT_PENDING');
      throw approvalNotPending(approval);
    }

    // (2)/(3) a linha do voto, relida sob a trava (as linhas seguem a aprovação na ordem).
    const lines = await this.approvals.findLines(tx, approval.id);
    const designations = await this.policy.lineDesignationFactsIn(tx, lines, facts, userId, now);
    let selection;
    try {
      selection = selectVoteLine(lines, designations, body.approvalApproverId ?? null);
    } catch (error) {
      if (!(error instanceof LineSelectionError)) throw error;
      if (error.problem === 'LINE_NOT_PENDING') this.conflict(approval.id, 'LINE_NOT_PENDING');
      throw lineSelectionRefused(approval.id, error.problem, error.line);
    }
    // (4) RN-APV-41: `If-Match` da aprovação em `ANY`, da linha em `ALL`/`SEQUENTIAL`.
    const expectedVersion = voteExpectedVersion(approval, selection.line);
    if (input.expectedVersion !== expectedVersion) {
      this.conflict(approval.id, 'VERSION_CONFLICT');
      throw approvalVersionConflict(input.expectedVersion, expectedVersion);
    }

    // (5) POL-03 por linha: designação, pessoa única, segregação; processo decidível.
    const { line, designation } = selection;
    if (line === null) throw notDesignatedApprover(approval.id);
    if (selection.alreadyVoted) throw approverAlreadyVoted();
    if (isSelfApproval(facts.authorIds, userId, await this.policy.preventsSelfApprovalIn(tx))) {
      throw selfApprovalForbidden(approval.id, line.id);
    }
    if (!isDecidableProcessStatus(facts.processStatus)) {
      throw processNotDecidable(facts.processStatus);
    }

    const comment = body.comment === undefined || body.comment.trim() === '' ? null : body.comment;
    const vote = castVote(approval, lines, {
      lineId: line.id,
      decision: body.decision,
      comment,
      decidedById: userId,
      asDeputy: designation.asDeputy,
      now,
    });
    const context: VoteContext = {
      tx,
      input,
      userId,
      now,
      comment,
      handler,
      subject,
      facts,
      approval,
      linesBefore: lines,
      vote,
    };
    return vote.closes ? this.close(context) : this.recordOpenVote(context);
  }

  /** Voto positivo que não encerra (RN-APV-35/36): só a aprovação e as linhas mudam. */
  private async recordOpenVote(context: VoteContext): Promise<DecidedApproval> {
    const { tx, approval, vote, userId, input, facts } = context;
    const policy = approval.decisionPolicy ?? 'ANY';
    await this.persist(context);
    const total = vote.lines.filter((line) => line.status !== 'CANCELED').length;
    await this.outbox.record(
      tx,
      ApprovalVoteRecorded.of({
        aggregateId: approval.id,
        processId: approval.processId,
        payload: {
          approvalId: approval.id,
          approvalApproverId: vote.decided.id,
          sequence: vote.decided.sequence,
          decisionPolicy: policy,
          decidedById: userId,
          decidedAsDeputy: vote.decided.decidedAsDeputy,
          remainingPending: vote.remainingPending,
          remainingWaiting: vote.remainingWaiting,
          approvedLines: vote.lines.filter((line) => line.status === 'APPROVED').length,
          totalLines: total,
        },
      }),
    );
    const { activated } = vote;
    if (activated !== null) {
      await this.outbox.record(
        tx,
        ApprovalApproverActivated.of({
          aggregateId: approval.id,
          processId: approval.processId,
          payload: {
            approvalId: approval.id,
            approvalApproverId: activated.id,
            sequence: activated.sequence,
            approverType: activated.approverType,
            approverUserId: activated.approverUserId,
            approverRoleId: activated.approverRoleId,
            approverDepartmentId: activated.approverDepartmentId,
            allowDeputy: activated.allowDeputy,
            // Lacuna 5: prazo por linha só com o SLA por linha (EP-030).
            dueAt: activated.dueAt?.toISOString() ?? null,
          },
        }),
      );
    }
    await this.audit.record(tx, {
      action: 'approval.vote',
      entityType: 'ApprovalApprover',
      entityId: vote.decided.id,
      processId: approval.processId,
      changes: [{ path: 'status', old: 'PENDING', new: vote.decided.status }],
      metadata: {
        approvalId: approval.id,
        approvalApproverId: vote.decided.id,
        sequence: vote.decided.sequence,
        decisionPolicy: policy,
        decidedAsDeputy: vote.decided.decidedAsDeputy,
        activatedApproverId: activated?.id ?? null,
        remainingPending: vote.remainingPending,
        remainingWaiting: vote.remainingWaiting,
        hasComment: context.comment !== null,
        idempotencyKey: input.idempotencyKey,
      },
    });
    const view = (await context.handler.describeSubject(tx, context.subject)) ?? {
      ...facts,
      documents: [],
    };
    const dto = await this.presenter.present(tx, vote.approval, view);
    return {
      dto: {
        ...dto,
        processStage: null,
        processStatus: facts.processStatus,
        chainedApprovalId: null,
      },
      meta: this.metaOf(vote),
      processId: approval.processId,
      subjectType: approval.subjectType,
      decision: input.body.decision,
      decisionPolicy: policy,
      decidedAsDeputy: vote.decided.decidedAsDeputy,
      effects: null,
    };
  }

  /** Encerramento (RN-APV-34/37/38/39): os efeitos da US-052, uma única vez. */
  private async close(context: VoteContext): Promise<DecidedApproval> {
    const { tx, approval, vote, userId, input, facts, subject, handler, comment, now } = context;
    const { body } = input;
    const policy = approval.decisionPolicy ?? 'ANY';

    // O plano do sujeito, sem escrita (regras, destino e aprovador da próxima etapa): FA-06 —
    // `APPROVER_UNRESOLVED` aqui desfaz o voto inteiro e a linha segue `PENDING`.
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

    await this.persist(context);
    const decided = vote.approval;
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
          decisionPolicy: policy,
          decidingApprovalApproverId: vote.decided.id,
          votes: [...vote.votes],
        },
      }),
    );

    // Os efeitos do sujeito (documentos, etapa, status, encadeamento).
    const effects = await withSpan(
      'approval.decide.effects',
      { 'approval.subject_type': subject.subjectType },
      () => handler.applyDecision(tx, plan),
    );

    // Auditoria (timeline e acessos já vieram com os eventos, no mesmo `tx`).
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
        approvalApproverId: vote.decided.id,
        decisionPolicy: policy,
        votes: vote.votes.map((item) => ({ ...item })),
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
      meta: this.metaOf(vote),
      processId: decided.processId,
      subjectType: decided.subjectType,
      decision: body.decision,
      decisionPolicy: policy,
      decidedAsDeputy: decided.decidedAsDeputy,
      effects,
    };
  }

  /** A aprovação e as linhas (a trava garante a versão; o `WHERE` é a rede). */
  private async persist({ tx, approval, vote, linesBefore, userId, input }: VoteContext) {
    const recorded = await this.approvals.recordVote(
      tx,
      { approval: vote.approval, linesBefore, linesAfter: vote.lines },
      approval.version,
      userId,
    );
    if (!recorded) {
      this.conflict(approval.id, 'VERSION_CONFLICT');
      throw approvalVersionConflict(input.expectedVersion, approval.version + 1);
    }
  }

  private metaOf(vote: VoteResult): DecideApprovalMeta {
    return {
      outcome: vote.outcome,
      remainingPending: vote.remainingPending,
      remainingWaiting: vote.remainingWaiting,
      activatedApproverId: vote.activated?.id ?? null,
      approvalApproverId: vote.decided.id,
    };
  }

  /** `warn approval.decide_conflict` (story · Logs): só o motivo e o id. */
  private conflict(
    approvalId: string,
    reason: 'NOT_PENDING' | 'LINE_NOT_PENDING' | 'VERSION_CONFLICT',
  ): void {
    this.logger.warn(
      {
        event: 'approval.decide_conflict',
        approvalId,
        reason,
        correlationId: requireRequestContext().correlationId,
      },
      'approval.decide_conflict',
    );
  }

  protected override committed(result: DecidedApproval, durationMs: number): void {
    const { effects } = result;
    const outcome: ApprovalDecisionOutcome = result.meta.outcome;
    const correlationId = requireRequestContext().correlationId;
    recordApprovalVote(result.decisionPolicy, result.decision);
    // Nunca logar o comentário da decisão, conteúdo de documentos nem nomes (story · Logs).
    if (effects === null) {
      this.logger.log(
        {
          event: 'approval.vote_recorded',
          approvalId: result.dto.id,
          approvalApproverId: result.meta.approvalApproverId,
          decisionPolicy: result.decisionPolicy,
          decision: result.decision,
          remainingPending: result.meta.remainingPending,
          durationMs,
          correlationId,
        },
        'approval.vote_recorded',
      );
      return;
    }
    const chained = effects.chainedApprovalId !== null;
    recordApprovalDecided(
      result.decision,
      result.subjectType,
      { asDeputy: result.decidedAsDeputy, chained },
      durationMs,
    );
    this.logger.log(
      {
        event: 'approval.decided',
        approvalId: result.dto.id,
        processId: result.processId,
        decision: result.decision,
        decidedAsDeputy: result.decidedAsDeputy,
        nextStageKey: effects.processStage?.key ?? null,
        chainedApprovalId: effects.chainedApprovalId,
        durationMs,
        correlationId,
      },
      'approval.decided',
    );
    this.logger.log(
      {
        event: 'approval.closed',
        approvalId: result.dto.id,
        outcome,
        decisionPolicy: result.decisionPolicy,
        votesCount: result.dto.approvers.filter((line) => line.decision !== null).length,
        chained,
        correlationId,
      },
      'approval.closed',
    );
  }
}

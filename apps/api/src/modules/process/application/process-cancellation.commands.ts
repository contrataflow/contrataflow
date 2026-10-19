import { createHash } from 'node:crypto';

import {
  PROCESS_CANCELLATION_MESSAGES,
  ProcessDraftDiscarded,
  ProcessStatusChanged,
} from '@contrataflow/validation';
import type { CanceledProcessDto, ProcessStatus } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessClock, ProcessRepository, ProcessTransactions } from './ports.js';
import { ProcessLifecycleSupport, actorOf, logConflict } from './process-suspension.commands.js';
import {
  cancellationVersionConflict,
  processAlreadyFinal,
  processAlreadyNumbered,
  processNotDraft,
  recordProcessLifecycle,
} from './process.errors.js';
import { accessTargetOf } from './update-process.command.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import {
  discardBlockOf,
  isCancelable,
  planCancellation,
  planDiscard,
} from '../domain/process-cancellation.js';

/*
 * Cancelar o processo e descartar o rascunho sem número (US-009 · PRC-25/PRC-06 · DEC-013 · DEC-018
 * · DEC-034 · POL-06). Cada comando, em UMA transação do tenant: `SELECT … FOR UPDATE` no processo e
 * visibilidade (404) → autorização (403 `PERMISSION_DENIED` auditado) → status (409, ANTES do
 * `If-Match`: o reenvio de um cancelamento já feito é 409 mesmo com a versão atual) → `If-Match`
 * (412) → plano puro → gravação versionada → efeitos → evento → auditoria. Qualquer falha desfaz
 * tudo. Nunca registra a justificativa, o título nem o objeto nos logs.
 */

export interface CancelProcessInput {
  readonly processId: string;
  readonly reason: string;
  /** `If-Match` (a versão que o painel leu — DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
}

export interface CanceledProcess {
  readonly dto: CanceledProcessDto;
  readonly fromStatus: ProcessStatus;
  readonly pendingApprovalsCanceled: number;
}

export interface DiscardDraftProcessInput {
  readonly processId: string;
  /** Motivo opcional (até 500), só na auditoria (DEC-034). */
  readonly reason: string | null;
  readonly expectedVersion: number;
}

interface Prepared {
  readonly now: Date;
}

interface PreparedCancel extends Prepared {
  /** Status lido na chegada, sem trava (`null` = não encontrado — a trava decide o 404). */
  readonly statusAtArrival: ProcessStatus | null;
}

/** Hash da justificativa na auditoria (a íntegra fica no processo e na tramitação). */
const reasonHash = (reason: string) => createHash('sha256').update(reason, 'utf8').digest('hex');

/** PRC-25 — `CancelProcessCommand` (RN-PROC-103..107 · RN-PROC-110 · POL-06). */
@Injectable()
export class CancelProcessCommand extends TransactionalCommandHandler<
  CancelProcessInput,
  PreparedCancel,
  CanceledProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly support: ProcessLifecycleSupport,
    private readonly approvals: ApprovalFacade,
    private readonly documents: DocumentFacade,
  ) {
    super('process.cancel', transactions);
  }

  protected async prepare(input: CancelProcessInput): Promise<PreparedCancel> {
    const statusAtArrival = await this.transactions.read((tx) =>
      this.processes.statusOf(tx, input.processId),
    );
    return { now: this.clock(), statusAtArrival };
  }

  protected async handle(
    tx: TenantTx,
    input: CancelProcessInput,
    { now, statusAtArrival }: PreparedCancel,
  ): Promise<CanceledProcess> {
    // RN-PROC-110: `PROCESS_CANCEL` cobrindo o processo, sem exigir custódia (POL-01 não se aplica).
    const { rows, runtime } = await this.support.lockAndAuthorize(
      tx,
      input.processId,
      'PROCESS_CANCEL',
      PROCESS_CANCELLATION_MESSAGES.permissionDenied,
    );
    const process = rows.process;
    // RN-PROC-103 — status não final (V-02): já encerrado na chegada = reenvio (409); encerrado
    // enquanto esperava a trava = corrida perdida para outra aba (412). V-05 — `If-Match`.
    if (!isCancelable(process.status)) {
      if (statusAtArrival !== null && isCancelable(statusAtArrival)) {
        throw cancellationVersionConflict(input.expectedVersion, process.version);
      }
      throw processAlreadyFinal(process.status);
    }
    if (input.expectedVersion !== process.version) {
      throw cancellationVersionConflict(input.expectedVersion, process.version);
    }
    const active = this.support.activePass(rows);
    if (active === null) throw processAlreadyFinal(process.status);

    const actor = actorOf();
    const plan = planCancellation({
      process,
      active,
      reason: input.reason,
      lastMovementSequence: await this.support.lastMovementSequence(tx, process.id),
      metadata: await this.support.metadata(tx, runtime, process),
      actor,
      now,
      movementId: newId(),
    });
    if (!(await this.processes.recordCancellation(tx, plan))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw cancellationVersionConflict(input.expectedVersion, process.version + 1);
    }

    // RN-PROC-106 — aprovações pendentes canceladas e documentos em análise de volta a `DRAFT`.
    const canceled = await this.approvals.cancelPendingForProcessIn(
      tx,
      process.id,
      now,
      actor.userId,
    );
    for (const approval of canceled) {
      for (const documentId of approval.documentIds) {
        await this.documents.releaseCanceledApprovalIn(tx, {
          documentId,
          approvalId: approval.approvalId,
          reason: PROCESS_CANCELLATION_MESSAGES.documentWithdrawn,
        });
      }
    }

    // Evento (timeline `PROCESS_CANCELED` no mesmo `tx`; aviso pelo worker) e auditoria.
    await this.outbox.record(
      tx,
      ProcessStatusChanged.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          fromStatus: process.status,
          toStatus: 'CANCELED',
          cause: 'CANCEL',
          reasonProvided: true,
          reason: input.reason,
        },
      }),
    );
    const updated = plan.process;
    await this.audit.record(tx, {
      action: 'process.cancel',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [{ path: 'status', old: process.status, new: 'CANCELED' }],
      metadata: {
        processCode: updated.code,
        fromStatus: process.status,
        reasonHash: reasonHash(input.reason),
        pendingApprovalsCanceled: canceled.length,
        approvalIds: canceled.map((approval) => approval.approvalId),
        movementId: plan.movement.id,
      },
    });

    const dto = await this.support.presentProcess(tx, rows, runtime, updated);
    return {
      dto: {
        ...dto,
        canceledAt: plan.cancellation.canceledAt.toISOString(),
        cancellationReason: plan.cancellation.cancellationReason,
      },
      fromStatus: process.status,
      pendingApprovalsCanceled: canceled.length,
    };
  }

  protected override committed(result: CanceledProcess, durationMs: number): void {
    recordProcessLifecycle('CANCEL', durationMs);
    this.logger.log(
      {
        event: 'process.canceled',
        processId: result.dto.id,
        fromStatus: result.fromStatus,
        pendingApprovalsCanceled: result.pendingApprovalsCanceled,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'process.canceled',
    );
  }

  override async execute(input: CancelProcessInput): Promise<CanceledProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      logConflict(this.logger, input.processId, error);
      throw error;
    }
  }
}

/** PRC-06 — `DiscardDraftProcessCommand` (RN-PROC-105 · RN-PROC-108..110 · DEC-034). */
@Injectable()
export class DiscardDraftProcessCommand extends TransactionalCommandHandler<
  DiscardDraftProcessInput,
  Prepared,
  { readonly processId: string }
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly support: ProcessLifecycleSupport,
    private readonly access: AccessFacade,
  ) {
    super('process.discard', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: DiscardDraftProcessInput,
    { now }: Prepared,
  ): Promise<{ readonly processId: string }> {
    const { rows, runtime } = await this.support.lockAndLoad(tx, input.processId);
    const process = rows.process;
    const { userId } = actorOf();
    // RN-PROC-110: o criador com `PROCESS_CREATE` ou quem tem `PROCESS_CANCEL` cobrindo o processo
    // (sem custódia — POL-01 não se aplica). Senão, 403 auditado com `reasonCode = PROCESS_CANCEL`.
    const creator = process.createdById === userId && this.access.can('PROCESS_CREATE');
    if (!creator) {
      await this.access.assertCanOnProcess(
        'PROCESS_CANCEL',
        accessTargetOf(runtime),
        PROCESS_CANCELLATION_MESSAGES.permissionDenied,
      );
    }
    // RN-PROC-105 — rascunho sem número (V-03); V-05 — `If-Match`.
    const block = discardBlockOf(process);
    if (block === 'NOT_DRAFT') throw processNotDraft(process.status);
    if (block === 'NUMBERED') throw processAlreadyNumbered();
    if (input.expectedVersion !== process.version) {
      throw cancellationVersionConflict(input.expectedVersion, process.version);
    }

    const plan = planDiscard({
      process,
      activeStageId: this.support.activePass(rows)?.id ?? null,
      userId,
      now,
    });
    if (!(await this.processes.recordDraftDiscard(tx, plan))) {
      throw cancellationVersionConflict(input.expectedVersion, process.version + 1);
    }

    // Sem timeline (o processo deixa de ser visível) e sem notificação (story · "Notificações").
    const reasonProvided = input.reason !== null;
    await this.outbox.record(
      tx,
      ProcessDraftDiscarded.of({
        aggregateId: process.id,
        processId: process.id,
        payload: { reasonProvided },
      }),
    );
    await this.audit.record(tx, {
      action: 'process.discard_draft',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [{ path: 'deletedAt', old: null, new: now.toISOString() }],
      metadata: {
        reasonProvided,
        ...(input.reason === null ? {} : { reason: input.reason }),
        asCreator: creator,
      },
    });
    return { processId: process.id };
  }

  protected override committed(result: { readonly processId: string }, durationMs: number): void {
    recordProcessLifecycle('DISCARD', durationMs);
    this.logger.log(
      {
        event: 'process.draft_discarded',
        processId: result.processId,
        correlationId: requireRequestContext().correlationId,
      },
      'process.draft_discarded',
    );
  }

  override async execute(input: DiscardDraftProcessInput): Promise<{ readonly processId: string }> {
    try {
      return await super.execute(input);
    } catch (error) {
      logConflict(this.logger, input.processId, error);
      throw error;
    }
  }
}

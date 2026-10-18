import {
  MOVEMENT_METADATA_VERSION,
  PROCESS_SUSPENSION_MESSAGES,
  ProcessStatusChanged,
  movementMetadataSchema,
} from '@contrataflow/validation';
import type {
  DayCountType,
  MovementMetadata,
  ProcessStatus,
  ResumeMeta,
  SuspensionProcessDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type {
  ProcessAggregateRows,
  ProcessClock,
  ProcessRepository,
  ProcessTransactions,
} from './ports.js';
import { executionStateOf } from './process-actions.queries.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import {
  processNotFoundError,
  processNotSuspendable,
  processNotSuspended,
  recordProcessLifecycle,
  suspensionVersionConflict,
} from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { accessTargetOf } from './update-process.command.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import { isSuspendable, planResume, planSuspension } from '../domain/process-suspension.js';
import type { SuspendedPass, SuspensionFields } from '../domain/process-suspension.js';
import type { Process } from '../domain/process.js';

/*
 * Suspender e retomar o processo (US-008 · PRC-23/PRC-24 · DEC-013 · DEC-031 · POL-07). Cada
 * comando, em UMA transação do tenant: `SELECT … FOR UPDATE` no processo e visibilidade (404) →
 * `PROCESS_SUSPEND` cobrindo o processo, SEM custódia (403 `PERMISSION_DENIED` auditado) → status
 * de origem (409 `INVALID_PROCESS_STATUS` — antes do `If-Match`: a nova suspensão de um processo
 * já suspenso é 409 mesmo com a versão atual) → `If-Match` (412) → plano puro → gravação versionada
 * → `ProcessStatusChanged` (timeline síncrona; aviso `PROCESS_STATUS_CHANGED` pelo worker) →
 * auditoria. Qualquer falha desfaz tudo. Nunca registra o texto do motivo nos logs.
 */

export interface SuspendProcessInput {
  readonly processId: string;
  readonly reason: string;
  /** `If-Match` (a versão que o painel leu — DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
  readonly idempotencyKey: string | null;
}

export interface ResumeProcessInput {
  readonly processId: string;
  readonly comment: string | null;
  readonly expectedVersion: number;
  readonly idempotencyKey: string | null;
}

export interface SuspendedProcess {
  readonly dto: SuspensionProcessDto;
  readonly fromStatus: ProcessStatus;
}

export interface ResumedProcess {
  readonly dto: SuspensionProcessDto;
  readonly meta: ResumeMeta;
}

interface Prepared {
  readonly now: Date;
}

/** Leitura comum: trava, visibilidade, `PROCESS_SUSPEND` (POL-07) e a passagem ativa. */
@Injectable()
export class ProcessLifecycleSupport {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly access: AccessFacade,
    private readonly workflow: WorkflowFacade,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessPresenter,
    private readonly transitions: StageTransitionSupport,
  ) {}

  /** Trava e autoriza; 404 antes de 403 (não revela processo invisível). */
  async lockAndAuthorize(
    tx: TenantTx,
    processId: string,
  ): Promise<{ readonly rows: ProcessAggregateRows; readonly runtime: ProcessRuntime }> {
    if (!(await this.processes.lockForUpdate(tx, processId))) throw processNotFoundError();
    const { rows, runtime } = await this.panel.load(tx, processId);
    await this.access.assertCanOnProcess(
      'PROCESS_SUSPEND',
      accessTargetOf(runtime),
      PROCESS_SUSPENSION_MESSAGES.permissionDenied,
    );
    return { rows, runtime };
  }

  /** A passagem ativa do processo travado (`null` = processo sem etapa ativa). */
  activePass(rows: ProcessAggregateRows): SuspendedPass | null {
    const active = rows.stages.find(
      (stage) => stage.id === rows.process.currentStageId && stage.status === 'ACTIVE',
    );
    if (active === undefined) return null;
    return {
      id: active.id,
      workflowStageId: active.workflowStageId,
      dueAt: active.dueAt,
      slaType: active.slaType,
      pausedAt: active.pausedAt,
      overdueSince: active.overdueSince,
    };
  }

  /** Metadados v1 da tramitação (nomes congelados da etapa, unidade e responsável). */
  async metadata(
    tx: TenantTx,
    runtime: ProcessRuntime,
    process: Process,
  ): Promise<MovementMetadata> {
    const stage = await this.workflow.currentStage(executionStateOf(runtime));
    const labels = await this.transitions.labels(tx, {
      fromStage: stage?.name ?? '',
      toStage: stage?.name ?? '',
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId: process.currentDepartmentId,
      fromUserId: process.currentResponsibleId,
      toUserId: process.currentResponsibleId,
    });
    return movementMetadataSchema.parse({
      v: MOVEMENT_METADATA_VERSION,
      labels,
      clientChannel: 'WEB',
    });
  }

  /** O `Process` de PRC-23/24 sobre o NOVO estado (POL-09 e os campos da suspensão). */
  async present(
    tx: TenantTx,
    rows: ProcessAggregateRows,
    runtime: ProcessRuntime,
    process: Process,
    suspension: SuspensionFields,
    pausedAt: Date | null,
  ): Promise<SuspensionProcessDto> {
    const canSeeBudget = await this.panel.canSeeBudget({ ...rows, process }, runtime);
    const dto = await this.presenter.present(tx, process, canSeeBudget);
    return {
      ...dto,
      currentStage:
        dto.currentStage === null
          ? null
          : { ...dto.currentStage, pausedAt: pausedAt?.toISOString() ?? null },
      statusBeforeSuspension: suspension.statusBeforeSuspension,
      suspendedAt: suspension.suspendedAt?.toISOString() ?? null,
      suspensionReason: suspension.suspensionReason,
    };
  }

  lastMovementSequence(tx: TenantTx, processId: string): Promise<number> {
    return this.processes.lastMovementSequence(tx, processId);
  }
}

function actorOf(): {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
} {
  const context = requireRequestContext();
  return {
    userId: context.actor.userId ?? '',
    ip: context.ip,
    userAgent: context.userAgent,
    correlationId: context.correlationId,
  };
}

/** `warn process.lifecycle_conflict` nos 409/412 (story · Logs) — só ids e códigos. */
function logConflict(logger: Logger, processId: string, error: unknown): void {
  if (!(error instanceof ApiError) || (error.status !== 409 && error.status !== 412)) return;
  logger.warn(
    {
      event: 'process.lifecycle_conflict',
      processId,
      code: error.code,
      processStatus: error.extensions.processStatus ?? null,
      correlationId: requireRequestContext().correlationId,
    },
    'process.lifecycle_conflict',
  );
}

/** PRC-23 — `SuspendProcessCommand` (RN-PROC-93..96 · RN-PROC-101/102). */
@Injectable()
export class SuspendProcessCommand extends TransactionalCommandHandler<
  SuspendProcessInput,
  Prepared,
  SuspendedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly support: ProcessLifecycleSupport,
  ) {
    super('process.lifecycle', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: SuspendProcessInput,
    { now }: Prepared,
  ): Promise<SuspendedProcess> {
    const { rows, runtime } = await this.support.lockAndAuthorize(tx, input.processId);
    const process = rows.process;
    // RN-PROC-93 — status de origem; V-05 — `If-Match`.
    if (!isSuspendable(process.status)) throw processNotSuspendable(process.status);
    if (input.expectedVersion !== process.version) {
      throw suspensionVersionConflict(input.expectedVersion, process.version);
    }
    const active = this.support.activePass(rows);
    if (active === null) throw processNotSuspendable(process.status);

    const plan = planSuspension({
      process,
      active,
      reason: input.reason,
      lastMovementSequence: await this.support.lastMovementSequence(tx, process.id),
      metadata: await this.support.metadata(tx, runtime, process),
      actor: actorOf(),
      now,
      movementId: newId(),
    });
    if (!(await this.processes.recordSuspension(tx, plan))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw suspensionVersionConflict(input.expectedVersion, process.version + 1);
    }

    // RN-PROC-101 — evento (timeline `PROCESS_SUSPENDED` no mesmo `tx`) e auditoria.
    await this.outbox.record(
      tx,
      ProcessStatusChanged.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          fromStatus: process.status,
          toStatus: 'SUSPENDED',
          cause: 'SUSPEND',
          reasonProvided: true,
          reason: input.reason,
        },
      }),
    );
    const updated = plan.process;
    await this.audit.record(tx, {
      action: 'process.suspend',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [
        { path: 'status', old: process.status, new: 'SUSPENDED' },
        { path: 'statusBeforeSuspension', old: null, new: process.status },
        { path: 'suspendedAt', old: null, new: now.toISOString() },
      ],
      metadata: {
        processCode: updated.code,
        fromStatus: process.status,
        toStatus: 'SUSPENDED',
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        movementId: plan.movement.id,
      },
    });

    return {
      dto: await this.support.present(tx, rows, runtime, updated, plan.suspension, plan.pausedAt),
      fromStatus: process.status,
    };
  }

  protected override committed(result: SuspendedProcess, durationMs: number): void {
    recordProcessLifecycle('SUSPEND', durationMs);
    this.logger.log(
      {
        event: 'process.suspended',
        processId: result.dto.id,
        fromStatus: result.fromStatus,
        toStatus: 'SUSPENDED',
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'process.suspended',
    );
  }

  override async execute(input: SuspendProcessInput): Promise<SuspendedProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      logConflict(this.logger, input.processId, error);
      throw error;
    }
  }
}

/** PRC-24 — `ResumeProcessCommand` (RN-PROC-97..102 · DEC-031). */
@Injectable()
export class ResumeProcessCommand extends TransactionalCommandHandler<
  ResumeProcessInput,
  Prepared,
  ResumedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly support: ProcessLifecycleSupport,
    private readonly calendar: BusinessCalendarFacade,
    private readonly approvals: ApprovalFacade,
  ) {
    super('process.lifecycle', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: ResumeProcessInput,
    { now }: Prepared,
  ): Promise<ResumedProcess> {
    const { rows, runtime } = await this.support.lockAndAuthorize(tx, input.processId);
    const process = rows.process;
    const restoreTo = rows.situation.statusBeforeSuspension;
    // RN-PROC-97 — só `SUSPENDED` (V-03); V-05 — `If-Match`.
    if (process.status !== 'SUSPENDED' || restoreTo === null) {
      throw processNotSuspended(process.status);
    }
    if (input.expectedVersion !== process.version) {
      throw suspensionVersionConflict(input.expectedVersion, process.version);
    }
    const active = this.support.activePass(rows);
    if (active === null) throw processNotSuspended(process.status);

    // RN-PROC-98 — dias úteis (ou corridos) em [data local da pausa, data local da retomada).
    const slaType: DayCountType = active.slaType ?? 'BUSINESS';
    const pausedAt = active.pausedAt ?? rows.situation.suspendedAt ?? now;
    const days = await this.calendar.daysInInterval(tx, pausedAt, now, slaType);
    const extend = (dueAt: Date): Promise<Date> =>
      days === 0 ? Promise.resolve(dueAt) : this.calendar.addBusinessDays(tx, dueAt, days, slaType);
    const newDueAt = active.dueAt === null ? null : await extend(active.dueAt);

    const actor = actorOf();
    const plan = planResume({
      process,
      active: { ...active, pausedAt },
      restoreTo,
      extension: { days, slaType, newDueAt },
      comment: input.comment,
      lastMovementSequence: await this.support.lastMovementSequence(tx, process.id),
      metadata: await this.support.metadata(tx, runtime, process),
      actor,
      now,
      movementId: newId(),
    });
    if (!(await this.processes.recordResume(tx, plan))) {
      throw suspensionVersionConflict(input.expectedVersion, process.version + 1);
    }
    // RN-PROC-99 — a aprovação pendente da passagem ganha os mesmos dias (ordem: processo → aprovação).
    const approval = await this.approvals.extendPendingStageDueAtIn(
      tx,
      active.id,
      extend,
      now,
      actor.userId,
    );

    await this.outbox.record(
      tx,
      ProcessStatusChanged.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          fromStatus: 'SUSPENDED',
          toStatus: restoreTo,
          cause: 'RESUME',
          reasonProvided: input.comment !== null,
          reason: input.comment,
        },
      }),
    );
    const updated = plan.process;
    await this.audit.record(tx, {
      action: 'process.resume',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [
        { path: 'status', old: 'SUSPENDED', new: restoreTo },
        {
          path: 'currentStageDueAt',
          old: process.currentStageDueAt?.toISOString() ?? null,
          new: updated.currentStageDueAt?.toISOString() ?? null,
        },
      ],
      metadata: {
        processCode: updated.code,
        pausedSeconds: plan.stage.pausedSeconds,
        extendedDays: days,
        approvalDueAtExtended: approval !== null,
        ...(approval === null ? {} : { approvalId: approval.approvalId }),
        idempotencyKey: input.idempotencyKey,
        movementId: plan.movement.id,
      },
    });

    const cleared: SuspensionFields = {
      statusBeforeSuspension: null,
      suspendedAt: null,
      suspendedById: null,
      suspensionReason: null,
    };
    return {
      dto: await this.support.present(tx, rows, runtime, updated, cleared, null),
      meta: {
        extendedBy: { days, slaType },
        newDueAt: plan.stage.dueAt?.toISOString() ?? null,
      },
    };
  }

  protected override committed(result: ResumedProcess, durationMs: number): void {
    recordProcessLifecycle('RESUME', durationMs);
    this.logger.log(
      {
        event: 'process.resumed',
        processId: result.dto.id,
        fromStatus: 'SUSPENDED',
        toStatus: result.dto.status,
        extendedDays: result.meta.extendedBy.days,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'process.resumed',
    );
  }

  override async execute(input: ResumeProcessInput): Promise<ResumedProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      logConflict(this.logger, input.processId, error);
      throw error;
    }
  }
}

import {
  MOVEMENT_METADATA_VERSION,
  ProcessAssigned,
  movementMetadataSchema,
} from '@contrataflow/validation';
import type { AssignProcess, MovementMetadata, ProcessDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { FORWARD_LOCK_WAIT_WARN_MS } from './forward-process.command.js';
import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessClock, ProcessRepository, ProcessTransactions } from './ports.js';
import { executionStateOf } from './process-actions.queries.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import { assignCoversProcess } from './process-viewer.js';
import {
  assignAssigneeNotEligible,
  assignAssigneeNotFound,
  assignNotAllowed,
  assignReasonRequiredError,
  assignVersionConflict,
  processNotAssignable,
  processNotFoundError,
  recordProcessAssigned,
} from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { batchAuditMetadata } from './task-bulk.support.js';
import type { BulkItemContext } from './task-bulk.support.js';
import { accessTargetOf } from './update-process.command.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { assignReasonMissing, isAssignable, planAssign } from '../domain/process-assign.js';

export interface AssignProcessInput {
  readonly processId: string;
  readonly body: AssignProcess;
  /**
   * `If-Match` (a versão que o painel leu — DEC-104; o 428 é do guard). `null` só no lote do TSK-04
   * (US-058), que não envia versão por item: a trava do processo decide a corrida.
   */
  readonly expectedVersion: number | null;
  /** Item de um lote (US-058): `batchId` e a `Idempotency-Key` vão para a auditoria. */
  readonly batch?: BulkItemContext;
}

export interface AssignedProcess {
  readonly dto: ProcessDto;
  readonly fromUserId: string | null;
  readonly toUserId: string | null;
  readonly lockWaitMs: number;
  readonly viaHeadOrDeputy: boolean;
}

interface Prepared {
  readonly now: Date;
}

/**
 * `AssignProcessCommand` — PRC-22 (US-050 · fluxo principal, passo 5): atribuir, reatribuir ou
 * devolver à fila da unidade o responsável individual. Em UMA transação do tenant: `SELECT … FOR
 * UPDATE` no processo e visibilidade (404) → POL-05: `PROCESS_ASSIGN` com escopo `TENANT`/
 * `ORGANIZATION` cobrindo o processo OU titular/substituto da unidade atual (403
 * `PERMISSION_DENIED` auditado — RN-TRAM-36) → status/etapa (409 `INVALID_PROCESS_STATUS` —
 * RN-TRAM-37) → `If-Match` (412) → novo responsável do tenant (422 `VALIDATION_ERROR`
 * `REFERENCE_NOT_FOUND`) e elegível na unidade atual (422 `ASSIGNEE_NOT_ELIGIBLE` — RN-TRAM-38) →
 * motivo na troca (422 `VALIDATION_ERROR` em `reason` — RN-TRAM-39) → responsabilidade `MANUAL`,
 * responsável da passagem e do processo, tramitação `ASSIGN`, `process.assign` e o evento
 * `ProcessAssigned` (timeline e `ProcessAccess` no mesmo `tx`). Qualquer falha desfaz tudo.
 *
 * Decisão: a titularidade é lida da unidade no próprio `tx` (não do retrato em cache) — quem acabou
 * de deixar a chefia não atribui mais. Sem `Idempotency-Key` (FA-04): o reenvio já aplicado cai no
 * `If-Match` (412).
 */
@Injectable()
export class AssignProcessCommand extends TransactionalCommandHandler<
  AssignProcessInput,
  Prepared,
  AssignedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
    private readonly workflow: WorkflowFacade,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessPresenter,
    private readonly support: StageTransitionSupport,
  ) {
    super('process.assign', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: AssignProcessInput,
    { now }: Prepared,
  ): Promise<AssignedProcess> {
    const context = requireRequestContext();
    const userId = context.actor.userId ?? '';
    const assigneeId = input.body.assigneeId;
    const reason = input.body.reason ?? null;

    // 5.1 — trava o processo antes de ler: o estado lido é o do vencedor de qualquer corrida.
    const lockStartedAt = performance.now();
    if (!(await this.processes.lockForUpdate(tx, input.processId))) throw processNotFoundError();
    const lockWaitMs = Math.round(performance.now() - lockStartedAt);
    if (lockWaitMs > FORWARD_LOCK_WAIT_WARN_MS) {
      this.logger.warn(
        {
          event: 'process.lock_wait',
          processId: input.processId,
          lockWaitMs,
          correlationId: context.correlationId,
        },
        'process.lock_wait',
      );
    }
    const { rows, runtime, viewer } = await this.panel.load(tx, input.processId);
    const process = rows.process;

    // 5.2 — POL-05: escopo amplo de `PROCESS_ASSIGN` ou chefia (titular/substituto) da unidade atual.
    const viaHeadOrDeputy = await this.authorize(tx, viewer, runtime, userId);

    // 5.3 — status e tipo da etapa (RN-TRAM-37); 5.1 — `If-Match`.
    const stage = await this.workflow.currentStage(executionStateOf(runtime));
    if (!isAssignable(process, stage?.type ?? null)) throw processNotAssignable(process.status);
    if (input.expectedVersion !== null && input.expectedVersion !== process.version) {
      throw assignVersionConflict(input.expectedVersion, process.version);
    }
    const active = rows.stages.find(
      (candidate) => candidate.id === process.currentStageId && candidate.status === 'ACTIVE',
    );
    if (active === undefined) throw processNotAssignable(process.status);

    // 5.4 — o novo responsável: do tenant (senão a referência "não existe") e elegível (RN-TRAM-38).
    if (assigneeId !== null) {
      const [member] = await this.identity.membersInTenant(tx, [assigneeId]);
      if (member === undefined) throw assignAssigneeNotFound();
      if (
        !(await this.support.isEligibleAssignee(tx, assigneeId, process.currentDepartmentId, now))
      ) {
        throw assignAssigneeNotEligible();
      }
    }
    // 5.5 — motivo na troca de um responsável já definido, inclusive para a fila (RN-TRAM-39).
    if (assignReasonMissing(process, reason)) throw assignReasonRequiredError();

    const fromUserId = process.currentResponsibleId;
    const labels = await this.support.labels(tx, {
      fromStage: stage?.name ?? '',
      toStage: stage?.name ?? '',
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId: process.currentDepartmentId,
      fromUserId,
      toUserId: assigneeId,
    });
    const metadata: MovementMetadata = movementMetadataSchema.parse({
      v: MOVEMENT_METADATA_VERSION,
      labels,
      clientChannel: 'WEB',
    });

    // 5.6–5.8 — responsabilidade `MANUAL`, responsável da passagem e do processo, tramitação.
    const plan = planAssign({
      process,
      active: { id: active.id, workflowStageId: active.workflowStageId },
      assigneeId,
      reason,
      lastMovementSequence: await this.processes.lastMovementSequence(tx, process.id),
      metadata,
      actor: {
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      },
      now,
      ids: { assignment: newId(), movement: newId() },
    });
    if (!(await this.processes.recordAssign(tx, plan))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw assignVersionConflict(input.expectedVersion ?? process.version, process.version + 1);
    }

    // 5.9–5.10 — evento (a timeline `PROCESS_ASSIGNED` e o `ProcessAccess` RESPONSIBLE vêm dele,
    // no mesmo `tx`) e auditoria. O motivo fica só na tramitação: nunca no log nem no evento.
    await this.outbox.record(
      tx,
      ProcessAssigned.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          processStageId: active.id,
          departmentId: process.currentDepartmentId,
          fromUserId,
          toUserId: assigneeId,
          assignmentType: 'MANUAL',
          hasReason: reason !== null,
        },
      }),
    );
    const updated = plan.process;
    await this.audit.record(tx, {
      action: 'process.assign',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [{ path: 'currentResponsibleId', old: fromUserId, new: assigneeId }],
      metadata: {
        processCode: updated.code,
        processStageId: active.id,
        movementId: plan.movement.id,
        fromUserId,
        toUserId: assigneeId,
        viaHeadOrDeputy,
        ...(reason === null ? {} : { reasonLength: reason.length }),
        ...batchAuditMetadata(input.batch),
      },
    });

    // POL-09 sobre o NOVO estado.
    const canSeeBudget = await this.panel.canSeeBudget({ ...rows, process: updated }, runtime);
    return {
      dto: await this.presenter.present(tx, updated, canSeeBudget),
      fromUserId,
      toUserId: assigneeId,
      lockWaitMs,
      viaHeadOrDeputy,
    };
  }

  /**
   * POL-05 (RN-TRAM-36). `true` = passou só pela chefia da unidade atual (sem `PROCESS_ASSIGN`
   * amplo); com o escopo amplo, a permissão é conferida com MFA e auditoria (`assertCanOnProcess`).
   */
  private async authorize(
    tx: TenantTx,
    viewer: Awaited<ReturnType<ProcessPanelReader['load']>>['viewer'],
    runtime: Awaited<ReturnType<ProcessPanelReader['load']>>['runtime'],
    userId: string,
  ): Promise<boolean> {
    if (assignCoversProcess(viewer, runtime.organizationId ?? null)) {
      await this.access.assertCanOnProcess('PROCESS_ASSIGN', accessTargetOf(runtime));
      return false;
    }
    const department = await this.organization.findDepartmentForApproval(
      tx,
      runtime.currentDepartmentId,
    );
    const isHeadOrDeputy =
      department?.isActive === true &&
      (department.headUserId === userId || department.deputyUserId === userId);
    if (!isHeadOrDeputy) throw assignNotAllowed();
    this.logger.warn(
      {
        event: 'assign.not_head_or_deputy_fallback',
        processId: runtime.id,
        actorId: userId,
        correlationId: requireRequestContext().correlationId,
      },
      'assign.not_head_or_deputy_fallback',
    );
    return true;
  }

  protected override committed(result: AssignedProcess, durationMs: number): void {
    const context = requireRequestContext();
    recordProcessAssigned(durationMs, result.viaHeadOrDeputy);
    // Só ids: nunca o motivo nem dados pessoais (story · Logs).
    this.logger.log(
      {
        event: 'process.assigned',
        processId: result.dto.id,
        fromUserId: result.fromUserId,
        toUserId: result.toUserId,
        actorId: context.actor.userId,
        durationMs,
        lockWaitMs: result.lockWaitMs,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      'process.assigned',
    );
  }

  override async execute(input: AssignProcessInput): Promise<AssignedProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      // As falhas inesperadas já saem como `process.assign_failed` (`error`) pela base.
      if (error instanceof ApiError && error.status < 500) {
        this.logger.log(
          {
            event: 'process.assign_rejected',
            processId: input.processId,
            code: error.code,
            correlationId: requireRequestContext().correlationId,
          },
          'process.assign_rejected',
        );
      }
      throw error;
    }
  }
}

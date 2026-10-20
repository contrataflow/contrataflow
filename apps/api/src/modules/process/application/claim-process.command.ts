import {
  MOVEMENT_METADATA_VERSION,
  ProcessAssigned,
  movementMetadataSchema,
} from '@contrataflow/validation';
import type { MovementMetadata, ProcessDto } from '@contrataflow/validation';
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
import {
  claimNotInDepartment,
  claimVersionConflict,
  processAlreadyAssigned,
  processNotClaimable,
  processNotFoundError,
  recordClaimConflict,
  recordProcessClaimed,
} from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { batchAuditMetadata } from './task-bulk.support.js';
import type { BulkItemContext } from './task-bulk.support.js';
import { accessTargetOf } from './update-process.command.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { claimRefusal, planClaim } from '../domain/process-claim.js';

export interface ClaimProcessInput {
  readonly processId: string;
  /**
   * `If-Match` (a versão que o painel leu — DEC-104; o 428 é do guard). `null` só no lote do TSK-03
   * (US-058), que não envia versão por item: a trava do processo decide a corrida.
   */
  readonly expectedVersion: number | null;
  /** Item de um lote (US-058): `batchId` e a `Idempotency-Key` vão para a auditoria. */
  readonly batch?: BulkItemContext;
}

export interface ClaimedProcess {
  readonly dto: ProcessDto;
  readonly lockWaitMs: number;
}

interface Prepared {
  readonly now: Date;
}

/**
 * `ClaimProcessCommand` — PRC-21 (US-049 · fluxo principal, passo 3): "Assumir" o processo que está
 * na fila da unidade. Em UMA transação do tenant: `SELECT … FOR UPDATE` no processo e visibilidade
 * (404) → `PROCESS_CLAIM` cobrindo o processo e lotação na unidade atual (403 `PERMISSION_DENIED`
 * auditado — POL-04) → status/etapa elegíveis (409 `INVALID_PROCESS_STATUS` — RN-TRAM-32) → sem
 * responsável (409 `PROCESS_ALREADY_ASSIGNED` — RN-TRAM-31) → `If-Match` (412) → responsabilidade
 * `CLAIM`, responsável da passagem e do processo, tramitação `CLAIM`, `process.claim` e o evento
 * `ProcessAssigned` (timeline e `ProcessAccess` no mesmo `tx`). Sem motivo e sem notificação
 * (RN-TRAM-34/35). Qualquer falha desfaz tudo.
 *
 * Decisão: "já assumido por OUTRA pessoa" vale antes do `If-Match` (a corrida de fila da FA-01 manda
 * o mesmo `If-Match` dos dois lados e o perdedor precisa do 409 com o nome do vencedor); "já assumido
 * por mim" com `If-Match` vencido é o reenvio do clique duplo (FA-03) → 412, tratado pelo front como
 * sucesso já aplicado.
 */
@Injectable()
export class ClaimProcessCommand extends TransactionalCommandHandler<
  ClaimProcessInput,
  Prepared,
  ClaimedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly workflow: WorkflowFacade,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessPresenter,
    private readonly support: StageTransitionSupport,
  ) {
    super('process.claim', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: ClaimProcessInput,
    { now }: Prepared,
  ): Promise<ClaimedProcess> {
    const context = requireRequestContext();
    const userId = context.actor.userId ?? '';

    // 3.1 — trava o processo antes de ler: o estado lido é o do vencedor de qualquer corrida.
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

    // 3.2 — `PROCESS_CLAIM` cobrindo o processo e lotação na unidade atual (POL-04).
    await this.access.assertCanOnProcess('PROCESS_CLAIM', accessTargetOf(runtime));
    if (!viewer.engine.departmentIds.includes(process.currentDepartmentId)) {
      throw claimNotInDepartment();
    }

    // RN-TRAM-32 — status e tipo da etapa; 3.3 — sem responsável individual (RN-TRAM-31).
    const stage = await this.workflow.currentStage(executionStateOf(runtime));
    const refusal = claimRefusal(process, stage?.type ?? null);
    if (refusal === 'INVALID_STATUS') throw processNotClaimable(process.status);
    if (refusal === 'ALREADY_ASSIGNED') {
      const responsibleId = process.currentResponsibleId ?? '';
      if (
        responsibleId === userId &&
        input.expectedVersion !== null &&
        input.expectedVersion !== process.version
      ) {
        // FA-03: o reenvio do clique duplo já foi aplicado — 412, o front só atualiza a tela.
        throw claimVersionConflict(input.expectedVersion, process.version);
      }
      recordClaimConflict();
      this.logger.warn(
        {
          event: 'claim.conflict',
          processId: process.id,
          correlationId: context.correlationId,
        },
        'claim.conflict',
      );
      const name = (await this.identity.userDisplayNames(tx, [responsibleId])).get(responsibleId);
      throw processAlreadyAssigned({ id: responsibleId, name: name ?? null });
    }
    // 3.1 — `If-Match`.
    if (input.expectedVersion !== null && input.expectedVersion !== process.version) {
      throw claimVersionConflict(input.expectedVersion, process.version);
    }
    const active = rows.stages.find(
      (candidate) => candidate.id === process.currentStageId && candidate.status === 'ACTIVE',
    );
    if (active === undefined) throw processNotClaimable(process.status);

    const labels = await this.support.labels(tx, {
      fromStage: stage?.name ?? '',
      toStage: stage?.name ?? '',
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId: process.currentDepartmentId,
      fromUserId: null,
      toUserId: userId,
    });
    const metadata: MovementMetadata = movementMetadataSchema.parse({
      v: MOVEMENT_METADATA_VERSION,
      labels,
      clientChannel: 'WEB',
    });

    // 3.4–3.6 — responsabilidade `CLAIM`, responsável da passagem e do processo, tramitação.
    const plan = planClaim({
      process,
      active: { id: active.id, workflowStageId: active.workflowStageId },
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
    if (!(await this.processes.recordClaim(tx, plan))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw claimVersionConflict(input.expectedVersion ?? process.version, process.version + 1);
    }

    // 3.7–3.8 — evento (a timeline `PROCESS_CLAIMED` e o `ProcessAccess` RESPONSIBLE vêm dele,
    // no mesmo `tx`) e auditoria.
    await this.outbox.record(
      tx,
      ProcessAssigned.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          processStageId: active.id,
          departmentId: process.currentDepartmentId,
          fromUserId: null,
          toUserId: userId,
          assignmentType: 'CLAIM',
          hasReason: false,
        },
      }),
    );
    const updated = plan.process;
    await this.audit.record(tx, {
      action: 'process.claim',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [{ path: 'currentResponsibleId', old: process.currentResponsibleId, new: userId }],
      metadata: {
        processCode: updated.code,
        processStageId: active.id,
        movementId: plan.movement.id,
        ...batchAuditMetadata(input.batch),
      },
    });

    // POL-09 sobre o NOVO estado.
    const canSeeBudget = await this.panel.canSeeBudget({ ...rows, process: updated }, runtime);
    return { dto: await this.presenter.present(tx, updated, canSeeBudget), lockWaitMs };
  }

  protected override committed(result: ClaimedProcess, durationMs: number): void {
    const context = requireRequestContext();
    recordProcessClaimed(durationMs);
    // Só ids: nunca dados pessoais além do `userId` (story · Logs).
    this.logger.log(
      {
        event: 'process.claimed',
        processId: result.dto.id,
        userId: context.actor.userId,
        durationMs,
        lockWaitMs: result.lockWaitMs,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      'process.claimed',
    );
  }

  override async execute(input: ClaimProcessInput): Promise<ClaimedProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        this.logger.log(
          {
            event: 'process.claim_rejected',
            processId: input.processId,
            code: error.code,
            correlationId: requireRequestContext().correlationId,
          },
          'process.claim_rejected',
        );
      }
      throw error;
    }
  }
}

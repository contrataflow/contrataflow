import {
  ProcessAssigned,
  ProcessStageChanged,
  ProcessStatusChanged,
} from '@contrataflow/validation';
import type { StageChangeCause, StageType, StatusChangeCause } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { forwardVersionConflict } from './process.errors.js';
import { planStageTransition } from '../domain/stage-transition.js';
import type { StageTransitionInput, StageTransitionPlan } from '../domain/stage-transition.js';

export interface StageTransitionRequest {
  /** Plano da mudança (destino, prazo, status e documentos já resolvidos por quem chama). */
  readonly transition: StageTransitionInput;
  /** `ProcessStageChanged.cause` (routing key `process.stage_changed.<cause>`). */
  readonly cause: StageChangeCause;
  /** `ProcessStatusChanged.cause` quando o status muda. */
  readonly statusCause: StatusChangeCause;
  readonly fromStageKey: string;
  readonly toStage: { readonly key: string; readonly type: StageType };
  /** Aprovação aberta pela entrada em etapa `APPROVAL` (US-051), no evento. */
  readonly requestedApprovalId: string | null;
}

/**
 * `StageTransitionService` (US-047 · RN-TRAM-14..17 · RN-TRAM-21) — serviço de mudança de etapa
 * reutilizado pelo encaminhamento (US-047) e, depois, pela devolução (US-048), pela decisão de
 * aprovação (US-052) e pela conclusão (US-010). No `tx` de quem chama, com o processo JÁ travado
 * (`SELECT … FOR UPDATE` — ordem de bloqueio processo → aprovação → documentos):
 *
 * 1. monta o plano puro (`planStageTransition`: encerra a passagem e a responsabilidade ativas,
 *    abre a nova passagem `sequence + 1` com a responsabilidade `STAGE_ENTRY`, registra a
 *    tramitação imutável e atualiza `current*`, `overdueSince = null` e `version + 1`);
 * 2. grava tudo pelo repositório (`recordStageTransition` — `WHERE version` como rede);
 * 3. publica `ProcessStageChanged` (timeline e `ProcessAccess` CURRENT/HISTORICAL/RESPONSIBLE no
 *    mesmo `tx`), `ProcessStatusChanged` só quando o status muda e `ProcessAssigned`
 *    (`STAGE_ENTRY`) quando a nova passagem nasce com responsável.
 *
 * Quem chama resolve destino, responsável, prazo, status, documentos e a aprovação, autoriza e
 * audita a ação própria (`process.forward`, `process.return`…).
 */
@Injectable()
export class StageTransitionService {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  async apply(tx: TenantTx, request: StageTransitionRequest): Promise<StageTransitionPlan> {
    const plan = planStageTransition(request.transition);
    if (!(await this.processes.recordStageTransition(tx, plan))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw forwardVersionConflict(plan.expectedVersion, plan.expectedVersion + 1);
    }
    const { process, movement, entered } = plan;
    const before = request.transition.process;
    await this.outbox.record(
      tx,
      ProcessStageChanged.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          cause: request.cause,
          movementId: movement.id,
          fromStage: { processStageId: plan.closed.id, key: request.fromStageKey },
          toStage: {
            processStageId: entered.id,
            key: request.toStage.key,
            type: request.toStage.type,
          },
          fromDepartmentId: before.currentDepartmentId,
          toDepartmentId: entered.departmentId,
          toUserId: entered.assigneeId,
          dueAt: entered.dueAt?.toISOString() ?? null,
          documentIds: movement.documents.map((document) => document.documentId),
          hasComment: movement.comment !== null,
          approvalId: request.requestedApprovalId,
        },
      }),
    );
    if (before.status !== process.status) {
      await this.outbox.record(
        tx,
        ProcessStatusChanged.of({
          aggregateId: process.id,
          processId: process.id,
          payload: {
            fromStatus: before.status,
            toStatus: process.status,
            cause: request.statusCause,
            reasonProvided: false,
          },
        }),
      );
    }
    if (entered.assigneeId !== null) {
      await this.outbox.record(
        tx,
        ProcessAssigned.of({
          aggregateId: process.id,
          processId: process.id,
          payload: {
            processStageId: entered.id,
            departmentId: entered.departmentId,
            fromUserId: before.currentResponsibleId,
            toUserId: entered.assigneeId,
            assignmentType: 'STAGE_ENTRY',
            hasReason: false,
          },
        }),
      );
    }
    return plan;
  }
}

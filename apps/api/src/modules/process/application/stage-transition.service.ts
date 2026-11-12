import {
  ProcessAssigned,
  ProcessStageChanged,
  ProcessStatusChanged,
} from '@contrataflow/validation';
import type { StageChangeCause, StageType, StatusChangeCause } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { BranchEngine } from './branch-engine.js';
import type { AppliedTransition, BranchScope } from './branch-engine.js';
import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { forwardVersionConflict } from './process.errors.js';
import { stageDueComputedLog } from '../domain/stage-deadline.js';
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
  /** Etapa de destino; `branchKey` = ramo dela na versão (US-124 — ausente/nulo no tronco). */
  readonly toStage: {
    readonly key: string;
    readonly type: StageType;
    readonly branchKey?: string | null | undefined;
  };
  /** Aprovação aberta pela entrada em etapa `APPROVAL` (US-051), no evento. */
  readonly requestedApprovalId: string | null;
  /**
   * US-124: o processo real e a etapa-alvo quando a ação foi resolvida por etapa (a `transition`
   * vem focada nela). Com ele, o serviço trata ramos: entrar no split, avançar/devolver no ramo,
   * chegar à junção e devolver para antes da ramificação. Ausente = MVP 1 (tronco).
   */
  readonly scope?: BranchScope | undefined;
  /** US-124: avisos reconhecidos no PRC-19 (regras `WARNING` da junção no último ramo). */
  readonly acknowledgedWarnings?: readonly string[] | undefined;
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
 *    (`STAGE_ENTRY`; `RETURN` na devolução) quando a nova passagem nasce com responsável.
 *
 * Quem chama resolve destino, responsável, prazo, status, documentos e a aprovação, autoriza e
 * audita a ação própria (`process.forward`, `process.return`…).
 */
@Injectable()
export class StageTransitionService {
  private readonly logger = new Logger('StageTransitionService');

  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly branches: BranchEngine,
  ) {}

  /**
   * US-124 (DEC-194): a mudança de etapa ciente de ramos — entrar no `PARALLEL_SPLIT` abre os
   * ramos; a partir de etapa de ramo, ir para o `PARALLEL_JOIN` é a chegada (e a junção, no
   * último), ficar no mesmo ramo é avanço/devolução no ramo e sair dele é a devolução para antes da
   * ramificação. Sem ramos, o caminho do MVP 1 (abaixo), inalterado.
   */
  async apply(tx: TenantTx, request: StageTransitionRequest): Promise<AppliedTransition> {
    const { scope } = request;
    if (scope !== undefined) {
      const branchRequest = {
        transition: request.transition,
        cause: request.cause,
        statusCause: request.statusCause,
        fromStageKey: request.fromStageKey,
        toStage: request.toStage,
        requestedApprovalId: request.requestedApprovalId,
        scope,
        ...(request.acknowledgedWarnings === undefined
          ? {}
          : { acknowledgedWarnings: request.acknowledgedWarnings }),
      };
      if (request.toStage.type === 'PARALLEL_SPLIT') return this.branches.open(tx, branchRequest);
      if (scope.target.branchKey !== null) {
        if (request.toStage.type === 'PARALLEL_JOIN')
          return this.branches.arrive(tx, branchRequest);
        if ((request.toStage.branchKey ?? null) === scope.target.branchKey) {
          return this.branches.withinBranch(tx, branchRequest);
        }
        return this.branches.leave(tx, branchRequest);
      }
    }
    return { ...(await this.trunk(tx, request)), branch: null };
  }

  /** O caminho do MVP 1: uma passagem ativa no tronco. */
  private async trunk(tx: TenantTx, request: StageTransitionRequest): Promise<StageTransitionPlan> {
    const plan = planStageTransition(request.transition);
    if (!(await this.processes.recordStageTransition(tx, plan))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw forwardVersionConflict(plan.expectedVersion, plan.expectedVersion + 1);
    }
    const { process, movement, entered } = plan;
    // US-055 · RN-TRAM-78/79: o prazo da nova passagem (calculado ou sobrescrito).
    this.logger.log(stageDueComputedLog(entered));
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
            assignmentType: plan.assignment.type === 'RETURN' ? 'RETURN' : 'STAGE_ENTRY',
            hasReason: false,
          },
        }),
      );
    }
    return plan;
  }
}

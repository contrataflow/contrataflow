import { PROCESS_FORWARD_MESSAGES } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { transitionNotAvailable } from './process.errors.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import type { ApprovalPlan } from '../../approval/application/approval.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { WorkflowSnapshotStage } from '../../workflow/application/workflow.facade.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import type { Process } from '../domain/process.js';

/** Unidade, responsável, prazo e aprovação de uma etapa aberta pelo motor (US-124). */
export interface ResolvedStageEntry {
  readonly stage: WorkflowSnapshotStage;
  readonly departmentId: string;
  /** `null` = fila da unidade. */
  readonly assigneeId: string | null;
  readonly dueAt: Date | null;
  /** Etapa `APPROVAL`: política e linhas resolvidas ANTES de qualquer escrita (US-133). */
  readonly approvalPlan: ApprovalPlan | null;
}

/**
 * `StageEntryResolver` (US-124 · RN-WF2-13/21): resolve, para as etapas em que o MOTOR entra sem
 * escolha do usuário — a primeira etapa de cada ramo na entrada do `PARALLEL_SPLIT` e a etapa de
 * saída da junção —, unidade (RN-WF-30 · RN-TRAM-07), responsável (RN-WF-31 · RN-TRAM-08, candidato
 * inelegível vai para a fila), prazo (RN-TRAM-09) e, em etapa `APPROVAL`, o aprovador (US-051/133).
 * `CHOSEN_ON_FORWARD` não tem quem escolha aqui: o caminho fica indisponível
 * (`TRANSITION_NOT_AVAILABLE`), como a unidade inativa. Nada é gravado.
 */
@Injectable()
export class StageEntryResolver {
  constructor(
    private readonly workflow: WorkflowFacade,
    private readonly organization: OrganizationFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly approvals: ApprovalFacade,
    private readonly support: StageTransitionSupport,
  ) {}

  async resolve(
    tx: TenantTx,
    input: {
      readonly stage: WorkflowSnapshotStage;
      readonly process: Process;
      readonly runtime: ProcessRuntime;
      readonly now: Date;
    },
  ): Promise<ResolvedStageEntry> {
    const { stage, process, runtime, now } = input;
    const resolved = this.workflow.resolveStageDepartment(stage, process, null);
    const departmentId = resolved.departmentId;
    if (stage.departmentResolution === 'CHOSEN_ON_FORWARD' || departmentId === null) {
      throw transitionNotAvailable(PROCESS_FORWARD_MESSAGES.destinationInactive);
    }
    const reference = (await this.organization.departmentReferences(tx, [departmentId])).get(
      departmentId,
    );
    if (reference?.isActive !== true) {
      throw transitionNotAvailable(PROCESS_FORWARD_MESSAGES.destinationInactive);
    }
    const assigneeId =
      stage.type === 'APPROVAL'
        ? null
        : await this.assignee(tx, stage, runtime, departmentId, reference.headUserId ?? null, now);
    const dueAt =
      stage.slaDays === null
        ? null
        : await this.calendar.addBusinessDays(tx, now, stage.slaDays, stage.slaType);
    const approvalPlan =
      stage.type === 'APPROVAL'
        ? await this.approvals.resolveStageApprovalIn(tx, stage, process, now)
        : null;
    return { stage, departmentId, assigneeId, dueAt, approvalPlan };
  }

  private async assignee(
    tx: TenantTx,
    stage: WorkflowSnapshotStage,
    runtime: ProcessRuntime,
    departmentId: string,
    headUserId: string | null,
    now: Date,
  ): Promise<string | null> {
    const candidate = this.workflow.resolveStageAssignee(stage, {
      creatorId: runtime.createdById,
      departmentHeadId: stage.assignmentPolicy === 'DEPARTMENT_HEAD' ? headUserId : null,
      passes: runtime.passes,
    });
    if (candidate === null) return null;
    return (await this.support.isEligibleAssignee(tx, candidate, departmentId, now))
      ? candidate
      : null;
  }
}

import type { DayCountType } from '@contrataflow/types';
import type { StageType } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type {
  ProcessBranchContextReader,
  StageBranchContext,
} from '#shared/process/process-branch-context.js';

import { PROCESS_CLOCK, PROCESS_REPOSITORY } from './ports.js';
import type { ProcessAggregateRows, ProcessClock, ProcessRepository } from './ports.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { WorkflowSnapshot } from '../../workflow/application/workflow.facade.js';
import { criticalStageOf, isStageOverdue, siblingsOf } from '../domain/branch-views.js';
import type { BranchViewBranch, BranchViewStage } from '../domain/branch-views.js';
import { activeSplitOf, activeStagesOf } from '../domain/process-branches.js';

/*
 * Ramos paralelos nas leituras (US-125 · RN-WF2-30/33/34/36/37 · DEC-194): a fotografia da rodada
 * ATUAL de um processo em ramificação — as etapas ativas (com unidade, responsável e prazo
 * próprios), os ramos (`OPEN`/`ARRIVED`, com rótulo e a etapa em curso ou a última) e a etapa
 * crítica (menor `dueAt`). Fora da ramificação não há fotografia (`null`): as leituras do MVP 1
 * seguem inalteradas (DEC-108). Somente leitura, no `tx` de quem chama.
 */

/** Etapa ativa de um processo em ramificação, com o que as leituras mostram. */
export interface BranchViewActiveStage extends BranchViewStage {
  readonly stageType: StageType;
  readonly branchLabel: string | null;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly enteredAt: Date;
  readonly slaType: DayCountType | null;
  readonly openedByReturn: boolean;
  readonly isOverdue: boolean;
}

export interface ProcessBranchView {
  readonly processId: string;
  readonly splitProcessStageId: string;
  /** Etapas ativas acionáveis, na ordem de entrada. */
  readonly stages: readonly BranchViewActiveStage[];
  /** Ramos da rodada atual (sem os cancelados), na ordem de criação. */
  readonly branches: readonly BranchViewBranch[];
  /** Menor `dueAt` entre as etapas ativas (RN-WF2-34); `null` se nenhuma tem prazo. */
  readonly critical: BranchViewActiveStage | null;
}

@Injectable()
export class ProcessBranchViews implements ProcessBranchContextReader {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly workflow: WorkflowFacade,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
  ) {}

  /** A fotografia de um agregado já carregado; `null` fora da ramificação. */
  async ofRows(tx: TenantTx, rows: ProcessAggregateRows): Promise<ProcessBranchView | null> {
    if (activeSplitOf(rows.stages) === null) return null;
    const definition = await this.workflow.publishedDefinitionIn(
      tx,
      rows.process.workflowVersionId,
    );
    return branchViewOf(rows, definition, this.clock());
  }

  /**
   * As fotografias dos processos informados que estão em ramificação (os demais ficam fora do
   * mapa). Um agregado por processo — chamado só para as linhas de uma página com ramos.
   */
  async ofProcesses(
    tx: TenantTx,
    processIds: readonly string[],
  ): Promise<Map<string, ProcessBranchView>> {
    const views = new Map<string, ProcessBranchView>();
    const definitions = new Map<string, WorkflowSnapshot | null>();
    const now = this.clock();
    for (const processId of new Set(processIds)) {
      const rows = await this.processes.loadAggregate(tx, processId);
      if (rows === null || activeSplitOf(rows.stages) === null) continue;
      const versionId = rows.process.workflowVersionId;
      if (!definitions.has(versionId)) {
        definitions.set(versionId, await this.workflow.publishedDefinitionIn(tx, versionId));
      }
      const view = branchViewOf(rows, definitions.get(versionId) ?? null, now);
      if (view !== null) views.set(processId, view);
    }
    return views;
  }

  /**
   * `ProcessBranchContextReader` (US-125 · RN-WF2-37 — APV-01/APV-02): o ramo, o rótulo e os
   * irmãos de cada etapa de ramo informada. Etapa de ramo de processo que já saiu da ramificação
   * (aprovação decidida) mantém o ramo e o rótulo, sem irmãos.
   */
  async forStages(
    tx: TenantTx,
    stages: readonly { readonly processId: string; readonly processStageId: string }[],
  ): Promise<Map<string, StageBranchContext>> {
    const contexts = new Map<string, StageBranchContext>();
    const branchKeys = await this.processes.branchKeysOf(
      tx,
      stages.map((stage) => stage.processStageId),
    );
    if (branchKeys.size === 0) return contexts;
    const definitions = new Map<string, WorkflowSnapshot | null>();
    const now = this.clock();
    for (const processId of new Set([...branchKeys.values()].map((entry) => entry.processId))) {
      const rows = await this.processes.loadAggregate(tx, processId);
      if (rows === null) continue;
      const versionId = rows.process.workflowVersionId;
      if (!definitions.has(versionId)) {
        definitions.set(versionId, await this.workflow.publishedDefinitionIn(tx, versionId));
      }
      const definition = definitions.get(versionId) ?? null;
      const view = branchViewOf(rows, definition, now);
      for (const [stageId, entry] of branchKeys) {
        if (entry.processId !== processId) continue;
        const own = view?.stages.some((stage) => stage.processStageId === stageId) ?? false;
        const siblings = own && view !== null ? siblingsOf(view.branches, entry.branchKey) : null;
        contexts.set(stageId, {
          branchKey: entry.branchKey,
          branchLabel: branchLabelOf(definition, entry.branchKey),
          siblings: siblings?.siblings ?? [],
          siblingsMore: siblings?.siblingsMore ?? 0,
        });
      }
    }
    return contexts;
  }
}

/** Rótulo do ramo: o nome da etapa cuja `key` é o `branchKey` (RN-WF2-07). */
export function branchLabelOf(definition: WorkflowSnapshot | null, branchKey: string): string {
  return definition?.stages.find((stage) => stage.key === branchKey)?.name ?? branchKey;
}

function branchViewOf(
  rows: ProcessAggregateRows,
  definition: WorkflowSnapshot | null,
  now: Date,
): ProcessBranchView | null {
  const split = activeSplitOf(rows.stages);
  if (split === null) return null;
  const named = (workflowStageId: string) =>
    definition?.stages.find((stage) => stage.id === workflowStageId);
  const stages = activeStagesOf(rows.stages).map((stage): BranchViewActiveStage => {
    const base: BranchViewStage = {
      processStageId: stage.id,
      workflowStageId: stage.workflowStageId,
      stageKey: named(stage.workflowStageId)?.key ?? '',
      stageName: named(stage.workflowStageId)?.name ?? '',
      branchKey: stage.branchKey,
      dueAt: stage.dueAt,
      pausedAt: stage.pausedAt,
      overdueSince: stage.overdueSince,
    };
    return {
      ...base,
      stageType: stage.stageType,
      branchLabel: stage.branchKey === null ? null : branchLabelOf(definition, stage.branchKey),
      departmentId: stage.departmentId,
      assigneeId: stage.assigneeId,
      enteredAt: stage.enteredAt,
      slaType: stage.slaType,
      openedByReturn: stage.openedByReturn,
      isOverdue: isStageOverdue(base, now),
    };
  });
  const branches = rows.branches
    .filter((branch) => branch.splitProcessStageId === split.id && branch.status !== 'CANCELED')
    .map((branch): BranchViewBranch => {
      const own = rows.stages
        .filter(
          (stage) => stage.splitProcessStageId === split.id && stage.branchKey === branch.branchKey,
        )
        .sort((left, right) => right.sequence - left.sequence);
      const active = stages.find((stage) => stage.branchKey === branch.branchKey);
      const last = own[0];
      return {
        branchKey: branch.branchKey,
        branchLabel: branchLabelOf(definition, branch.branchKey),
        status: branch.status === 'ARRIVED' ? 'ARRIVED' : 'OPEN',
        arrivedAt: branch.arrivedAt,
        stageName:
          active?.stageName ??
          (last === undefined ? '' : (named(last.workflowStageId)?.name ?? '')),
        isOverdue: active?.isOverdue ?? false,
      };
    });
  return {
    processId: rows.process.id,
    splitProcessStageId: split.id,
    stages,
    branches,
    critical: criticalStageOf(stages),
  };
}

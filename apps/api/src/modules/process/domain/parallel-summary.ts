import type { ActionEntry, ProcessStatus, ProcessSummaryDto } from '@contrataflow/validation';

import { stageStatusOf } from './process-branches.js';
import { selectPrimaryAction } from './process-summary.js';
import type { ApprovalForPanel } from './process-summary.js';

/*
 * Painel situacional no paralelismo (US-125 · RN-WF2-33 · DEC-180/DEC-194), parte pura: as
 * respostas por etapa ativa de "Onde está?", "Quem é o responsável?" e "Qual o próximo passo?" —
 * a etapa do usuário (custódia: responsável, ou fila de uma lotação) com a ação primária dela; as
 * demais como "Aguardando". Tudo aditivo: fora da ramificação o PRC-07 do MVP 1 não muda.
 */

/** Etapa ativa como o painel a recebe (já com nomes resolvidos pelo chamador). */
export interface SummaryStageFacts {
  readonly processStageId: string;
  readonly stageKey: string;
  readonly stageName: string;
  readonly stageType: NonNullable<ProcessSummaryDto['where']['stages']>[number]['stageType'];
  readonly branchKey: string | null;
  readonly branchLabel: string | null;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly enteredAt: Date;
  readonly dueAt: Date | null;
  readonly isOverdue: boolean;
  readonly openedByReturn: boolean;
}

export interface ParallelSummaryInput {
  readonly status: ProcessStatus;
  readonly stages: readonly SummaryStageFacts[];
  readonly branches: readonly {
    readonly branchKey: string;
    readonly branchLabel: string;
    readonly status: 'OPEN' | 'ARRIVED';
    readonly arrivedAt: Date | null;
  }[];
  readonly viewer: { readonly userId: string; readonly departmentIds: readonly string[] };
  /** PRC-08 do usuário — as ações de etapa trazem `processStageId` (US-124). */
  readonly actions: readonly ActionEntry[];
  readonly approvals: readonly ApprovalForPanel[];
  readonly departmentName: (id: string) => string;
  readonly userName: (id: string) => string;
}

type Where = ProcessSummaryDto['where'];
type Responsible = ProcessSummaryDto['responsible'];
type NextStep = ProcessSummaryDto['nextStep'];

export interface ParallelSummary {
  readonly whereStages: NonNullable<Where['stages']>;
  readonly whereBranches: NonNullable<Where['branches']>;
  readonly responsibleByStage: NonNullable<Responsible['byStage']>;
  readonly nextStepByStage: NonNullable<NextStep['byStage']>;
}

/** Custódia da etapa (RN-WF2-17 · POL-01 por ramo): o responsável ou a fila de uma lotação. */
export function isStageMine(
  stage: Pick<SummaryStageFacts, 'assigneeId' | 'departmentId'>,
  viewer: ParallelSummaryInput['viewer'],
): boolean {
  return stage.assigneeId === null
    ? viewer.departmentIds.includes(stage.departmentId)
    : stage.assigneeId === viewer.userId;
}

export function parallelSummaryOf(input: ParallelSummaryInput): ParallelSummary {
  const department = (id: string) => ({ id, name: input.departmentName(id) });
  const whereStages = input.stages.map((stage) => ({
    processStageId: stage.processStageId,
    stageKey: stage.stageKey,
    stageName: stage.stageName,
    stageType: stage.stageType,
    branchKey: stage.branchKey,
    branchLabel: stage.branchLabel,
    department: department(stage.departmentId),
    responsible:
      stage.assigneeId === null
        ? null
        : { id: stage.assigneeId, name: input.userName(stage.assigneeId) },
    enteredAt: stage.enteredAt.toISOString(),
    dueAt: stage.dueAt?.toISOString() ?? null,
    isOverdue: stage.isOverdue,
    openedByReturn: stage.openedByReturn,
    isMine: isStageMine(stage, input.viewer),
  }));
  const responsibleByStage = input.stages.map((stage) => ({
    processStageId: stage.processStageId,
    branchKey: stage.branchKey,
    user:
      stage.assigneeId === null
        ? null
        : { id: stage.assigneeId, name: input.userName(stage.assigneeId) },
    queueDepartment: stage.assigneeId === null ? department(stage.departmentId) : null,
    since: stage.enteredAt.toISOString(),
  }));
  const nextStepByStage = input.stages.map((stage) => {
    const isMine = isStageMine(stage, input.viewer);
    const action = isMine
      ? selectPrimaryAction({
          status: stageStatusOf(input.status, stage),
          actions: input.actions.filter(
            (entry) =>
              entry.processStageId === undefined || entry.processStageId === stage.processStageId,
          ),
          approvals: input.approvals.filter(
            (approval) => approval.processStageId === stage.processStageId,
          ),
        })
      : null;
    return {
      processStageId: stage.processStageId,
      branchKey: stage.branchKey,
      branchLabel: stage.branchLabel,
      stageName: stage.stageName,
      isMine,
      action,
      waitingFor: isMine
        ? null
        : { stageName: stage.stageName, departmentName: input.departmentName(stage.departmentId) },
    };
  });
  return {
    whereStages,
    whereBranches: input.branches.map((branch) => ({
      branchKey: branch.branchKey,
      branchLabel: branch.branchLabel,
      status: branch.status,
      arrivedAt: branch.arrivedAt?.toISOString() ?? null,
    })),
    responsibleByStage,
    nextStepByStage,
  };
}

import { BRANCH_SIBLINGS_LIMIT } from '@contrataflow/validation';
import type { BranchSiblingDto, CriticalStageDto } from '@contrataflow/validation';

/*
 * Ramos paralelos nas LEITURAS (US-125 · RN-WF2-30/34 · DEC-194), parte pura: o prazo do processo
 * como o menor `dueAt` entre as etapas ativas (`ProcessDeadlineCalculator` — com a etapa crítica) e
 * o resumo dos outros ramos (`SiblingBranchesProjection`, até 3 + excedente, sem pessoas nem
 * valores — POL-09).
 */

/** Uma etapa ativa como as leituras a enxergam. */
export interface BranchViewStage {
  readonly processStageId: string;
  readonly workflowStageId: string;
  readonly stageKey: string;
  readonly stageName: string;
  readonly branchKey: string | null;
  readonly dueAt: Date | null;
  readonly pausedAt: Date | null;
  readonly overdueSince: Date | null;
}

/** Um ramo da rodada atual (os cancelados não aparecem nas leituras). */
export interface BranchViewBranch {
  readonly branchKey: string;
  /** Nome da primeira etapa do ramo na versão (RN-WF2-07); a chave se a versão não a tiver. */
  readonly branchLabel: string;
  readonly status: 'OPEN' | 'ARRIVED';
  readonly arrivedAt: Date | null;
  /** Etapa ativa (`OPEN`) ou a última percorrida (`ARRIVED`). */
  readonly stageName: string;
  readonly isOverdue: boolean;
}

/** RN-WF2-34: etapa atrasada = `overdueSince` marcado pelo job ou prazo vencido sem pausa. */
export function isStageOverdue(stage: BranchViewStage, now: Date): boolean {
  if (stage.overdueSince !== null) return true;
  return stage.dueAt !== null && stage.pausedAt === null && stage.dueAt.getTime() < now.getTime();
}

/**
 * `ProcessDeadlineCalculator` (RN-WF2-34): o menor `dueAt` entre as etapas ativas que têm prazo
 * (as sem SLA não contam; nenhuma = `null`), com a etapa crítica. Empate: a de menor `sequence`
 * (ordem de entrada — a lista chega ordenada) para o resultado ser estável.
 */
export function criticalStageOf<T extends Pick<BranchViewStage, 'dueAt'>>(
  stages: readonly T[],
): T | null {
  let critical: T | null = null;
  for (const stage of stages) {
    if (stage.dueAt === null) continue;
    if (critical === null || (critical.dueAt?.getTime() ?? 0) > stage.dueAt.getTime()) {
      critical = stage;
    }
  }
  return critical;
}

export function criticalStageDtoOf(stage: BranchViewStage): CriticalStageDto {
  return {
    processStageId: stage.processStageId,
    branchKey: stage.branchKey,
    stageName: stage.stageName,
  };
}

/** `SiblingBranchesProjection` (RN-WF2-30): os outros ramos (até 3) e o excedente. */
export function siblingsOf(
  branches: readonly BranchViewBranch[],
  ownBranchKey: string | null,
): { readonly siblings: BranchSiblingDto[]; readonly siblingsMore: number } {
  const others = branches.filter((branch) => branch.branchKey !== ownBranchKey);
  return {
    siblings: others.slice(0, BRANCH_SIBLINGS_LIMIT).map((branch) => ({
      branchKey: branch.branchKey,
      branchLabel: branch.branchLabel,
      stageName: branch.stageName,
      status: branch.status,
      isOverdue: branch.isOverdue,
    })),
    siblingsMore: Math.max(0, others.length - BRANCH_SIBLINGS_LIMIT),
  };
}

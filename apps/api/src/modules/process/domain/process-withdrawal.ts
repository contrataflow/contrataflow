/*
 * Retirada da aprovação de etapa (US-053 · APV-04 · POL-17 · RN-TRAM-64/68), puro: a passagem de
 * origem (a que encaminhou o processo à etapa `APPROVAL` ativa) e a custódia anterior. Leituras,
 * permissão sobre a unidade e gravações são do `ProcessApprovalSubjectHandler`; a devolução é a do
 * `StageTransitionService` (mecânica da US-048, com `metadata.withdrawn`).
 */

/** Passagem como a retirada a lê. */
export interface WithdrawalPass {
  readonly id: string;
  readonly sequence: number;
  readonly status: string;
  readonly workflowStageId: string;
  readonly departmentId: string;
}

/**
 * A passagem de origem: a imediatamente anterior (`sequence − 1`) à passagem ATIVA `stageId` da
 * aprovação. `null` = a passagem não está ativa (a aprovação não é mais a da etapa atual) ou não há
 * passagem anterior.
 */
export function originPassOf<T extends WithdrawalPass>(
  stages: readonly T[],
  stageId: string | null,
): T | null {
  const active = stages.find((stage) => stage.id === stageId && stage.status === 'ACTIVE');
  if (active === undefined) return null;
  return stages.find((stage) => stage.sequence === active.sequence - 1) ?? null;
}

export interface PreviousCustodyFacts {
  readonly userId: string;
  /** `Approval.requestedById` — quem encaminhou à aprovação. */
  readonly requestedById: string;
  /** Unidade da passagem de origem. */
  readonly originDepartmentId: string;
  /** Lotações de quem retira. */
  readonly viewerDepartmentIds: readonly string[];
}

/**
 * POL-17 (RN-TRAM-64): custódia anterior — o solicitante da aprovação ou quem está lotado na
 * unidade de origem do movimento que criou a etapa `APPROVAL` atual. A permissão
 * (`PROCESS_FORWARD` sobre essa unidade) é conferida à parte.
 */
export function hasPreviousCustody(facts: PreviousCustodyFacts): boolean {
  return (
    facts.userId === facts.requestedById ||
    facts.viewerDepartmentIds.includes(facts.originDepartmentId)
  );
}

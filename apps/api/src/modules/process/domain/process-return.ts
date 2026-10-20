import type { ProcessStatus, StageDepartmentResolution } from '@contrataflow/validation';

/*
 * Regras da devolução (US-048 · PRC-20 · RN-TRAM-23..30) sobre fatos já carregados: status em que
 * se devolve, unidade da etapa de destino (RN-TRAM-27) e o responsável por `PREVIOUS_ASSIGNEE`
 * (RN-TRAM-28). Puro: leituras, autorização e gravações são do `ReturnProcessCommand`; a mudança
 * de etapa é a do `StageTransitionService` (US-047).
 */

/**
 * RN-TRAM-23 (POL-01): só `IN_PROGRESS`. Em `AWAITING_APPROVAL` a devolução é a decisão `RETURN`
 * (US-052) ou a retirada (US-053); `RETURNED`/`DRAFT` seguem pelo encaminhamento.
 */
export function canReturnInStatus(status: ProcessStatus): boolean {
  return status === 'IN_PROGRESS';
}

/** Responsabilidade de uma passagem anterior pela etapa de destino (`ProcessAssignment`). */
export interface PreviousAssignment {
  readonly assigneeId: string | null;
  readonly startedAt: Date;
}

/**
 * RN-TRAM-28: o `assigneeId` da responsabilidade mais recente (maior `startedAt`) com responsável
 * individual entre as passagens anteriores pela etapa; nenhuma = fila da unidade (`null` — FA-01).
 */
export function resolvePreviousAssignee(history: readonly PreviousAssignment[]): string | null {
  let latest: PreviousAssignment | null = null;
  for (const assignment of history) {
    if (assignment.assigneeId === null) continue;
    if (latest === null || assignment.startedAt.getTime() > latest.startedAt.getTime()) {
      latest = assignment;
    }
  }
  return latest?.assigneeId ?? null;
}

/**
 * RN-TRAM-27: unidade da etapa de destino. `FIXED`/`REQUESTING_*` recalculados pelo workflow a
 * partir do processo; `CHOSEN_ON_FORWARD` reaproveita a unidade da última passagem pela etapa (a
 * devolução não coleta nova escolha). `null` = configuração sem unidade resolvível.
 */
export function returnDepartmentOf(
  mode: StageDepartmentResolution,
  resolvedDepartmentId: string | null,
  lastPassDepartmentId: string,
): string | null {
  return mode === 'CHOSEN_ON_FORWARD' ? lastPassDepartmentId : resolvedDepartmentId;
}

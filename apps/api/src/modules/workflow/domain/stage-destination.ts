import type { StageAssignmentPolicy, StageDepartmentResolution } from '@contrataflow/validation';

import type { StagePassFact } from './rule-facts.js';

/*
 * Destino de uma etapa alcançada (US-041 · RN-WF-30/31): a unidade responsável pela
 * `departmentResolution` e o responsável inicial pela `assignmentPolicy`. Puro — os comandos de
 * tramitação (encaminhar US-047, devolver US-048) e a prévia de PRC-08 usam as mesmas funções.
 */

export interface DestinationStage {
  readonly id: string;
  readonly departmentResolution: StageDepartmentResolution;
  readonly fixedDepartmentId: string | null;
  readonly assignmentPolicy: StageAssignmentPolicy;
}

export interface RequestingUnits {
  readonly requestingDepartmentId: string;
  readonly requestingSecretariatId: string;
}

export interface ResolvedDepartment {
  readonly mode: StageDepartmentResolution;
  /** `null` = `CHOSEN_ON_FORWARD` sem a unidade escolhida (o comando exige — DEPARTMENT_REQUIRED). */
  readonly departmentId: string | null;
}

/**
 * RN-WF-30: `FIXED` usa `fixedDepartmentId`; `REQUESTING_DEPARTMENT`/`REQUESTING_SECRETARIAT`
 * usam os campos homônimos do processo; `CHOSEN_ON_FORWARD` usa a unidade informada no comando.
 */
export function resolveStageDepartment(
  stage: DestinationStage,
  process: RequestingUnits,
  chosenDepartmentId: string | null = null,
): ResolvedDepartment {
  switch (stage.departmentResolution) {
    case 'FIXED':
      return { mode: 'FIXED', departmentId: stage.fixedDepartmentId };
    case 'REQUESTING_DEPARTMENT':
      return { mode: 'REQUESTING_DEPARTMENT', departmentId: process.requestingDepartmentId };
    case 'REQUESTING_SECRETARIAT':
      return { mode: 'REQUESTING_SECRETARIAT', departmentId: process.requestingSecretariatId };
    case 'CHOSEN_ON_FORWARD':
      return { mode: 'CHOSEN_ON_FORWARD', departmentId: chosenDepartmentId };
  }
}

/** Responsável da última passagem pela etapa que teve responsável individual (ou `null`). */
export function previousAssigneeOf(
  passes: readonly StagePassFact[],
  workflowStageId: string,
): string | null {
  const withAssignee = passes.filter(
    (pass) => pass.workflowStageId === workflowStageId && pass.assigneeId !== null,
  );
  const last = withAssignee.reduce<StagePassFact | null>(
    (latest, pass) => (latest === null || pass.sequence > latest.sequence ? pass : latest),
    null,
  );
  return last?.assigneeId ?? null;
}

export interface AssigneeCandidates {
  /** Criador do processo (`Process.createdById`). */
  readonly creatorId: string;
  /** Titular da unidade resolvida pela RN-WF-30 (`null` = sem titular ou unidade em aberto). */
  readonly departmentHeadId: string | null;
  /** Passagens do processo (para `PREVIOUS_ASSIGNEE`). */
  readonly passes: readonly StagePassFact[];
}

/**
 * RN-WF-31: `UNASSIGNED` → fila da unidade (`null`); `CREATOR` → criador; `DEPARTMENT_HEAD` →
 * titular da unidade resolvida; `PREVIOUS_ASSIGNEE` → responsável da última passagem pela MESMA
 * etapa, quando existir. A elegibilidade do candidato (vínculo, lotação) é do comando (RN-TRAM-08).
 */
export function resolveStageAssignee(
  stage: DestinationStage,
  candidates: AssigneeCandidates,
): string | null {
  switch (stage.assignmentPolicy) {
    case 'UNASSIGNED':
      return null;
    case 'CREATOR':
      return candidates.creatorId;
    case 'DEPARTMENT_HEAD':
      return candidates.departmentHeadId;
    case 'PREVIOUS_ASSIGNEE':
      return previousAssigneeOf(candidates.passes, stage.id);
  }
}

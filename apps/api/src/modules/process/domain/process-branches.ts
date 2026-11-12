import type { DayCountType } from '@contrataflow/types';
import type { ProcessStageStatus, ProcessStatus, StageType } from '@contrataflow/validation';

import type { ProcessCompletion } from './process-completion.js';
import type { ProcessAssignmentRecord, ProcessMovementRecord } from './process-runtime-records.js';
import type { Process } from './process.js';

/*
 * Motor de ramos paralelos — parte pura (US-124 · DEC-194 · ADR-005 · RN-WF2-13..28). A fonte de
 * verdade das etapas ativas passa a ser `ProcessStage` (`status = ACTIVE`); `currentStageId` aponta
 * para a única etapa ativa ou, no paralelismo, para a passagem do `PARALLEL_SPLIT` (a "raiz" do
 * bloco, nunca acionável). Aqui ficam: o status macro com várias etapas ativas (RN-WF2-16), a
 * resolução da etapa-alvo de uma ação (RN-WF2-18), a VISÃO FOCADA do processo na etapa-alvo (o
 * motor e as regras do MVP 1 rodam sobre ela sem saber de ramos — custódia por ramo, RN-WF2-17), as
 * desnormalizações do processo no paralelismo (RN-WF2-14), o plano de gravação genérico
 * (`RuntimeChange`) e as invariantes do bloco ("sem etapa ativa órfã", RN-WF2-21).
 */

/** Passagem como o motor de ramos a lê (a `ProcessStageRow` do repositório satisfaz). */
export interface BranchAwareStage {
  readonly id: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly status: ProcessStageStatus;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly enteredAt: Date;
  readonly exitedAt: Date | null;
  readonly dueAt: Date | null;
  readonly stageType: StageType;
  readonly branchKey: string | null;
  readonly splitProcessStageId: string | null;
  /** Aberta por devolução (`enteredViaMovement.action = RETURN`). */
  readonly openedByReturn: boolean;
}

export type ProcessBranchStatus = 'OPEN' | 'ARRIVED' | 'CANCELED';

/** `ProcessBranch` (entities.md MVP 2 §4.7). */
export interface ProcessBranchRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly splitProcessStageId: string;
  readonly branchKey: string;
  readonly status: ProcessBranchStatus;
  readonly arrivedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly createdAt: Date;
}

/** Tipos que não são etapa de trabalho: a ramificação e a junção (RN-WF2-15). */
export function isControlStageType(type: StageType): boolean {
  return type === 'PARALLEL_SPLIT' || type === 'PARALLEL_JOIN';
}

/** Etapas ativas acionáveis (todas menos split/join), na ordem de entrada. */
export function activeStagesOf<T extends BranchAwareStage>(stages: readonly T[]): T[] {
  return stages
    .filter((stage) => stage.status === 'ACTIVE' && !isControlStageType(stage.stageType))
    .sort((left, right) => left.sequence - right.sequence);
}

/** A passagem ativa do `PARALLEL_SPLIT` (o processo está em ramificação), ou `null`. */
export function activeSplitOf<T extends BranchAwareStage>(stages: readonly T[]): T | null {
  return (
    stages.find((stage) => stage.status === 'ACTIVE' && stage.stageType === 'PARALLEL_SPLIT') ??
    null
  );
}

/** Status em que o status macro é recalculado pelas etapas ativas (os demais não mudam). */
const LIVE_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
]);

type MacroStage = Pick<BranchAwareStage, 'stageType' | 'openedByReturn'>;

/**
 * RN-WF2-16 (DEC-013 · DEC-194): `RETURNED` se ALGUMA etapa ativa foi aberta por devolução; senão
 * `IN_PROGRESS` se alguma for de trabalho (`TASK`…); senão `AWAITING_APPROVAL`. Sem etapa ativa, o
 * status de entrada fica (quem encerra o processo decide).
 */
export function macroStatus(
  actives: readonly MacroStage[],
  fallback: ProcessStatus,
): ProcessStatus {
  if (actives.length === 0) return fallback;
  if (actives.some((stage) => stage.openedByReturn)) return 'RETURNED';
  if (actives.some((stage) => stage.stageType !== 'APPROVAL')) return 'IN_PROGRESS';
  return 'AWAITING_APPROVAL';
}

/**
 * Status visto por quem age numa etapa de ramo (RN-WF2-16: a permissão é avaliada pelo tipo da
 * etapa-alvo): `APPROVAL` só se decide; `TASK` aberta por devolução está devolvida; as demais em
 * andamento. Suspenso, rascunho e finais valem para o processo inteiro (RN-WF2-25).
 */
export function stageStatusOf(processStatus: ProcessStatus, stage: MacroStage): ProcessStatus {
  if (!LIVE_STATUSES.has(processStatus)) return processStatus;
  if (stage.stageType === 'APPROVAL') return 'AWAITING_APPROVAL';
  return stage.openedByReturn ? 'RETURNED' : 'IN_PROGRESS';
}

/** Como a ação escolhe a etapa em que age (RN-WF2-18 · V-01..V-03). */
export type TargetResolution<T extends BranchAwareStage> =
  /** Processo sem ramificação e sem `processStageId`: o caminho do MVP 1, inalterado. */
  | { readonly kind: 'TRUNK' }
  | { readonly kind: 'TARGET'; readonly stage: T }
  /** Mais de uma etapa ativa e nenhuma informada (`PROCESS_STAGE_REQUIRED`, 422). */
  | { readonly kind: 'REQUIRED' }
  /** Não é etapa `TASK`/`APPROVAL`… do processo (`PROCESS_STAGE_INVALID`, 422). */
  | { readonly kind: 'INVALID' }
  /** A etapa deixou de estar ativa ou não é a esperada (`STAGE_CHANGED`, 409). */
  | { readonly kind: 'CHANGED' };

/**
 * RN-WF2-18: com MAIS de uma etapa ativa, `processStageId` é obrigatório e deve ser uma passagem
 * `ACTIVE` acionável do processo; com um único ramo restante ele é inferido (FA-01). O
 * `expectedStageId`, se enviado, é comparado com a etapa-alvo; a etapa que deixou de estar ativa é
 * `STAGE_CHANGED` (409, antes do `If-Match`). O split (`currentStageId` na ramificação) nunca é
 * alvo: o leitor do MVP 1 que o envia como `expectedStageId` recebe `STAGE_CHANGED`.
 */
export function resolveTargetStage<T extends BranchAwareStage>(
  process: Pick<Process, 'currentStageId'>,
  stages: readonly T[],
  request: { readonly processStageId?: string | null; readonly expectedStageId?: string | null },
): TargetResolution<T> {
  const branching = activeSplitOf(stages) !== null;
  const requested = request.processStageId ?? null;
  const expected = request.expectedStageId ?? null;
  if (requested === null && !branching) return { kind: 'TRUNK' };
  if (requested !== null) {
    const stage = stages.find((candidate) => candidate.id === requested);
    if (stage === undefined || isControlStageType(stage.stageType)) return { kind: 'INVALID' };
    if (stage.status !== 'ACTIVE') return { kind: 'CHANGED' };
    if (expected !== null && expected !== stage.id) return { kind: 'CHANGED' };
    return { kind: 'TARGET', stage };
  }
  const actives = activeStagesOf(stages);
  if (expected !== null && expected === process.currentStageId) return { kind: 'CHANGED' };
  const [only] = actives;
  if (actives.length === 1 && only !== undefined) {
    if (expected !== null && expected !== only.id) return { kind: 'CHANGED' };
    return { kind: 'TARGET', stage: only };
  }
  return { kind: 'REQUIRED' };
}

/**
 * Visão focada (RN-WF2-17): o processo como se a etapa-alvo fosse a única ativa — `current*` dela,
 * status da etapa (RN-WF2-16) — para a custódia (POL-01 por etapa), o motor de workflow e os planos
 * do MVP 1. Fora da ramificação devolve o próprio processo.
 */
export function focusProcess(process: Process, target: BranchAwareStage): Process {
  if (target.branchKey === null && target.id === process.currentStageId) return process;
  return {
    ...process,
    status: stageStatusOf(process.status, target),
    currentStageId: target.id,
    currentWorkflowStageId: target.workflowStageId,
    currentDepartmentId: target.departmentId,
    currentResponsibleId: target.assigneeId,
    currentStageDueAt: target.dueAt,
  };
}

/** As passagens da visão focada: as OUTRAS ativas (split e demais ramos) ficam de fora. */
export function focusStages<T extends BranchAwareStage>(
  stages: readonly T[],
  target: BranchAwareStage,
): T[] {
  return stages.filter((stage) => stage.status !== 'ACTIVE' || stage.id === target.id);
}

/** Ordem de exibição dos ramos de um split: a das transições de saída (`branchKey` → posição). */
export type BranchOrder = ReadonlyMap<string, number>;

/**
 * RN-WF2-14: desnormalizações do processo em ramificação, a partir das etapas ativas DEPOIS do
 * fato — unidade do primeiro ramo na ordem de exibição, responsável nulo, menor prazo, contagem e
 * status macro. `currentStageId`/`currentWorkflowStageId` (o split) não mudam aqui.
 */
export function parallelProcessFields(
  process: Process,
  actives: readonly BranchAwareStage[],
  order: BranchOrder,
): Pick<
  Process,
  | 'currentDepartmentId'
  | 'currentResponsibleId'
  | 'currentStageDueAt'
  | 'status'
  | 'activeStagesCount'
> {
  const sorted = [...actives].sort(
    (left, right) =>
      (order.get(left.branchKey ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.branchKey ?? '') ?? Number.MAX_SAFE_INTEGER) ||
      left.sequence - right.sequence,
  );
  const dues = actives
    .map((stage) => stage.dueAt)
    .filter((due): due is Date => due !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  return {
    currentDepartmentId: sorted[0]?.departmentId ?? process.currentDepartmentId,
    currentResponsibleId: null,
    currentStageDueAt: dues[0] ?? null,
    status: macroStatus(actives, process.status),
    activeStagesCount: actives.length,
  };
}

/* ── Plano de gravação genérico ─────────────────────────────────────────────────────────────── */

/** Encerramento de uma passagem ativa. */
export interface StageClosure {
  readonly id: string;
  readonly status: 'COMPLETED' | 'RETURNED' | 'CANCELED';
  readonly exitedAt: Date;
  readonly exitedViaMovementId: string | null;
}

/** Uma passagem nova (ativa, ou já encerrada como a da junção — `finishedAt`). */
export interface StageEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly enteredAt: Date;
  readonly dueAt: Date | null;
  readonly slaDays: number | null;
  readonly slaType: DayCountType | null;
  readonly dueDateOverridden: boolean;
  readonly dueDateOverrideReason: string | null;
  readonly enteredViaMovementId: string | null;
  readonly stageType: StageType;
  readonly branchKey: string | null;
  readonly splitProcessStageId: string | null;
  /** Nasce encerrada (`COMPLETED`, `exitedAt = finishedAt`) — junção e etapa `END`. */
  readonly finishedAt: Date | null;
}

/** Mudança de um ramo (chegada ou cancelamento). */
export interface BranchChange {
  readonly id: string;
  readonly status: Exclude<ProcessBranchStatus, 'OPEN'>;
  readonly at: Date;
  readonly cancellationReason: string | null;
}

/**
 * Tudo o que uma operação do runtime grava numa transação (RN-WF2-28): o processo (`WHERE version`
 * como rede), as passagens encerradas (e as responsabilidades ativas delas), as passagens e
 * responsabilidades novas, os ramos novos e alterados e as tramitações (só INSERT), nesta ordem —
 * encerrar antes de abrir respeita os índices únicos parciais (um tronco ativo; uma etapa por ramo).
 */
export interface RuntimeChange {
  readonly process: Process;
  readonly expectedVersion: number;
  readonly completion: ProcessCompletion | null;
  readonly closeStages: readonly StageClosure[];
  readonly insertStages: readonly StageEntry[];
  /** Responsabilidades novas; a de passagem que nasce encerrada é gravada encerrada. */
  readonly insertAssignments: readonly ProcessAssignmentRecord[];
  readonly insertBranches: readonly ProcessBranchRecord[];
  readonly updateBranches: readonly BranchChange[];
  readonly movements: readonly (ProcessMovementRecord & { readonly branchKey: string | null })[];
}

/* ── Invariantes do bloco (teste de invariante e log `process.branch_invariant_violated`) ─────── */

/**
 * RN-WF2-21 · story · Objetivo: depois de QUALQUER operação — no máximo uma passagem ativa no
 * tronco (etapa comum ou o split); no máximo uma ativa por ramo `OPEN` e nenhuma em ramo não
 * `OPEN`; split ativo ⇔ algum ramo `OPEN` na rodada dele; `activeStagesCount` igual às etapas
 * ativas acionáveis; nenhuma etapa de ramo ativa sem split ativo (órfã). Devolve as violações.
 */
export function branchInvariantViolations(
  process: Pick<Process, 'activeStagesCount' | 'status'>,
  stages: readonly BranchAwareStage[],
  branches: readonly Pick<ProcessBranchRecord, 'splitProcessStageId' | 'branchKey' | 'status'>[],
): string[] {
  const violations: string[] = [];
  const active = stages.filter((stage) => stage.status === 'ACTIVE');
  const trunk = active.filter((stage) => stage.branchKey === null);
  if (trunk.length > 1) violations.push('TRUNK_MULTIPLE_ACTIVE');
  const split = activeSplitOf(stages);
  for (const stage of active.filter((candidate) => candidate.branchKey !== null)) {
    if (stage.splitProcessStageId !== split?.id) {
      violations.push(`ORPHAN_BRANCH_STAGE:${stage.id}`);
      continue;
    }
    const branch = branches.find(
      (candidate) =>
        candidate.splitProcessStageId === stage.splitProcessStageId &&
        candidate.branchKey === stage.branchKey,
    );
    if (branch?.status !== 'OPEN') violations.push(`ACTIVE_STAGE_IN_CLOSED_BRANCH:${stage.id}`);
  }
  const perBranch = new Map<string, number>();
  for (const stage of active) {
    if (stage.branchKey === null) continue;
    const key = `${stage.splitProcessStageId ?? ''}:${stage.branchKey}`;
    perBranch.set(key, (perBranch.get(key) ?? 0) + 1);
  }
  for (const [key, count] of perBranch) {
    if (count > 1) violations.push(`BRANCH_MULTIPLE_ACTIVE:${key}`);
  }
  if (split !== null) {
    const open = branches.filter(
      (branch) => branch.splitProcessStageId === split.id && branch.status === 'OPEN',
    );
    if (open.length === 0) violations.push('SPLIT_ACTIVE_WITHOUT_OPEN_BRANCH');
    for (const branch of open) {
      const has = active.some(
        (stage) => stage.splitProcessStageId === split.id && stage.branchKey === branch.branchKey,
      );
      if (!has) violations.push(`OPEN_BRANCH_WITHOUT_STAGE:${branch.branchKey}`);
    }
  } else if (branches.some((branch) => branch.status === 'OPEN')) {
    violations.push('OPEN_BRANCH_WITHOUT_SPLIT');
  }
  const expectedCount = activeStagesOf(stages).length;
  if ((process.activeStagesCount ?? expectedCount) !== expectedCount) {
    violations.push('ACTIVE_STAGES_COUNT_MISMATCH');
  }
  return violations;
}

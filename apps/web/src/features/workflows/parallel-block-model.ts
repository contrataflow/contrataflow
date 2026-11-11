import type {
  StageType,
  TransitionAction,
  WorkflowParallelBlockDto,
  WorkflowStageCreate,
  WorkflowStageDto,
  WorkflowTransitionDto,
} from '@contrataflow/validation';

import { EMPTY_STAGE, keyFromName, stageCreateBody, uniqueKey } from './workflow-editor-model';

/*
 * Modelo puro do bloco paralelo no editor (US-123 · SCR-034): o assistente "Adicionar ramificação"
 * (`ParallelBlockWizard`) vira uma sequência de escritas WF-10/WF-13 — ramificação, junção, a
 * primeira etapa de cada ramo e as transições origem → ramificação → ramos → junção → destino — e
 * "Remover ramificação" lista o que sai (transições do bloco e etapas dos ramos).
 */

export interface BranchDraft {
  readonly name: string;
}

export interface ParallelBlockDraft {
  /** Nome do bloco ("Análises"): vira "Ramificação — Análises" / "Junção — Análises". */
  readonly name: string;
  /** Etapa de onde o fluxo sai (`START`/`TASK`). */
  readonly originStageId: string;
  /** Etapa que segue a junção (`TASK`/`APPROVAL`). */
  readonly destinationStageId: string;
  readonly branches: readonly BranchDraft[];
}

export const EMPTY_BLOCK: ParallelBlockDraft = {
  name: '',
  originStageId: '',
  destinationStageId: '',
  branches: [{ name: '' }, { name: '' }],
};

export type BlockField = 'name' | 'originStageId' | 'destinationStageId' | `branches.${string}`;

export interface BlockProblem {
  readonly field: BlockField;
  readonly code: 'REQUIRED' | 'NAME_LENGTH' | 'DUPLICATED' | 'BRANCHES_MIN';
}

/** Etapas que podem abrir o bloco (RN-WF2-05: `FORWARD` de `START`/`TASK` para a ramificação). */
export function originCandidates(stages: readonly WorkflowStageDto[]): WorkflowStageDto[] {
  return stages.filter((stage) => stage.type === 'START' || stage.type === 'TASK');
}

/** Etapas que podem seguir a junção (saída única para `TASK`/`APPROVAL`). */
export function destinationCandidates(stages: readonly WorkflowStageDto[]): WorkflowStageDto[] {
  return stages.filter((stage) => stage.type === 'TASK' || stage.type === 'APPROVAL');
}

const nameProblem = (name: string): BlockProblem['code'] | null => {
  const trimmed = name.trim();
  if (trimmed === '') return 'REQUIRED';
  return trimmed.length < 3 || trimmed.length > 120 ? 'NAME_LENGTH' : null;
};

/** Validação local do assistente (o grafo inteiro é da validação WF-20). */
export function blockDraftProblems(draft: ParallelBlockDraft): BlockProblem[] {
  const problems: BlockProblem[] = [];
  const name = nameProblem(draft.name);
  if (name) problems.push({ field: 'name', code: name });
  if (draft.originStageId === '') problems.push({ field: 'originStageId', code: 'REQUIRED' });
  if (draft.destinationStageId === '') {
    problems.push({ field: 'destinationStageId', code: 'REQUIRED' });
  }
  if (draft.branches.length < 2) problems.push({ field: 'branches.0', code: 'BRANCHES_MIN' });
  const seen = new Set<string>();
  draft.branches.forEach((branch, index) => {
    const problem = nameProblem(branch.name);
    if (problem) {
      problems.push({ field: `branches.${String(index)}`, code: problem });
      return;
    }
    const key = keyFromName(branch.name);
    if (seen.has(key)) problems.push({ field: `branches.${String(index)}`, code: 'DUPLICATED' });
    seen.add(key);
  });
  return problems;
}

export interface PlannedTransition {
  readonly key: string;
  readonly name: string;
  /** `key` da etapa (as etapas novas só têm id depois de criadas). */
  readonly fromKey: string;
  readonly toKey: string;
  readonly action: TransitionAction;
}

export interface BlockPlan {
  readonly stages: readonly WorkflowStageCreate[];
  readonly transitions: readonly PlannedTransition[];
}

/**
 * Passo 2 do fluxo principal: as escritas do bloco, em ordem. Chaves novas derivadas dos nomes e
 * únicas na versão (`uniqueKey`); a ordem de exibição continua a da versão.
 */
export function parallelBlockPlan(
  draft: ParallelBlockDraft,
  stages: readonly WorkflowStageDto[],
  transitionKeys: ReadonlySet<string>,
): BlockPlan {
  const used = new Set(stages.map((stage) => stage.key));
  const take = (base: string) => {
    const key = uniqueKey(base, used);
    used.add(key);
    return key;
  };
  const block = draft.name.trim();
  const blockKey = keyFromName(block);
  const origin = stages.find((stage) => stage.id === draft.originStageId);
  const destination = stages.find((stage) => stage.id === draft.destinationStageId);
  const order = stages.reduce((max, stage) => Math.max(max, stage.displayOrder + 1), 0);
  const splitKey = take(`RAMIFICACAO_${blockKey}`.slice(0, 60));
  const joinKey = take(`JUNCAO_${blockKey}`.slice(0, 60));
  const branchKeys = draft.branches.map((branch) => take(keyFromName(branch.name)));

  const stage = (key: string, name: string, type: StageType, displayOrder: number) =>
    stageCreateBody({ ...EMPTY_STAGE, key, name: name.slice(0, 150), type }, displayOrder);
  const created: WorkflowStageCreate[] = [
    stage(splitKey, `Ramificação — ${block}`, 'PARALLEL_SPLIT', order),
    ...draft.branches.map((branch, index) =>
      stage(branchKeys[index] ?? '', branch.name.trim(), 'TASK', order + 1 + index),
    ),
    stage(joinKey, `Junção — ${block}`, 'PARALLEL_JOIN', order + 1 + draft.branches.length),
  ];

  const usedTransitions = new Set(transitionKeys);
  const transition = (fromKey: string, toKey: string, name: string): PlannedTransition => {
    const key = uniqueKey(`${fromKey}_${toKey}`.slice(0, 60), usedTransitions);
    usedTransitions.add(key);
    return { key, name: name.slice(0, 150), fromKey, toKey, action: 'FORWARD' };
  };
  const transitions: PlannedTransition[] = [];
  if (origin) transitions.push(transition(origin.key, splitKey, `Ramificar — ${block}`));
  draft.branches.forEach((branch, index) => {
    const key = branchKeys[index] ?? '';
    transitions.push(transition(splitKey, key, `Abrir ramo ${branch.name.trim()}`));
  });
  draft.branches.forEach((branch, index) => {
    const key = branchKeys[index] ?? '';
    transitions.push(transition(key, joinKey, `Concluir ramo ${branch.name.trim()}`));
  });
  if (destination) transitions.push(transition(joinKey, destination.key, `Juntar — ${block}`));
  return { stages: created, transitions };
}

export interface BlockRemoval {
  readonly transitions: readonly WorkflowTransitionDto[];
  readonly stages: readonly WorkflowStageDto[];
}

/**
 * FA-04 ("Remover ramificação"): as transições que tocam a ramificação, a junção ou as etapas dos
 * ramos (removidas primeiro — RN-WF-50) e as etapas do bloco (ramos, ramificação e junção).
 */
export function blockRemovalPlan(
  block: WorkflowParallelBlockDto,
  stages: readonly WorkflowStageDto[],
  transitions: readonly WorkflowTransitionDto[],
): BlockRemoval {
  const keys = new Set([
    block.splitStageKey,
    ...(block.joinStageKey ? [block.joinStageKey] : []),
    ...block.branches.flatMap((branch) => branch.stageKeys),
  ]);
  const removed = stages.filter((stage) => keys.has(stage.key));
  const ids = new Set(removed.map((stage) => stage.id));
  return {
    transitions: transitions.filter(
      (transition) => ids.has(transition.fromStageId) || ids.has(transition.toStageId),
    ),
    stages: removed,
  };
}

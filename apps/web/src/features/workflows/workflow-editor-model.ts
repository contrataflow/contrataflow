import {
  ADVANCE_ACTIONS,
  COLOR_PATTERN,
  WORKFLOW_ITEM_KEY_PATTERN,
  WORKFLOW_KEY_PATTERN,
  workflowStageIssues,
} from '@contrataflow/validation';
import type {
  StageAssignmentPolicy,
  StageDepartmentResolution,
  StageType,
  Violation,
  WorkflowStageCreate,
  WorkflowStageDto,
  WorkflowStageFields,
  WorkflowStageUpdate,
  WorkflowTransitionCreate,
  WorkflowTransitionDto,
  WorkflowTransitionUpdate,
} from '@contrataflow/validation';

/*
 * Modelo puro do editor de workflow (US-043 · SCR-034): rascunho de formulário da etapa e da
 * transição, validação local (a mesma dos condicionais da API — RN-WF-48/49), o PATCH só com o que
 * mudou, a reordenação contígua (RN-WF-52 · FA-04) e os avisos incrementais do grafo (passo 7 —
 * não bloqueiam salvar; a validação completa é da publicação, US-045).
 */

export type ApproverType = NonNullable<WorkflowStageFields['approverType']>;
export type ApproverDepartmentResolution = NonNullable<
  WorkflowStageFields['approverDepartmentResolution']
>;
export type DayCountType = WorkflowStageFields['slaType'];

/** Ações oferecidas no editor: `APPROVE`/`REJECT` são automáticas das etapas `APPROVAL`. */
export const EDITOR_TRANSITION_ACTIONS = ['FORWARD', 'RETURN', 'COMPLETE'] as const;
export type EditorTransitionAction = (typeof EDITOR_TRANSITION_ACTIONS)[number];

/** Paleta nomeada da etapa (o seletor mostra o nome, não só a amostra). */
export const STAGE_COLORS = [
  { key: 'blue', value: '#2563EB' },
  { key: 'green', value: '#16A34A' },
  { key: 'yellow', value: '#CA8A04' },
  { key: 'orange', value: '#EA580C' },
  { key: 'red', value: '#DC2626' },
  { key: 'purple', value: '#7C3AED' },
  { key: 'cyan', value: '#0891B2' },
  { key: 'gray', value: '#4B5563' },
] as const;

export interface StageDraft {
  readonly key: string;
  readonly name: string;
  readonly instructions: string;
  readonly type: StageType;
  readonly departmentResolution: StageDepartmentResolution;
  readonly fixedDepartmentId: string;
  readonly assignmentPolicy: StageAssignmentPolicy;
  readonly approverType: ApproverType | '';
  readonly approverUserId: string;
  readonly approverRoleId: string;
  readonly approverDepartmentResolution: ApproverDepartmentResolution | '';
  readonly approverFixedDepartmentId: string;
  readonly allowDeputy: boolean;
  readonly approvalDocumentTypeCodes: readonly string[];
  readonly documentTypeCodes: readonly string[];
  readonly slaDays: string;
  readonly slaType: DayCountType;
  readonly color: string;
}

/** Padrões de entities.md §4.5 (tipo `TASK`, unidade do requisitante, sem responsável). */
export const EMPTY_STAGE: StageDraft = {
  key: '',
  name: '',
  instructions: '',
  type: 'TASK',
  departmentResolution: 'REQUESTING_DEPARTMENT',
  fixedDepartmentId: '',
  assignmentPolicy: 'UNASSIGNED',
  approverType: '',
  approverUserId: '',
  approverRoleId: '',
  approverDepartmentResolution: '',
  approverFixedDepartmentId: '',
  allowDeputy: true,
  approvalDocumentTypeCodes: [],
  documentTypeCodes: [],
  slaDays: '',
  slaType: 'BUSINESS',
  color: '',
};

export function stageDraftOf(stage: WorkflowStageDto): StageDraft {
  return {
    key: stage.key,
    name: stage.name,
    instructions: stage.instructions ?? '',
    type: stage.type,
    departmentResolution: stage.departmentResolution,
    fixedDepartmentId: stage.fixedDepartmentId ?? '',
    assignmentPolicy: stage.assignmentPolicy,
    approverType: stage.approverType ?? '',
    approverUserId: stage.approverUserId ?? '',
    approverRoleId: stage.approverRoleId ?? '',
    approverDepartmentResolution: stage.approverDepartmentResolution ?? '',
    approverFixedDepartmentId: stage.approverFixedDepartmentId ?? '',
    allowDeputy: stage.allowDeputy,
    approvalDocumentTypeCodes: stage.approvalDocumentTypeCodes,
    documentTypeCodes: stage.documentTypeCodes,
    slaDays: stage.slaDays === null ? '' : String(stage.slaDays),
    slaType: stage.slaType,
    color: stage.color ?? '',
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * Normaliza o rascunho ao que a API grava: campos de aprovador só em `APPROVAL`, unidade fixa só em
 * `FIXED`, unidade do titular aprovador só com resolução `FIXED`, sem prazo na etapa final.
 */
export function stageFieldsOf(draft: StageDraft, displayOrder: number): WorkflowStageFields {
  const approval = draft.type === 'APPROVAL';
  const approverType = approval && draft.approverType !== '' ? draft.approverType : null;
  const headResolution =
    approverType === 'DEPARTMENT_HEAD' && draft.approverDepartmentResolution !== ''
      ? draft.approverDepartmentResolution
      : null;
  const slaDays =
    draft.type === 'END' || draft.slaDays.trim() === '' ? null : Number(draft.slaDays);
  return {
    key: draft.key.trim(),
    name: draft.name.trim(),
    instructions: orNull(draft.instructions),
    type: draft.type,
    groupLabel: null,
    displayOrder,
    departmentResolution: draft.departmentResolution,
    fixedDepartmentId:
      draft.departmentResolution === 'FIXED' ? orNull(draft.fixedDepartmentId) : null,
    assignmentPolicy: draft.assignmentPolicy,
    approverType,
    approverUserId: approverType === 'USER' ? orNull(draft.approverUserId) : null,
    approverRoleId: approverType === 'ROLE' ? orNull(draft.approverRoleId) : null,
    approverDepartmentResolution: headResolution,
    approverFixedDepartmentId:
      headResolution === 'FIXED' ? orNull(draft.approverFixedDepartmentId) : null,
    allowDeputy: draft.allowDeputy,
    approvalDocumentTypeCodes: approval ? draft.approvalDocumentTypeCodes : [],
    documentTypeCodes: draft.documentTypeCodes,
    slaDays,
    slaType: draft.slaType,
    color: orNull(draft.color),
  };
}

/** Problema local de um campo: `code` traduzido pela tela ou `message` já pronta (condicionais). */
export interface FieldProblem {
  readonly field: string;
  readonly code: 'REQUIRED' | 'KEY_PATTERN' | 'NAME_LENGTH' | 'SLA_RANGE' | 'TOO_LONG' | 'SHARED';
  readonly message?: string;
}

function nameProblems(name: string): FieldProblem[] {
  const trimmed = name.trim();
  if (trimmed === '') return [{ field: 'name', code: 'REQUIRED' }];
  if (trimmed.length < 3 || trimmed.length > 150) return [{ field: 'name', code: 'NAME_LENGTH' }];
  return [];
}

function keyProblems(key: string, pattern: RegExp): FieldProblem[] {
  if (key.trim() === '') return [{ field: 'key', code: 'REQUIRED' }];
  return pattern.test(key.trim()) ? [] : [{ field: 'key', code: 'KEY_PATTERN' }];
}

/** V-01..V-04 no front: os mesmos condicionais da API (`workflowStageIssues`), um por campo. */
export function stageDraftProblems(draft: StageDraft): FieldProblem[] {
  const problems: FieldProblem[] = [
    ...keyProblems(draft.key, WORKFLOW_ITEM_KEY_PATTERN),
    ...nameProblems(draft.name),
  ];
  if (draft.instructions.length > 5000) problems.push({ field: 'instructions', code: 'TOO_LONG' });
  if (draft.type !== 'END' && draft.slaDays.trim() !== '') {
    const days = Number(draft.slaDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      problems.push({ field: 'slaDays', code: 'SLA_RANGE' });
    }
  }
  const color = draft.color.trim();
  if (color !== '' && !COLOR_PATTERN.test(color)) {
    problems.push({ field: 'color', code: 'SHARED', message: 'Use o formato #RRGGBB.' });
  }
  for (const issue of workflowStageIssues(stageFieldsOf(draft, 0))) {
    problems.push({ field: issue.field, code: 'SHARED', message: issue.message });
  }
  const seen = new Set<string>();
  return problems.filter((problem) => {
    if (seen.has(problem.field)) return false;
    seen.add(problem.field);
    return true;
  });
}

/** Corpo do WF-10 a partir do rascunho (a etapa nova entra ao final — passo 4). */
export function stageCreateBody(draft: StageDraft, displayOrder: number): WorkflowStageCreate {
  const { groupLabel: _groupLabel, ...fields } = stageFieldsOf(draft, displayOrder);
  return {
    ...fields,
    approvalDocumentTypeCodes: [...fields.approvalDocumentTypeCodes],
    documentTypeCodes: [...fields.documentTypeCodes],
  };
}

const STAGE_PATCH_FIELDS = [
  'name',
  'instructions',
  'type',
  'departmentResolution',
  'fixedDepartmentId',
  'assignmentPolicy',
  'approverType',
  'approverUserId',
  'approverRoleId',
  'approverDepartmentResolution',
  'approverFixedDepartmentId',
  'allowDeputy',
  'approvalDocumentTypeCodes',
  'documentTypeCodes',
  'slaDays',
  'slaType',
  'color',
] as const satisfies readonly (keyof WorkflowStageUpdate & keyof WorkflowStageFields)[];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** WF-11 só com os campos alterados (a `key` é imutável — RN-WF-45); vazio = nada a salvar. */
export function stagePatch(stage: WorkflowStageDto, draft: StageDraft): WorkflowStageUpdate {
  const next = stageFieldsOf(draft, stage.displayOrder);
  const patch: Record<string, unknown> = {};
  for (const field of STAGE_PATCH_FIELDS) {
    if (!same(stage[field], next[field])) patch[field] = next[field];
  }
  return patch;
}

/** Chave técnica sugerida a partir do nome (`SCREAMING_SNAKE_CASE`, sem acentos, ≤ 60). */
export function keyFromName(name: string): string {
  const key = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '')
    .slice(0, 60)
    .replace(/_+$/, '');
  return key;
}

/** Chave sugerida ainda livre na versão (sufixo `_2`, `_3`… quando já usada). */
export function uniqueKey(base: string, used: ReadonlySet<string>): string {
  if (base === '' || !used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `_${String(index)}`;
    const candidate = `${base.slice(0, 60 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function workflowKeyProblems(key: string): FieldProblem[] {
  return keyProblems(key, WORKFLOW_KEY_PATTERN);
}

export function workflowNameProblems(name: string): FieldProblem[] {
  return nameProblems(name);
}

/** Etapas na ordem de exibição (empate pela chave, para estabilidade). */
export function sortStages<T extends Pick<WorkflowStageDto, 'displayOrder' | 'key'>>(
  stages: readonly T[],
): T[] {
  return [...stages].sort((a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key));
}

/**
 * FA-04 · RN-WF-52: move a etapa de `from` para `to` e devolve um PATCH por etapa cuja posição
 * mudou, mantendo a sequência contígua (0, 1, 2…). Posição inválida → nenhuma alteração.
 */
export function reorderPatches<T extends Pick<WorkflowStageDto, 'id' | 'displayOrder' | 'key'>>(
  stages: readonly T[],
  from: number,
  to: number,
): { readonly stage: T; readonly displayOrder: number }[] {
  const ordered = sortStages(stages);
  if (from === to || from < 0 || to < 0 || from >= ordered.length || to >= ordered.length) {
    return [];
  }
  const [moved] = ordered.splice(from, 1);
  if (!moved) return [];
  ordered.splice(to, 0, moved);
  return ordered.flatMap((stage, index) =>
    stage.displayOrder === index ? [] : [{ stage, displayOrder: index }],
  );
}

export type GraphWarning =
  | { readonly kind: 'NO_START' }
  | { readonly kind: 'NO_EXIT'; readonly stageId: string }
  | { readonly kind: 'UNREACHABLE'; readonly stageId: string };

/**
 * Passo 7: avisos incrementais (não bloqueiam salvar o rascunho) — sem etapa `START`, etapa (exceto
 * `END`) sem transição de saída e etapa inalcançável a partir do `START` pelas ações de avanço.
 */
export function graphWarnings(
  stages: readonly Pick<WorkflowStageDto, 'id' | 'type' | 'displayOrder' | 'key'>[],
  transitions: readonly Pick<WorkflowTransitionDto, 'fromStageId' | 'toStageId' | 'action'>[],
): GraphWarning[] {
  if (stages.length === 0) return [];
  const ordered = sortStages(stages);
  const warnings: GraphWarning[] = [];
  const start = ordered.find((stage) => stage.type === 'START');
  if (!start) warnings.push({ kind: 'NO_START' });
  for (const stage of ordered) {
    if (stage.type === 'END') continue;
    if (!transitions.some((transition) => transition.fromStageId === stage.id)) {
      warnings.push({ kind: 'NO_EXIT', stageId: stage.id });
    }
  }
  if (start) {
    const reached = new Set([start.id]);
    const queue = [start.id];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
      for (const transition of transitions) {
        if (transition.fromStageId !== current || !ADVANCE_ACTIONS.includes(transition.action)) {
          continue;
        }
        if (!reached.has(transition.toStageId)) {
          reached.add(transition.toStageId);
          queue.push(transition.toStageId);
        }
      }
    }
    for (const stage of ordered) {
      if (!reached.has(stage.id)) warnings.push({ kind: 'UNREACHABLE', stageId: stage.id });
    }
  }
  return warnings;
}

export interface TransitionDraft {
  readonly key: string;
  readonly name: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly action: EditorTransitionAction;
  readonly isPrimary: boolean;
  readonly requiresComment: boolean;
  readonly allowDueDateOverride: boolean;
}

export const EMPTY_TRANSITION: TransitionDraft = {
  key: '',
  name: '',
  fromStageId: '',
  toStageId: '',
  action: 'FORWARD',
  isPrimary: false,
  requiresComment: false,
  allowDueDateOverride: true,
};

export function isEditorAction(action: string): action is EditorTransitionAction {
  return (EDITOR_TRANSITION_ACTIONS as readonly string[]).includes(action);
}

export function transitionDraftOf(transition: WorkflowTransitionDto): TransitionDraft {
  return {
    key: transition.key,
    name: transition.name,
    fromStageId: transition.fromStageId,
    toStageId: transition.toStageId,
    action: isEditorAction(transition.action) ? transition.action : 'FORWARD',
    isPrimary: transition.isPrimary,
    requiresComment: transition.requiresComment,
    allowDueDateOverride: transition.allowDueDateOverride,
  };
}

/** `RETURN` exige comentário (forçado também pela API — RN-WF-09). */
export function withForcedComment(draft: TransitionDraft): TransitionDraft {
  return draft.action === 'RETURN' ? { ...draft, requiresComment: true } : draft;
}

/** V-01/V-05 no front: obrigatórios e origem diferente do destino (RN-WF-49). */
export function transitionDraftProblems(draft: TransitionDraft): FieldProblem[] {
  const problems: FieldProblem[] = [
    ...keyProblems(draft.key, WORKFLOW_ITEM_KEY_PATTERN),
    ...nameProblems(draft.name),
  ];
  if (draft.fromStageId === '') problems.push({ field: 'fromStageId', code: 'REQUIRED' });
  if (draft.toStageId === '') problems.push({ field: 'toStageId', code: 'REQUIRED' });
  if (draft.fromStageId !== '' && draft.fromStageId === draft.toStageId) {
    problems.push({
      field: 'toStageId',
      code: 'SHARED',
      message: 'A etapa de origem deve ser diferente da etapa de destino.',
    });
  }
  return problems;
}

export function transitionCreateBody(
  draft: TransitionDraft,
  displayOrder: number,
): WorkflowTransitionCreate {
  const forced = withForcedComment(draft);
  return {
    key: forced.key.trim(),
    name: forced.name.trim(),
    fromStageId: forced.fromStageId,
    toStageId: forced.toStageId,
    action: forced.action,
    displayOrder,
    isPrimary: forced.isPrimary,
    requiresComment: forced.requiresComment,
    allowDueDateOverride: forced.allowDueDateOverride,
  };
}

/** WF-14 só com o que mudou (a `key` é imutável). */
export function transitionPatch(
  transition: WorkflowTransitionDto,
  draft: TransitionDraft,
): WorkflowTransitionUpdate {
  const forced = withForcedComment(draft);
  const next = {
    name: forced.name.trim(),
    fromStageId: forced.fromStageId,
    toStageId: forced.toStageId,
    action: forced.action,
    isPrimary: forced.isPrimary,
    requiresComment: forced.requiresComment,
    allowDueDateOverride: forced.allowDueDateOverride,
  };
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(next)) {
    if (!same(transition[field as keyof typeof next], value)) patch[field] = value;
  }
  return patch;
}

/** FA-01: itens que impedem a exclusão, lidos das `violations[]` do 422 (RN-WF-50). */
export function deleteBlockersOf(
  violations: readonly Violation[],
): { readonly id: string; readonly kind: 'TRANSITION' | 'RULE'; readonly name: string }[] {
  return violations.flatMap((violation) => {
    const kind = violation.params.kind;
    const name = violation.params.name;
    if ((kind !== 'TRANSITION' && kind !== 'RULE') || typeof name !== 'string') return [];
    return [{ id: violation.itemId ?? name, kind, name }];
  });
}

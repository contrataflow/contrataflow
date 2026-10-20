import type {
  RuleContextFieldType,
  RuleContextSchemaDto,
  RuleScope,
  RuleSeverity,
  RuleType,
  WorkflowRuleCreate,
  WorkflowRuleDto,
  WorkflowRuleUpdate,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';

import { sortStages } from './workflow-editor-model';

/*
 * Regras de etapa e de transição (US-044 · SCR-035), em funções puras: os alvos de regra da versão
 * (saída de etapa e transições de avanço), o rascunho do formulário por tipo, o `ConditionBuilder`
 * (combinador E/OU + linhas campo/operador/valor) ↔ JSON Logic, os corpos de WF-16/WF-17/WF-23 e a
 * reordenação (FA-01: um PATCH por regra que mudou de posição). A API revalida tudo (RN-WF-53..58).
 */

export const RULE_TYPE_OPTIONS = [
  'REQUIRED_DOCUMENT',
  'REQUIRED_FIELD',
  'REQUIRED_APPROVAL',
  'CONDITION',
] as const satisfies readonly RuleType[];

export const MIN_STATUS_OPTIONS = ['EXISTS', 'COMPLETE', 'SUBMITTED', 'FINAL', 'APPROVED'] as const;
export type MinStatus = (typeof MIN_STATUS_OPTIONS)[number];

/** Ações de transição que aceitam regra (RN-WF-17). */
const RULE_TRANSITION_ACTIONS: ReadonlySet<string> = new Set(['FORWARD', 'COMPLETE', 'APPROVE']);

export const RULE_NAME_MAX = 150;
export const RULE_MESSAGE_MAX = 500;

/** Problema local de um campo (traduzido pela tela). `condition.N` = linha N do construtor. */
export interface RuleFieldProblem {
  readonly field: string;
  readonly code: 'REQUIRED' | 'NAME_LENGTH' | 'MESSAGE_LENGTH' | 'INVALID';
}

// ---------------------------------------------------------------------------------------------
// Alvos (âmbito — RN-WF-53)
// ---------------------------------------------------------------------------------------------

export interface RuleTarget {
  readonly scope: RuleScope;
  readonly id: string;
  readonly name: string;
}

/** Saída das etapas (exceto `END`) e transições de avanço, na ordem do editor. */
export function ruleTargets(
  version: Pick<WorkflowVersionDetailDto, 'stages' | 'transitions'>,
): RuleTarget[] {
  const stages = sortStages(version.stages)
    .filter((stage) => stage.type !== 'END')
    .map((stage): RuleTarget => ({ scope: 'STAGE_EXIT', id: stage.id, name: stage.name }));
  const transitions = [...version.transitions]
    .filter((transition) => RULE_TRANSITION_ACTIONS.has(transition.action))
    .sort((a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key))
    .map((transition): RuleTarget => ({
      scope: 'TRANSITION',
      id: transition.id,
      name: transition.name,
    }));
  return [...stages, ...transitions];
}

export function sameTarget(rule: WorkflowRuleDto, target: RuleTarget): boolean {
  return target.scope === 'STAGE_EXIT'
    ? rule.scope === 'STAGE_EXIT' && rule.stageId === target.id
    : rule.scope === 'TRANSITION' && rule.transitionId === target.id;
}

/** Regras do alvo por `displayOrder` (depois nome). */
export function rulesOf(rules: readonly WorkflowRuleDto[], target: RuleTarget): WorkflowRuleDto[] {
  return rules
    .filter((rule) => sameTarget(rule, target))
    .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
}

/** Quantas regras cada alvo tem (rótulo da lista de alvos). */
export function ruleCountOf(rules: readonly WorkflowRuleDto[], target: RuleTarget): number {
  return rules.filter((rule) => sameTarget(rule, target)).length;
}

/** FA-01: a lista do alvo depois de mover `from` → `to`; um PATCH por regra que mudou. */
export function ruleReorderPatches(
  ordered: readonly WorkflowRuleDto[],
  from: number,
  to: number,
): { readonly rule: WorkflowRuleDto; readonly displayOrder: number }[] {
  if (from === to || from < 0 || to < 0 || from >= ordered.length || to >= ordered.length) {
    return [];
  }
  const next = [...ordered];
  const [moved] = next.splice(from, 1);
  if (!moved) return [];
  next.splice(to, 0, moved);
  return next.flatMap((rule, index) =>
    rule.displayOrder === index ? [] : [{ rule, displayOrder: index }],
  );
}

/** Etapas `APPROVAL` da versão (opções de `REQUIRED_APPROVAL.stageKey` — RN-WF-57). */
export function approvalStagesOf(stages: readonly WorkflowStageDto[]): WorkflowStageDto[] {
  return sortStages(stages).filter((stage) => stage.type === 'APPROVAL');
}

export function transitionNameOf(
  transitions: readonly WorkflowTransitionDto[],
  id: string | null,
): string {
  return transitions.find((transition) => transition.id === id)?.name ?? '';
}

// ---------------------------------------------------------------------------------------------
// ConditionBuilder ↔ JSON Logic (RN-WF-58)
// ---------------------------------------------------------------------------------------------

export const CONDITION_OPERATORS = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'filled',
  'empty',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

const COMPARISON: readonly ConditionOperator[] = ['==', '!=', '>', '>=', '<', '<='];
const PRESENCE: readonly ConditionOperator[] = ['filled', 'empty'];

/** Operadores oferecidos por tipo de campo. */
export function operatorsFor(type: RuleContextFieldType): readonly ConditionOperator[] {
  switch (type) {
    case 'number':
    case 'date':
      return [...COMPARISON, ...PRESENCE];
    case 'boolean':
      return ['==', '!='];
    case 'list':
      return ['contains', ...PRESENCE];
    default:
      return ['==', '!=', ...PRESENCE];
  }
}

/** O operador não usa valor. */
export function isUnary(operator: ConditionOperator): boolean {
  return operator === 'filled' || operator === 'empty';
}

export type Combinator = 'and' | 'or';

export interface ConditionRow {
  readonly path: string;
  readonly operator: ConditionOperator;
  /** Texto do campo de valor (`'true'`/`'false'` para booleanos). */
  readonly value: string;
}

export interface ConditionTree {
  readonly combinator: Combinator;
  readonly rows: readonly ConditionRow[];
}

export const EMPTY_CONDITION: ConditionTree = { combinator: 'and', rows: [] };

type FieldTypes = ReadonlyMap<string, RuleContextFieldType>;

export function fieldTypesOf(schema: RuleContextSchemaDto | null | undefined): FieldTypes {
  return new Map((schema?.fields ?? []).map((field) => [field.path, field.type]));
}

/** Linha nova: o primeiro campo do schema com o primeiro operador do tipo. */
export function newConditionRow(schema: RuleContextSchemaDto): ConditionRow {
  const first = schema.fields[0];
  const type = first?.type ?? 'string';
  return {
    path: first?.path ?? '',
    operator: operatorsFor(type)[0] ?? '==',
    value: type === 'boolean' ? 'true' : '',
  };
}

/** Troca o campo da linha mantendo o operador quando o novo tipo o aceita. */
export function withRowPath(
  row: ConditionRow,
  path: string,
  type: RuleContextFieldType,
): ConditionRow {
  const operators = operatorsFor(type);
  return {
    path,
    operator: operators.includes(row.operator) ? row.operator : (operators[0] ?? '=='),
    value: type === 'boolean' ? 'true' : row.value,
  };
}

function rowValue(row: ConditionRow, type: RuleContextFieldType): unknown {
  if (type === 'boolean') return row.value === 'true';
  if (type === 'number') return Number(row.value.replace(',', '.'));
  return row.value.trim();
}

function rowLogic(row: ConditionRow, type: RuleContextFieldType): Record<string, unknown> {
  const variable = { var: row.path };
  switch (row.operator) {
    case 'filled':
      return { '!!': [variable] };
    case 'empty':
      return { '!': [variable] };
    case 'contains':
      return { in: [rowValue(row, type), variable] };
    default:
      return { [row.operator]: [variable, rowValue(row, type)] };
  }
}

/** Problemas da condição (por linha) antes de gerar o JSON Logic. */
export function conditionProblems(tree: ConditionTree, types: FieldTypes): RuleFieldProblem[] {
  if (tree.rows.length === 0) return [{ field: 'config.expression', code: 'REQUIRED' }];
  const problems: RuleFieldProblem[] = [];
  tree.rows.forEach((row, index) => {
    const type = types.get(row.path);
    if (type === undefined) {
      problems.push({ field: `condition.${String(index)}`, code: 'INVALID' });
    } else if (!isUnary(row.operator) && row.value.trim() === '') {
      problems.push({ field: `condition.${String(index)}`, code: 'REQUIRED' });
    } else if (type === 'number' && !Number.isFinite(rowValue(row, type))) {
      problems.push({ field: `condition.${String(index)}`, code: 'INVALID' });
    }
  });
  return problems;
}

/** `{ and|or: [linhas] }` — sempre com o combinador, para a volta (`conditionOf`) ser estável. */
export function conditionToJsonLogic(tree: ConditionTree, types: FieldTypes): unknown {
  return {
    [tree.combinator]: tree.rows.map((row) => rowLogic(row, types.get(row.path) ?? 'string')),
  };
}

const VALUE_OPERATORS: ReadonlySet<string> = new Set(COMPARISON);

function variableOf(node: unknown): string | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const entries: [string, unknown][] = Object.entries(node);
  const [operation, path] = entries[0] ?? [];
  if (entries.length !== 1 || operation !== 'var') return null;
  return typeof path === 'string' ? path : null;
}

function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function rowOf(node: unknown): ConditionRow | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const entries = Object.entries(node);
  const [operation, rawArgs] = entries[0] ?? [];
  if (entries.length !== 1 || operation === undefined || !Array.isArray(rawArgs)) return null;
  const args = rawArgs as unknown[];
  if ((operation === '!!' || operation === '!') && args.length === 1) {
    const path = variableOf(args[0]);
    return path === null
      ? null
      : { path, operator: operation === '!!' ? 'filled' : 'empty', value: '' };
  }
  if (operation === 'in' && args.length === 2) {
    const path = variableOf(args[1]);
    const value = valueText(args[0]);
    return path === null || value === null ? null : { path, operator: 'contains', value };
  }
  if (VALUE_OPERATORS.has(operation) && args.length === 2) {
    const path = variableOf(args[0]);
    const value = valueText(args[1]);
    return path === null || value === null
      ? null
      : { path, operator: operation as ConditionOperator, value };
  }
  return null;
}

/** JSON Logic → árvore do construtor; `null` = expressão que o construtor não representa. */
export function conditionOf(expression: unknown): ConditionTree | null {
  if (expression === null || typeof expression !== 'object' || Array.isArray(expression)) {
    return null;
  }
  const entries = Object.entries(expression);
  const [combinator, rawRows] = entries[0] ?? [];
  if (entries.length !== 1 || (combinator !== 'and' && combinator !== 'or')) {
    const single = rowOf(expression);
    return single === null ? null : { combinator: 'and', rows: [single] };
  }
  if (!Array.isArray(rawRows)) return null;
  const rows = (rawRows as unknown[]).map(rowOf);
  return rows.every((row): row is ConditionRow => row !== null) ? { combinator, rows } : null;
}

// ---------------------------------------------------------------------------------------------
// Rascunho do formulário
// ---------------------------------------------------------------------------------------------

export interface RuleDraft {
  readonly type: RuleType;
  readonly name: string;
  readonly description: string;
  readonly severity: RuleSeverity;
  readonly message: string;
  readonly isActive: boolean;
  readonly documentTypeCode: string;
  readonly minStatus: MinStatus;
  /** Texto do campo (vazio = 1). */
  readonly minCount: string;
  readonly field: string;
  readonly stageKey: string;
  readonly condition: ConditionTree;
  /** `json`: a expressão é editada como texto (avançado ou não representável no construtor). */
  readonly conditionMode: 'builder' | 'json';
  readonly conditionJson: string;
}

export const EMPTY_RULE: RuleDraft = {
  type: 'REQUIRED_DOCUMENT',
  name: '',
  description: '',
  severity: 'BLOCKING',
  message: '',
  isActive: true,
  documentTypeCode: '',
  minStatus: 'COMPLETE',
  minCount: '',
  field: '',
  stageKey: '',
  condition: EMPTY_CONDITION,
  conditionMode: 'builder',
  conditionJson: '',
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function ruleDraftOf(rule: WorkflowRuleDto): RuleDraft {
  const { config } = rule;
  const condition = rule.type === 'CONDITION' ? conditionOf(config.expression) : null;
  const minStatus = MIN_STATUS_OPTIONS.find((status) => status === config.minStatus);
  return {
    ...EMPTY_RULE,
    type: rule.type,
    name: rule.name,
    description: rule.description ?? '',
    severity: rule.severity,
    message: rule.message,
    isActive: rule.isActive,
    documentTypeCode: text(config.documentTypeCode),
    minStatus: minStatus ?? 'COMPLETE',
    minCount: typeof config.minCount === 'number' ? String(config.minCount) : '',
    field: text(config.field),
    stageKey: text(config.stageKey),
    condition: condition ?? EMPTY_CONDITION,
    conditionMode: rule.type === 'CONDITION' && condition === null ? 'json' : 'builder',
    conditionJson:
      rule.type === 'CONDITION' ? JSON.stringify(config.expression ?? null, null, 2) : '',
  };
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Record<string, unknown> }
  | { readonly ok: false; readonly problems: readonly RuleFieldProblem[] };

/** `config` do tipo (RN-WF-55..58) ou os problemas de preenchimento (V-01). */
export function ruleConfigOf(draft: RuleDraft, types: FieldTypes): ConfigResult {
  const fail = (field: string, code: RuleFieldProblem['code'] = 'REQUIRED'): ConfigResult => ({
    ok: false,
    problems: [{ field, code }],
  });
  switch (draft.type) {
    case 'REQUIRED_DOCUMENT': {
      if (draft.documentTypeCode === '') return fail('config.documentTypeCode');
      const minCount = draft.minCount.trim();
      if (minCount !== '' && !(Number.isInteger(Number(minCount)) && Number(minCount) >= 1)) {
        return fail('config.minCount', 'INVALID');
      }
      return {
        ok: true,
        config: {
          documentTypeCode: draft.documentTypeCode,
          minStatus: draft.minStatus,
          ...(minCount === '' ? {} : { minCount: Number(minCount) }),
        },
      };
    }
    case 'REQUIRED_FIELD':
      return draft.field.trim() === ''
        ? fail('config.field')
        : { ok: true, config: { field: draft.field.trim() } };
    case 'REQUIRED_APPROVAL':
      return draft.stageKey === ''
        ? fail('config.stageKey')
        : { ok: true, config: { stageKey: draft.stageKey } };
    default: {
      if (draft.conditionMode === 'json') {
        try {
          const expression: unknown = JSON.parse(draft.conditionJson);
          return expression === null || typeof expression !== 'object'
            ? fail('config.expression', 'INVALID')
            : { ok: true, config: { expression } };
        } catch {
          return fail('config.expression', 'INVALID');
        }
      }
      const problems = conditionProblems(draft.condition, types);
      return problems.length > 0
        ? { ok: false, problems }
        : { ok: true, config: { expression: conditionToJsonLogic(draft.condition, types) } };
    }
  }
}

/** V-01/V-05: nome, mensagem e `config` (os limites são os da API). */
export function ruleDraftProblems(draft: RuleDraft, types: FieldTypes): RuleFieldProblem[] {
  const problems: RuleFieldProblem[] = [];
  const name = draft.name.trim();
  if (name === '') problems.push({ field: 'name', code: 'REQUIRED' });
  else if (name.length < 3 || name.length > RULE_NAME_MAX) {
    problems.push({ field: 'name', code: 'NAME_LENGTH' });
  }
  const message = draft.message.trim();
  if (message === '') problems.push({ field: 'message', code: 'REQUIRED' });
  else if (message.length < 5 || message.length > RULE_MESSAGE_MAX) {
    problems.push({ field: 'message', code: 'MESSAGE_LENGTH' });
  }
  const config = ruleConfigOf(draft, types);
  if (!config.ok) problems.push(...config.problems);
  return problems;
}

/** Corpo do WF-16 (já validado por `ruleDraftProblems`). */
export function ruleCreateBody(
  draft: RuleDraft,
  target: RuleTarget,
  displayOrder: number,
  config: Record<string, unknown>,
): WorkflowRuleCreate {
  return {
    scope: target.scope,
    stageId: target.scope === 'STAGE_EXIT' ? target.id : null,
    transitionId: target.scope === 'TRANSITION' ? target.id : null,
    type: draft.type,
    name: draft.name.trim(),
    ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() }),
    severity: draft.severity,
    config,
    message: draft.message.trim(),
    isActive: draft.isActive,
    displayOrder,
  };
}

/** Corpo do WF-17: só o que mudou. */
export function rulePatch(
  rule: WorkflowRuleDto,
  draft: RuleDraft,
  config: Record<string, unknown>,
): WorkflowRuleUpdate {
  const patch: { -readonly [K in keyof WorkflowRuleUpdate]: WorkflowRuleUpdate[K] } = {};
  const description = draft.description.trim() === '' ? null : draft.description.trim();
  if (draft.type !== rule.type) patch.type = draft.type;
  if (draft.name.trim() !== rule.name) patch.name = draft.name.trim();
  if (description !== rule.description) patch.description = description;
  if (draft.severity !== rule.severity) patch.severity = draft.severity;
  if (draft.message.trim() !== rule.message) patch.message = draft.message.trim();
  if (draft.isActive !== rule.isActive) patch.isActive = draft.isActive;
  if (JSON.stringify(config) !== JSON.stringify(rule.config)) patch.config = config;
  return patch;
}

/** Resumo legível da configuração na lista de regras. */
export function ruleSummaryOf(rule: Pick<WorkflowRuleDto, 'type' | 'config'>): string {
  const { config } = rule;
  switch (rule.type) {
    case 'REQUIRED_DOCUMENT':
      return `${text(config.documentTypeCode)} · ${text(config.minStatus)}${
        typeof config.minCount === 'number' ? ` · ≥ ${String(config.minCount)}` : ''
      }`;
    case 'REQUIRED_FIELD':
      return text(config.field);
    case 'REQUIRED_APPROVAL':
      return text(config.stageKey);
    default:
      return JSON.stringify(config.expression ?? null);
  }
}

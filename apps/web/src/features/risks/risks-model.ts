import {
  RISK_LEVEL_LABELS,
  RISK_MESSAGES,
  assessRisk,
  createRiskSchema,
} from '@contrataflow/validation';
import type {
  CreateRiskInput,
  RiskDto,
  RiskLevel,
  RiskListMetaDto,
  RiskLockReason,
  RiskPhase,
  RiskStatus,
  UpdateRiskInput,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras de tela da lista e do formulário de riscos (US-033 · SCR-011), puras e testáveis: estado
 * do formulário ↔ corpos de RSK-02/04, validação com o MESMO schema da API mais a escala vigente
 * (V-03), tradução dos erros da API para campos, rótulos da grade, "Sem responsável" (FA-03),
 * transição de nível na reavaliação (FA-01), motivo de bloqueio (FA-04) e a navegação por setas da
 * grade de probabilidade × impacto.
 */

export type RiskScale = RiskListMetaDto['scale'];
export type LevelThresholdBand = RiskListMetaDto['levelThresholds'][number];

/** Grau inteiro dentro de `[1, max]` (V-03; `max` é o `risk.scale.max` vigente). */
function withinScale(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

// --- Formulário ---------------------------------------------------------------------------------

export interface RiskFormValues {
  readonly title: string;
  readonly description: string;
  readonly categoryId: string;
  readonly phase: RiskPhase;
  readonly cause: string;
  readonly consequence: string;
  readonly probability: number | null;
  readonly impact: number | null;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly ownerDepartmentId: string;
  readonly ownerDepartmentName: string;
  readonly residualProbability: number | null;
  readonly residualImpact: number | null;
  readonly status: RiskStatus;
}

export type RiskFormField =
  | 'title'
  | 'description'
  | 'categoryId'
  | 'phase'
  | 'cause'
  | 'consequence'
  | 'probability'
  | 'impact'
  | 'ownerId'
  | 'ownerDepartmentId'
  | 'residualProbability'
  | 'residualImpact'
  | 'status';

export const RISK_FORM_FIELDS: readonly RiskFormField[] = [
  'title',
  'description',
  'categoryId',
  'phase',
  'cause',
  'consequence',
  'probability',
  'impact',
  'ownerId',
  'ownerDepartmentId',
  'residualProbability',
  'residualImpact',
  'status',
];

export type RiskFieldMessages = Partial<Record<RiskFormField, string>>;

/** Fase padrão de um risco novo (story · Campos). */
export const DEFAULT_RISK_PHASE: RiskPhase = 'PLANNING';

/** Valores iniciais: o risco em edição ou um novo (fase `PLANNING`, status `OPEN`). */
export function riskFormValuesOf(risk: RiskDto | null): RiskFormValues {
  return {
    title: risk?.title ?? '',
    description: risk?.description ?? '',
    categoryId: risk?.categoryId ?? '',
    phase: risk?.phase ?? DEFAULT_RISK_PHASE,
    cause: risk?.cause ?? '',
    consequence: risk?.consequence ?? '',
    probability: risk?.probability ?? null,
    impact: risk?.impact ?? null,
    ownerId: risk?.ownerId ?? '',
    ownerName: risk?.owner?.name ?? '',
    ownerDepartmentId: risk?.ownerDepartmentId ?? '',
    ownerDepartmentName: risk?.ownerDepartment?.name ?? '',
    residualProbability: risk?.residualProbability ?? null,
    residualImpact: risk?.residualImpact ?? null,
    status: risk?.status ?? 'OPEN',
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value);

/** O estado completo como corpo de RSK-02 (vazios = não informados; estrito: sem residuais). */
export function createBodyOf(values: RiskFormValues): CreateRiskInput {
  return {
    title: values.title,
    ...(values.description.trim() === '' ? {} : { description: values.description }),
    // Categoria e grade sem seleção = ausentes ("Informe a categoria/probabilidade/impacto.").
    ...(values.categoryId === '' ? {} : { categoryId: values.categoryId }),
    phase: values.phase,
    cause: values.cause,
    consequence: values.consequence,
    ...(values.probability === null ? {} : { probability: values.probability }),
    ...(values.impact === null ? {} : { impact: values.impact }),
    ...(values.ownerId === '' ? {} : { ownerId: values.ownerId }),
    ...(values.ownerDepartmentId === '' ? {} : { ownerDepartmentId: values.ownerDepartmentId }),
  } as CreateRiskInput;
}

type FieldValue = string | number | null;

function comparableOf(values: RiskFormValues): Record<RiskFormField, FieldValue> {
  return {
    title: values.title.trim(),
    description: orNull(values.description)?.trim() ?? null,
    categoryId: values.categoryId,
    phase: values.phase,
    cause: values.cause.trim(),
    consequence: values.consequence.trim(),
    probability: values.probability,
    impact: values.impact,
    ownerId: orNull(values.ownerId),
    ownerDepartmentId: orNull(values.ownerDepartmentId),
    residualProbability: values.residualProbability,
    residualImpact: values.residualImpact,
    status: values.status,
  };
}

/** PATCH de RSK-04: só os campos alterados (`null` limpa os opcionais; residuais sempre em par). */
export function patchOf(risk: RiskDto, values: RiskFormValues): UpdateRiskInput {
  const before = comparableOf(riskFormValuesOf(risk));
  const after = comparableOf(values);
  const patch: Record<string, FieldValue> = {};
  for (const field of RISK_FORM_FIELDS) {
    if (field === 'residualProbability' || field === 'residualImpact') continue;
    if (before[field] !== after[field]) patch[field] = after[field];
  }
  if (
    before.residualProbability !== after.residualProbability ||
    before.residualImpact !== after.residualImpact
  ) {
    patch.residualProbability = after.residualProbability;
    patch.residualImpact = after.residualImpact;
  }
  return patch;
}

/** Validação do formulário: MESMO schema da API + escala vigente (V-03) + par residual (RN-RISK-08). */
export function validateRisk(values: RiskFormValues, scaleMax: number): RiskFieldMessages {
  const messages: RiskFieldMessages = {};
  const result = createRiskSchema.safeParse(createBodyOf(values));
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && (RISK_FORM_FIELDS as readonly string[]).includes(field)) {
        messages[field as RiskFormField] ??= issue.message;
      }
    }
  }
  for (const field of ['probability', 'impact'] as const) {
    const value = values[field];
    if (value !== null && !withinScale(value, scaleMax)) {
      messages[field] = RISK_MESSAGES.outOfRange(scaleMax);
    }
  }
  const { residualProbability: rp, residualImpact: ri } = values;
  if ((rp === null) !== (ri === null)) {
    messages[rp === null ? 'residualProbability' : 'residualImpact'] = RISK_MESSAGES.residualPair;
  }
  for (const [field, value] of [
    ['residualProbability', rp],
    ['residualImpact', ri],
  ] as const) {
    if (value !== null && !withinScale(value, scaleMax)) {
      messages[field] = RISK_MESSAGES.outOfRange(scaleMax);
    }
  }
  return messages;
}

// --- Tradução dos erros da API ------------------------------------------------------------------

export type RiskProblem =
  | { readonly kind: 'fields'; readonly fields: RiskFieldMessages }
  | { readonly kind: 'stale' }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'permission' }
  | { readonly kind: 'keyReused' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

function fieldMessageOf(field: RiskFormField, code: string, scaleMax: number, fallback: string) {
  if (code === 'REFERENCE_NOT_FOUND' || code === 'REFERENCE_INACTIVE') {
    if (field === 'categoryId') return RISK_MESSAGES.categoryInvalid;
    if (field === 'ownerId' || field === 'ownerDepartmentId') return RISK_MESSAGES.ownerInvalid;
  }
  if (code === 'OUT_OF_RANGE') return RISK_MESSAGES.outOfRange(scaleMax);
  return fallback;
}

/** Classifica o erro de uma gravação (RSK-02/04/05) segundo a tabela "Casos de erro" da story. */
export function riskProblemOf(error: unknown, scaleMax: number): RiskProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  if (error.status === 412) return { kind: 'stale' };
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'keyReused' };
  if (error.status === 403) return { kind: 'permission' };
  if (error.code === 'DOCUMENT_NOT_EDITABLE') {
    return { kind: 'blocked', message: RISK_MESSAGES.locked };
  }
  if (error.code === 'INVALID_PROCESS_STATUS') {
    return { kind: 'blocked', message: RISK_MESSAGES.invalidProcessStatus };
  }
  if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
    return { kind: 'blocked', message: error.problem?.detail ?? error.message };
  }
  if (error.status === 422) {
    const fields: RiskFieldMessages = {};
    for (const entry of error.errors) {
      if ((RISK_FORM_FIELDS as readonly string[]).includes(entry.field)) {
        const field = entry.field as RiskFormField;
        fields[field] ??= fieldMessageOf(field, entry.code, scaleMax, entry.message);
      }
    }
    return Object.keys(fields).length > 0
      ? { kind: 'fields', fields }
      : { kind: 'blocked', message: error.problem?.detail ?? error.message };
  }
  if (error.status === 404) return { kind: 'notFound' };
  if (error.status === 503 || error.status === 429) return { kind: 'unavailable' };
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}

/** Campos cujas opções vêm de referência e devem ser recarregadas (V-04/V-05). */
export function referenceFieldsOf(fields: RiskFieldMessages): RiskFormField[] {
  return (['categoryId', 'ownerId', 'ownerDepartmentId'] as const).filter(
    (field) => fields[field] !== undefined,
  );
}

// --- Exibição -----------------------------------------------------------------------------------

/** FA-03: responsável (pessoa e/ou unidade) ou "Sem responsável". */
export function ownerLabelOf(risk: Pick<RiskDto, 'owner' | 'ownerDepartment'>): {
  readonly text: string;
  readonly missing: boolean;
} {
  const parts = [risk.owner?.name, risk.ownerDepartment?.name].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.length === 0
    ? { text: RISK_MESSAGES.noOwner, missing: true }
    : { text: parts.join(' · '), missing: false };
}

/** FA-01: "Alto → Médio" quando o nível muda; `null` quando permanece. */
export function levelTransitionOf(from: RiskLevel, to: RiskLevel): string | null {
  return from === to ? null : `${RISK_LEVEL_LABELS[from]} → ${RISK_LEVEL_LABELS[to]}`;
}

/** Nível calculado hoje (escala vigente) com a avaliação atual do formulário; `null` incompleta. */
export function liveAssessment(
  probability: number | null,
  impact: number | null,
  scaleMax: number,
  thresholds: readonly LevelThresholdBand[],
) {
  if (probability === null || impact === null) return null;
  if (!withinScale(probability, scaleMax) || !withinScale(impact, scaleMax)) {
    return null;
  }
  return assessRisk(probability, impact, thresholds);
}

/** Rótulo de um grau da escala: "Alta (4)" (o número vem sempre junto do rótulo). */
export function gradeLabelOf(labels: readonly string[], value: number): string {
  const label = labels[value - 1];
  return label === undefined || label === '' ? String(value) : `${label} (${String(value)})`;
}

/** `aria-label` da célula: "Probabilidade Alta (4), impacto Médio (3): escore 12, nível Alto". */
export function cellLabelOf(
  probability: number,
  impact: number,
  scale: RiskScale,
  thresholds: readonly LevelThresholdBand[],
): string {
  const { score, level } = assessRisk(probability, impact, thresholds);
  return `Probabilidade ${gradeLabelOf(scale.probabilityLabels, probability)}, impacto ${gradeLabelOf(scale.impactLabels, impact)}: escore ${String(score)}, nível ${RISK_LEVEL_LABELS[level]}`;
}

export interface GridPosition {
  readonly probability: number;
  readonly impact: number;
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 1), max);

/**
 * Navegação por setas da grade (probabilidade cresce para cima, impacto para a direita):
 * `ArrowUp/Down` mudam a probabilidade, `ArrowLeft/Right` o impacto, `Home/End` vão ao primeiro/
 * último impacto da linha. Nos limites a posição não muda; tecla desconhecida devolve `null`.
 */
export function moveGridPosition(
  position: GridPosition,
  key: string,
  max: number,
): GridPosition | null {
  switch (key) {
    case 'ArrowUp':
      return { ...position, probability: clamp(position.probability + 1, max) };
    case 'ArrowDown':
      return { ...position, probability: clamp(position.probability - 1, max) };
    case 'ArrowRight':
      return { ...position, impact: clamp(position.impact + 1, max) };
    case 'ArrowLeft':
      return { ...position, impact: clamp(position.impact - 1, max) };
    case 'Home':
      return { ...position, impact: 1 };
    case 'End':
      return { ...position, impact: max };
    default:
      return null;
  }
}

// --- Bloqueio (FA-04) ---------------------------------------------------------------------------

export interface RiskLockState {
  /** Mostra "Novo risco" e as ações por risco? (cenário [Permissão]: sem permissão, nada aparece.) */
  readonly showActions: boolean;
  /** Ações visíveis porém desabilitadas. */
  readonly disabled: boolean;
  /** Aviso do bloqueio; `null` quando editável ou sem permissão. */
  readonly reason: RiskLockReason | null;
}

export function lockStateOf(meta: {
  readonly canManage: boolean;
  readonly lockReason: RiskLockReason | null;
}): RiskLockState {
  if (meta.canManage) return { showActions: true, disabled: false, reason: null };
  if (meta.lockReason === null || meta.lockReason === 'PERMISSION_DENIED') {
    return { showActions: false, disabled: true, reason: null };
  }
  return { showActions: true, disabled: true, reason: meta.lockReason };
}

/** Campos alterados por outra pessoa entre a versão aberta e a atual (412: "destaca divergências"). */
export function divergentFieldsOf(base: RiskDto, latest: RiskDto): RiskFormField[] {
  const before = comparableOf(riskFormValuesOf(base));
  const after = comparableOf(riskFormValuesOf(latest));
  return RISK_FORM_FIELDS.filter((field) => before[field] !== after[field]);
}

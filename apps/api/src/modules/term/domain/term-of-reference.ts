import { AWARD_TYPES, DAY_COUNT_TYPES, TERM_LIMITS, TERM_MESSAGES } from '@contrataflow/validation';
import type {
  AwardType,
  FieldConfig,
  FieldError,
  TermEstimatedValueSource,
  TermPatch,
} from '@contrataflow/validation';
import { z } from 'zod';

/*
 * Termo de Referência (US-036 · entities.md §4.8 `TermOfReference` · RN-TR-06..08/14): o cabeçalho
 * tipado 1:1 do `Document` do tipo `TR` (mesmo id) e o valor estimado com origem rastreável
 * (`EstimatedValue` — DEC-032). Funções puras: a leitura do processo, do template e da pesquisa de
 * preços é da aplicação.
 */

export interface TermOfReference {
  /** = `documentId` (CHECK `terms_of_reference_id_is_document`). */
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string;
  readonly objectDefinition: string;
  readonly contractDurationMonths: number | null;
  readonly executionDeadline: number | null;
  readonly executionDeadlineType: (typeof DAY_COUNT_TYPES)[number] | null;
  readonly deliveryLocation: string | null;
  readonly paymentTermDays: number | null;
  readonly productWarrantyMonths: number | null;
  /** Decimal(9,4) como string. */
  readonly contractGuaranteePercent: string | null;
  readonly allowsSubcontracting: boolean | null;
  readonly selectionCriterionId: string | null;
  readonly awardType: AwardType | null;
  /** Decimal(18,2) como string. */
  readonly estimatedTotalValue: string | null;
  readonly estimatedValueSource: TermEstimatedValueSource | null;
  readonly priceResearchId: string | null;
  readonly importedFromEtpId: string | null;
  readonly importedFromEtpVersionId: string | null;
  readonly importedAt: Date | null;
  readonly importedById: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

// --- Valor estimado (RN-TR-07/08 · DEC-032) -----------------------------------------------------

/** Valor estimado do TR: valor, origem e pesquisa vinculada (value object). */
export interface EstimatedValue {
  readonly value: string | null;
  readonly source: TermEstimatedValueSource | null;
  readonly priceResearchId: string | null;
}

/** Pesquisa concluída como o TR a usa (id e total). */
export interface CompletedResearch {
  readonly id: string;
  readonly totalEstimatedValue: string;
}

const NO_VALUE: EstimatedValue = { value: null, source: null, priceResearchId: null };

/** `"100000"` → `"100000.00"`; `"0.5"` → `"0.50"` (a string já passou pelo V-11). */
export function normalizeMoney(value: string): string {
  const [integer = '0', fraction = ''] = value.trim().split('.');
  return `${integer}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/** RN-TR-08 `PRICE_RESEARCH`: o total da pesquisa vinculada, somente leitura. */
export function estimatedFromResearch(research: CompletedResearch): EstimatedValue {
  return {
    value: normalizeMoney(research.totalEstimatedValue),
    source: 'PRICE_RESEARCH',
    priceResearchId: research.id,
  };
}

/** RN-TR-08 `MANUAL`: ≥ 0, 2 casas; sem pesquisa vinculada (a justificativa vai na seção). */
export function manualEstimated(value: string): EstimatedValue {
  return { value: normalizeMoney(value), source: 'MANUAL', priceResearchId: null };
}

/**
 * A intenção do TRM-04 sobre o valor estimado: vincular à pesquisa (a indicada, a já vinculada ou
 * a concluída do processo), informar manualmente ou nada.
 */
export type EstimatedValueIntent =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'LINK_RESEARCH'; readonly priceResearchId: string | null }
  | { readonly kind: 'MANUAL'; readonly value: string };

export type EstimatedValueIntentResult =
  | { readonly ok: true; readonly intent: EstimatedValueIntent }
  | { readonly ok: false; readonly error: FieldError };

function notAllowed(field: string, message: string): EstimatedValueIntentResult {
  return { ok: false, error: { field, code: 'NOT_ALLOWED', message } };
}

/**
 * RN-TR-08 no TRM-04: `ETP` só pela importação (US-037); a pesquisa (`priceResearchId` ou origem
 * `PRICE_RESEARCH`) não aceita valor no corpo; `MANUAL` exige o valor (o enviado ou o manual atual);
 * valor sem origem vale como `MANUAL` — exceto sobre um valor vinculado (pesquisa/ETP), que é
 * somente leitura.
 */
export function estimatedValueIntent(
  current: Pick<
    TermOfReference,
    'estimatedTotalValue' | 'estimatedValueSource' | 'priceResearchId'
  >,
  patch: Pick<TermPatch, 'priceResearchId' | 'estimatedTotalValue' | 'estimatedValueSource'>,
): EstimatedValueIntentResult {
  const { priceResearchId, estimatedTotalValue: value, estimatedValueSource: source } = patch;
  if (source === 'ETP')
    return notAllowed('estimatedValueSource', TERM_MESSAGES.etpSourceNotAllowed);
  if (source === 'MANUAL' && priceResearchId !== undefined) {
    return notAllowed('priceResearchId', TERM_MESSAGES.priceResearchInvalid);
  }
  if (source === 'PRICE_RESEARCH' || priceResearchId !== undefined) {
    if (value !== undefined) return notAllowed('estimatedTotalValue', TERM_MESSAGES.valueReadOnly);
    return {
      ok: true,
      intent: {
        kind: 'LINK_RESEARCH',
        priceResearchId: priceResearchId ?? current.priceResearchId,
      },
    };
  }
  if (source === 'MANUAL') {
    const manual =
      value ?? (current.estimatedValueSource === 'MANUAL' ? current.estimatedTotalValue : null);
    if (manual === null) {
      return {
        ok: false,
        error: {
          field: 'estimatedTotalValue',
          code: 'CONDITIONAL_REQUIRED',
          message: TERM_MESSAGES.manualValueRequired,
        },
      };
    }
    return { ok: true, intent: { kind: 'MANUAL', value: manual } };
  }
  if (value !== undefined) {
    if (
      current.estimatedValueSource === 'PRICE_RESEARCH' ||
      current.estimatedValueSource === 'ETP'
    ) {
      return notAllowed('estimatedTotalValue', TERM_MESSAGES.valueReadOnly);
    }
    return { ok: true, intent: { kind: 'MANUAL', value } };
  }
  return { ok: true, intent: { kind: 'NONE' } };
}

// --- Criação (RN-TR-06/07) ----------------------------------------------------------------------

/** Campos do cabeçalho que aceitam valor padrão do `fieldConfig` (as condições — US-038). */
const DEFAULTABLE = {
  contractDurationMonths: z.int().min(1).max(120),
  executionDeadline: z.int().min(1),
  executionDeadlineType: z.enum(DAY_COUNT_TYPES),
  deliveryLocation: z.string().trim().min(1).max(2000),
  paymentTermDays: z.int().min(1).max(90),
  productWarrantyMonths: z.int().min(0).max(120),
  contractGuaranteePercent: z
    .string()
    .regex(/^(?:\d|10)(?:\.\d{1,4})?$/)
    .refine((value) => Number(value) <= 10),
  allowsSubcontracting: z.boolean(),
  awardType: z.enum(AWARD_TYPES),
} as const;

type DefaultableField = keyof typeof DEFAULTABLE;
type HeaderDefaults = { -readonly [K in DefaultableField]?: TermOfReference[K] };

/**
 * RN-TR-06: os valores padrão do `fieldConfig` da versão do template que respeitam os limites do
 * campo (entities.md §4.8); padrão inválido é ignorado (o campo nasce nulo). Prazo sem tipo de
 * contagem não é aplicado (CHECK `terms_of_reference_execution_deadline_type`).
 */
export function headerDefaults(fieldConfig: FieldConfig): HeaderDefaults {
  const defaults: Record<string, unknown> = {};
  for (const field of Object.keys(DEFAULTABLE) as DefaultableField[]) {
    const raw = fieldConfig[field]?.defaultValue;
    if (raw === undefined || raw === null) continue;
    const parsed = DEFAULTABLE[field].safeParse(raw);
    if (parsed.success) defaults[field] = parsed.data;
  }
  if (defaults.executionDeadline !== undefined && defaults.executionDeadlineType === undefined) {
    delete defaults.executionDeadline;
  }
  return defaults;
}

/** RN-TR-14: o objeto do processo como `objectDefinition` inicial (até 2.000 caracteres). */
export function initialObjectDefinition(processObject: string): string {
  const object = processObject.trim();
  return Array.from(object).slice(0, TERM_LIMITS.objectMax).join('');
}

/**
 * `TermOfReference.createFor` (RN-TR-06/07): objeto do processo, padrões do `fieldConfig`, e — com
 * pesquisa concluída — `priceResearchId`, o total e a origem `PRICE_RESEARCH`. Versão 1.
 */
export function createTermOfReference(input: {
  readonly documentId: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly processObject: string;
  readonly fieldConfig: FieldConfig;
  readonly completedResearch: CompletedResearch | null;
  readonly creatorId: string | null;
  readonly now: Date;
}): TermOfReference {
  const estimated =
    input.completedResearch === null ? NO_VALUE : estimatedFromResearch(input.completedResearch);
  return {
    id: input.documentId,
    tenantId: input.tenantId,
    processId: input.processId,
    documentId: input.documentId,
    objectDefinition: initialObjectDefinition(input.processObject),
    contractDurationMonths: null,
    executionDeadline: null,
    executionDeadlineType: null,
    deliveryLocation: null,
    paymentTermDays: null,
    productWarrantyMonths: null,
    contractGuaranteePercent: null,
    allowsSubcontracting: null,
    selectionCriterionId: null,
    awardType: null,
    ...headerDefaults(input.fieldConfig),
    estimatedTotalValue: estimated.value,
    estimatedValueSource: estimated.source,
    priceResearchId: estimated.priceResearchId,
    importedFromEtpId: null,
    importedFromEtpVersionId: null,
    importedAt: null,
    importedById: null,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.creatorId,
    updatedById: input.creatorId,
    version: 1,
  };
}

// --- Gravação do cabeçalho (TRM-04) -------------------------------------------------------------

export interface TermHeaderChange {
  readonly field:
    'objectDefinition' | 'estimatedTotalValue' | 'estimatedValueSource' | 'priceResearchId';
  readonly old: unknown;
  readonly new: unknown;
}

/** Aplica o objeto e o valor estimado resolvidos; devolve só os campos que mudaram. */
export function applyTermHeader(
  term: TermOfReference,
  update: { readonly objectDefinition?: string; readonly estimated?: EstimatedValue },
  stamp: { readonly actorId: string; readonly now: Date },
): { readonly term: TermOfReference; readonly changes: readonly TermHeaderChange[] } {
  const changes: TermHeaderChange[] = [];
  let next: TermOfReference = term;
  if (update.objectDefinition !== undefined && update.objectDefinition !== term.objectDefinition) {
    changes.push({
      field: 'objectDefinition',
      old: term.objectDefinition,
      new: update.objectDefinition,
    });
    next = { ...next, objectDefinition: update.objectDefinition };
  }
  const estimated = update.estimated;
  if (estimated !== undefined) {
    const pairs = [
      ['estimatedTotalValue', term.estimatedTotalValue, estimated.value],
      ['estimatedValueSource', term.estimatedValueSource, estimated.source],
      ['priceResearchId', term.priceResearchId, estimated.priceResearchId],
    ] as const;
    for (const [field, old, value] of pairs) {
      if (old !== value) changes.push({ field, old, new: value });
    }
    next = {
      ...next,
      estimatedTotalValue: estimated.value,
      estimatedValueSource: estimated.source,
      priceResearchId: estimated.priceResearchId,
    };
  }
  if (changes.length === 0) return { term, changes };
  return {
    term: { ...next, updatedAt: stamp.now, updatedById: stamp.actorId },
    changes,
  };
}

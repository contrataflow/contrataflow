import {
  createEtpAlternativeSchema,
  decisionJustificationProblem,
  ETP_ALTERNATIVE_MESSAGES,
  richTextFromPlainText,
  richTextPlainText,
} from '@contrataflow/validation';
import type {
  AlternativeDecision,
  CreateEtpAlternative,
  EtpAlternativeDto,
  RiskLevel,
  UpdateEtpAlternative,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { formatMoneyText, parseMoneyText } from '../processes/money';

/*
 * Regras puras da seção "Alternativas" do ETP (US-021 · SCR-008): os valores do
 * `AlternativeFormDrawer` (textos simples — a descrição, as vantagens e as desvantagens viram o
 * documento rico de um parágrafo por linha), o corpo do ETP-06 e o patch do ETP-07 (só o que mudou),
 * a validação com o MESMO schema da API e a leitura das recusas da API (V-01..V-09).
 */

export const ALTERNATIVE_FORM_FIELDS = [
  'name',
  'description',
  'advantages',
  'disadvantages',
  'estimatedCost',
  'riskLevel',
  'observations',
] as const;
export type AlternativeFormField = (typeof ALTERNATIVE_FORM_FIELDS)[number];

export interface AlternativeFormValues {
  readonly name: string;
  readonly description: string;
  readonly advantages: string;
  readonly disadvantages: string;
  /** Texto em reais ("15.000,00"); vazio = não informado. */
  readonly estimatedCost: string;
  readonly riskLevel: RiskLevel | '';
  readonly observations: string;
}

export type AlternativeFieldMessages = Partial<Record<AlternativeFormField, string>>;

const plain = (doc: EtpAlternativeDto['advantages']) =>
  doc === null ? '' : richTextPlainText(doc);

/** Valores iniciais do formulário (nova alternativa ou a versão atual da lista). */
export function alternativeFormValuesOf(
  alternative: EtpAlternativeDto | null,
): AlternativeFormValues {
  return {
    name: alternative?.name ?? '',
    description: alternative === null ? '' : plain(alternative.description),
    advantages: alternative === null ? '' : plain(alternative.advantages),
    disadvantages: alternative === null ? '' : plain(alternative.disadvantages),
    estimatedCost:
      alternative?.estimatedCost === null || alternative?.estimatedCost === undefined
        ? ''
        : formatMoneyText(alternative.estimatedCost),
    riskLevel: alternative?.riskLevel ?? '',
    observations: alternative?.observations ?? '',
  };
}

const richOrNull = (text: string) => (text.trim() === '' ? null : richTextFromPlainText(text));

/**
 * ETP-06. `masked` (POL-09): o custo sigiloso não é exibido nem enviado — o campo fica de fora do
 * corpo (a API recusaria com 403).
 */
export function createAlternativeBodyOf(
  values: AlternativeFormValues,
  options: { readonly masked: boolean } = { masked: false },
): CreateEtpAlternative {
  const cost = parseMoneyText(values.estimatedCost);
  return {
    name: values.name.trim(),
    description: richTextFromPlainText(values.description),
    ...(values.advantages.trim() === '' ? {} : { advantages: richOrNull(values.advantages) }),
    ...(values.disadvantages.trim() === ''
      ? {}
      : { disadvantages: richOrNull(values.disadvantages) }),
    ...(options.masked || cost === undefined ? {} : { estimatedCost: cost }),
    ...(values.riskLevel === '' ? {} : { riskLevel: values.riskLevel }),
    ...(values.observations.trim() === '' ? {} : { observations: values.observations.trim() }),
  };
}

/** ETP-07: só os campos alterados (vazio = nada a gravar). */
export function alternativePatchOf(
  current: EtpAlternativeDto,
  values: AlternativeFormValues,
): UpdateEtpAlternative {
  const before = alternativeFormValuesOf(current);
  const patch: Record<string, unknown> = {};
  if (values.name.trim() !== before.name) patch.name = values.name.trim();
  if (values.description.trim() !== before.description.trim()) {
    patch.description = richTextFromPlainText(values.description);
  }
  if (values.advantages.trim() !== before.advantages.trim()) {
    patch.advantages = richOrNull(values.advantages);
  }
  if (values.disadvantages.trim() !== before.disadvantages.trim()) {
    patch.disadvantages = richOrNull(values.disadvantages);
  }
  if (!current.estimatedCostMasked) {
    const cost = parseMoneyText(values.estimatedCost) ?? null;
    if (cost !== (parseMoneyText(before.estimatedCost) ?? null)) patch.estimatedCost = cost;
  }
  if (values.riskLevel !== before.riskLevel) {
    patch.riskLevel = values.riskLevel === '' ? null : values.riskLevel;
  }
  if (values.observations.trim() !== before.observations.trim()) {
    patch.observations = values.observations.trim() === '' ? null : values.observations.trim();
  }
  return patch;
}

/** V-01/V-02/V-07 no front, com o MESMO schema da API (uma mensagem por campo). */
export function validateAlternative(
  values: AlternativeFormValues,
  options: { readonly masked: boolean } = { masked: false },
): AlternativeFieldMessages {
  const parsed = createEtpAlternativeSchema.safeParse(createAlternativeBodyOf(values, options));
  const messages: AlternativeFieldMessages = {};
  if (parsed.success) return messages;
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? '') as AlternativeFormField;
    if ((ALTERNATIVE_FORM_FIELDS as readonly string[]).includes(field)) {
      messages[field] ??= issue.message;
    }
  }
  return messages;
}

/** V-04 no front: a mensagem da story ou `null`. */
export function decisionMessageOf(
  decision: AlternativeDecision,
  justification: string,
): string | null {
  return decisionJustificationProblem(decision, justification) === null
    ? null
    : ETP_ALTERNATIVE_MESSAGES.justificationRequired;
}

export type AlternativeProblem =
  | { readonly kind: 'fields'; readonly fields: AlternativeFieldMessages }
  | { readonly kind: 'justification'; readonly message: string }
  | { readonly kind: 'recommendedExists'; readonly recommendedAlternativeId: string | null }
  | { readonly kind: 'stale' }
  | { readonly kind: 'permission'; readonly message: string }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** Recusa da API → o que a tela mostra (casos de erro da US-021). */
export function alternativeProblemOf(error: unknown): AlternativeProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  if (error.status === 412) return { kind: 'stale' };
  if (error.code === 'RECOMMENDED_ALTERNATIVE_EXISTS') {
    const meta = (error.problem as { meta?: { recommendedAlternativeId?: string } } | null)?.meta;
    return {
      kind: 'recommendedExists',
      recommendedAlternativeId: meta?.recommendedAlternativeId ?? null,
    };
  }
  if (error.status === 403) {
    return {
      kind: 'permission',
      message: error.problem?.detail ?? ETP_ALTERNATIVE_MESSAGES.permissionDenied,
    };
  }
  if (error.code === 'DOCUMENT_NOT_EDITABLE') {
    return { kind: 'blocked', message: ETP_ALTERNATIVE_MESSAGES.notEditable };
  }
  if (
    error.code === 'INVALID_STATE' ||
    error.code === 'INVALID_PROCESS_STATUS' ||
    error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE'
  ) {
    return { kind: 'blocked', message: error.problem?.detail ?? error.message };
  }
  if (error.status === 422) {
    const justification = error.errors.find((entry) => entry.field === 'decisionJustification');
    if (justification !== undefined) {
      return { kind: 'justification', message: ETP_ALTERNATIVE_MESSAGES.justificationRequired };
    }
    const fields: AlternativeFieldMessages = {};
    for (const entry of error.errors) {
      if ((ALTERNATIVE_FORM_FIELDS as readonly string[]).includes(entry.field)) {
        fields[entry.field as AlternativeFormField] ??= entry.message;
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

/** Mensagem de uma recusa fora do formulário (`null` = o chamador decide). */
export function alternativeProblemMessage(problem: AlternativeProblem): string | null {
  switch (problem.kind) {
    case 'stale':
      return ETP_ALTERNATIVE_MESSAGES.versionConflict;
    case 'permission':
    case 'blocked':
    case 'justification':
      return problem.message;
    case 'recommendedExists':
      return ETP_ALTERNATIVE_MESSAGES.recommendedExists;
    case 'notFound':
      return ETP_ALTERNATIVE_MESSAGES.notFound;
    case 'unavailable':
      return ETP_ALTERNATIVE_MESSAGES.unavailable;
    case 'fields':
    case 'unexpected':
      return null;
  }
}

/** Reordenação (ETP-07 `sortOrder`): a nova ordem ao mover uma posição para cima/baixo. */
export function movedOrder(
  alternatives: readonly Pick<EtpAlternativeDto, 'id' | 'sortOrder'>[],
  id: string,
  direction: -1 | 1,
): { readonly id: string; readonly sortOrder: number }[] {
  const index = alternatives.findIndex((alternative) => alternative.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= alternatives.length) return [];
  const ids = alternatives.map((alternative) => alternative.id);
  const moved = ids[index];
  const other = ids[target];
  if (moved === undefined || other === undefined) return [];
  ids[index] = other;
  ids[target] = moved;
  // Só quem muda de posição é regravado (cada PATCH com a versão da linha).
  return ids
    .map((alternativeId, position) => ({ id: alternativeId, sortOrder: position }))
    .filter(
      (entry) =>
        alternatives.find((alternative) => alternative.id === entry.id)?.sortOrder !==
        entry.sortOrder,
    );
}

import {
  TREATMENT_MESSAGES,
  createRiskTreatmentSchema,
  isTerminalTreatmentStatus,
  nextTreatmentStatuses,
} from '@contrataflow/validation';
import type {
  CreateRiskTreatmentInput,
  RiskTreatmentDto,
  TreatmentStatus,
  TreatmentType,
  UpdateRiskTreatmentInput,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras de tela das ações de tratamento (US-034 · SCR-011), puras e testáveis: estado do
 * formulário ↔ corpos de RSK-06/07, validação com o MESMO schema da API, tradução dos erros da API
 * (tabela "Casos de erro"), opções de status pela máquina de RN-RISK-15, destaque de prazo calculado
 * em runtime (FA-03) e a reordenação (FA-02).
 */

// --- Formulário ---------------------------------------------------------------------------------

export interface TreatmentFormValues {
  readonly type: TreatmentType | '';
  readonly description: string;
  readonly responsibleId: string;
  readonly responsibleName: string;
  readonly responsibleDepartmentId: string;
  readonly responsibleDepartmentName: string;
  readonly dueDate: string;
  readonly notes: string;
}

export type TreatmentFormField =
  'type' | 'description' | 'responsibleId' | 'responsibleDepartmentId' | 'dueDate' | 'notes';

export const TREATMENT_FORM_FIELDS: readonly TreatmentFormField[] = [
  'type',
  'description',
  'responsibleId',
  'responsibleDepartmentId',
  'dueDate',
  'notes',
];

export type TreatmentFieldMessages = Partial<Record<TreatmentFormField, string>>;

/** Valores iniciais: o tratamento em edição ou um novo (sem tipo escolhido). */
export function treatmentFormValuesOf(treatment: RiskTreatmentDto | null): TreatmentFormValues {
  return {
    type: treatment?.type ?? '',
    description: treatment?.description ?? '',
    responsibleId: treatment?.responsibleId ?? '',
    responsibleName: treatment?.responsible?.name ?? '',
    responsibleDepartmentId: treatment?.responsibleDepartmentId ?? '',
    responsibleDepartmentName: treatment?.responsibleDepartment?.name ?? '',
    dueDate: treatment?.dueDate ?? '',
    notes: treatment?.notes ?? '',
  };
}

/** O estado completo como corpo de RSK-06 (vazios = não informados). */
export function createTreatmentBodyOf(values: TreatmentFormValues): CreateRiskTreatmentInput {
  return {
    ...(values.type === '' ? {} : { type: values.type }),
    description: values.description,
    ...(values.responsibleId === '' ? {} : { responsibleId: values.responsibleId }),
    ...(values.responsibleDepartmentId === ''
      ? {}
      : { responsibleDepartmentId: values.responsibleDepartmentId }),
    ...(values.dueDate === '' ? {} : { dueDate: values.dueDate }),
    ...(values.notes.trim() === '' ? {} : { notes: values.notes }),
  } as CreateRiskTreatmentInput;
}

type FieldValue = string | null;

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

function comparableOf(values: TreatmentFormValues): Record<TreatmentFormField, FieldValue> {
  return {
    type: values.type === '' ? null : values.type,
    description: values.description.trim(),
    responsibleId: orNull(values.responsibleId),
    responsibleDepartmentId: orNull(values.responsibleDepartmentId),
    dueDate: orNull(values.dueDate),
    notes: orNull(values.notes),
  };
}

/** PATCH de RSK-07: só os campos alterados (`null` limpa os opcionais). */
export function treatmentPatchOf(
  treatment: RiskTreatmentDto,
  values: TreatmentFormValues,
): UpdateRiskTreatmentInput {
  const before = comparableOf(treatmentFormValuesOf(treatment));
  const after = comparableOf(values);
  const patch: Record<string, FieldValue> = {};
  for (const field of TREATMENT_FORM_FIELDS) {
    if (before[field] !== after[field]) patch[field] = after[field];
  }
  return patch;
}

/** Validação do formulário: o MESMO schema da API (V-01/V-02). */
export function validateTreatment(values: TreatmentFormValues): TreatmentFieldMessages {
  const messages: TreatmentFieldMessages = {};
  const result = createRiskTreatmentSchema.safeParse(createTreatmentBodyOf(values));
  if (result.success) return messages;
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && (TREATMENT_FORM_FIELDS as readonly string[]).includes(field)) {
      messages[field as TreatmentFormField] ??= issue.message;
    }
  }
  return messages;
}

// --- Tradução dos erros da API ------------------------------------------------------------------

export type TreatmentProblem =
  | { readonly kind: 'fields'; readonly fields: TreatmentFieldMessages }
  | { readonly kind: 'stale' }
  | { readonly kind: 'invalidState'; readonly message: string }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'permission' }
  | { readonly kind: 'keyReused' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** Classifica o erro de uma gravação (RSK-06/07/08) segundo a tabela "Casos de erro" da story. */
export function treatmentProblemOf(error: unknown): TreatmentProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  if (error.status === 412) return { kind: 'stale' };
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'keyReused' };
  if (error.status === 403) return { kind: 'permission' };
  if (error.code === 'INVALID_STATE') {
    return { kind: 'invalidState', message: error.problem?.detail ?? error.message };
  }
  if (error.code === 'DOCUMENT_NOT_EDITABLE') {
    return { kind: 'blocked', message: TREATMENT_MESSAGES.locked };
  }
  if (
    error.code === 'INVALID_PROCESS_STATUS' ||
    error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE'
  ) {
    return { kind: 'blocked', message: error.problem?.detail ?? error.message };
  }
  if (error.status === 422) {
    const fields: TreatmentFieldMessages = {};
    for (const entry of error.errors) {
      if ((TREATMENT_FORM_FIELDS as readonly string[]).includes(entry.field)) {
        const field = entry.field as TreatmentFormField;
        const reference =
          entry.code === 'REFERENCE_NOT_FOUND' || entry.code === 'REFERENCE_INACTIVE';
        fields[field] ??= reference ? TREATMENT_MESSAGES.responsibleInvalid : entry.message;
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

/** Mensagem de uma recusa fora do formulário (status, reordenação, exclusão) — `null` = nenhuma. */
export function treatmentProblemMessage(problem: TreatmentProblem): string | null {
  switch (problem.kind) {
    case 'stale':
      return TREATMENT_MESSAGES.versionConflict;
    case 'invalidState':
    case 'blocked':
      return problem.message;
    case 'permission':
      return TREATMENT_MESSAGES.permissionDenied;
    case 'unavailable':
      return TREATMENT_MESSAGES.unavailable;
    case 'notFound':
      return TREATMENT_MESSAGES.notFound;
    case 'fields':
    case 'keyReused':
    case 'unexpected':
      return null;
  }
}

// --- Status (RN-RISK-15) e prazo (FA-03) --------------------------------------------------------

/** Opções do `TreatmentStatusSelect`: o atual e os próximos permitidos (terminal = só o atual). */
export function statusOptionsOf(status: TreatmentStatus): readonly TreatmentStatus[] {
  return [status, ...nextTreatmentStatuses(status)];
}

export type TreatmentDueState =
  | { readonly kind: 'overdue'; readonly days: number }
  | { readonly kind: 'today' }
  | { readonly kind: 'soon'; readonly days: number };

/** Dias até o prazo a partir do destaque "Vence em…" (uma semana). */
export const DUE_SOON_DAYS = 7;

const dayNumber = (isoDate: string) => {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000;
};

/**
 * FA-03: "Atrasado" quando `dueDate < hoje` e o status não é `DONE`/`CANCELED`; "Vence hoje" ou
 * "Vence em N dias" na semana; `null` sem prazo, concluído/cancelado ou prazo distante.
 */
export function dueStateOf(
  treatment: Pick<RiskTreatmentDto, 'dueDate' | 'status'>,
  today: string,
): TreatmentDueState | null {
  if (treatment.dueDate === null || isTerminalTreatmentStatus(treatment.status)) return null;
  const days = dayNumber(treatment.dueDate) - dayNumber(today);
  if (days < 0) return { kind: 'overdue', days: -days };
  if (days === 0) return { kind: 'today' };
  return days <= DUE_SOON_DAYS ? { kind: 'soon', days } : null;
}

/** Hoje no fuso do navegador, como `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `2026-11-30` → `30/11/2026`. */
export function formatDueDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

// --- Reordenação (FA-02) ------------------------------------------------------------------------

export interface SortOrderPatch {
  readonly id: string;
  readonly version: number;
  readonly sortOrder: number;
}

/**
 * Move o tratamento de `from` para `to` na lista exibida e devolve os PATCHs de `sortOrder` só dos
 * itens cuja posição muda (posições 0..n-1). Movimento fora da lista = nenhum PATCH.
 */
export function reorderPatches(
  treatments: readonly Pick<RiskTreatmentDto, 'id' | 'version' | 'sortOrder'>[],
  from: number,
  to: number,
): SortOrderPatch[] {
  if (from === to || to < 0 || to >= treatments.length || from < 0) return [];
  const order = [...treatments];
  const [moved] = order.splice(from, 1);
  if (moved === undefined) return [];
  order.splice(to, 0, moved);
  return order.flatMap((treatment, index) =>
    treatment.sortOrder === index
      ? []
      : [{ id: treatment.id, version: treatment.version, sortOrder: index }],
  );
}

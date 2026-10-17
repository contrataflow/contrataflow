import {
  EDITABLE_PROCESS_STATUSES,
  PROCESS_UPDATE_MESSAGES,
  pcaIssues,
  processConflictCurrentSchema,
  processDateIssues,
  updateProcessSchema,
} from '@contrataflow/validation';
import type {
  EstimatedValueSource,
  ProcessConflictCurrent,
  ProcessDto,
  UpdatableProcessField,
  UpdateProcessInput,
} from '@contrataflow/validation';

import type { ApiError } from '@/lib/api/api-error';

import { formatMoneyText, parseMoneyText, toDecimalMoney } from '../processes/money';
import type {
  FieldMessages,
  ProcessFormField,
  ProcessFormValues,
  ValidationContext,
} from '../processes/process-form-model';

/*
 * Modelo do painel "Editar dados" (US-005 · SCR-006): valores do formulário a partir do PRC-04,
 * campos bloqueados pelo status (RN-PROC-60/61) e pela fonte do valor estimado (RN-PROC-63), o
 * corpo do PRC-05 SÓ com os campos alterados (normalizados como a API — trim, decimal), a validação
 * dos campos enviados com os mesmos schemas da API (RN-PROC-64) e a reaplicação seletiva depois de
 * um 412 (FA-05): só os campos que a outra pessoa não alterou.
 */

const DRAFT_ONLY: readonly ProcessFormField[] = [
  'organizationId',
  'requestingSecretariatId',
  'requestingDepartmentId',
];
const PCA_FIELDS = ['pcaStatus', 'pcaYear', 'pcaItemCode', 'pcaJustification'] as const;

/** O processo admite edição (RN-PROC-59)? */
export function isProcessEditable(process: Pick<ProcessDto, 'status'>): boolean {
  return (EDITABLE_PROCESS_STATUSES as readonly string[]).includes(process.status);
}

/** Valores do formulário a partir do processo (valor estimado no formato brasileiro). */
export function editValuesOf(process: ProcessDto): ProcessFormValues {
  return {
    title: process.title,
    object: process.object,
    description: process.description ?? '',
    contractingTypeId: process.contractingType.id,
    modalityId: process.modality?.id ?? '',
    isPriceRegistration: process.isPriceRegistration,
    organizationId: process.organization.id,
    requestingSecretariatId: process.requestingSecretariat.id,
    requestingDepartmentId: process.requestingDepartment.id,
    priority: process.priority,
    targetDate: process.targetDate ?? '',
    estimatedValue: process.estimatedValue === null ? '' : formatMoneyText(process.estimatedValue),
    originId: process.origin.id,
    pcaStatus: process.pcaStatus,
    pcaYear: process.pcaYear === null ? '' : String(process.pcaYear),
    pcaItemCode: process.pcaItemCode ?? '',
    pcaJustification: process.pcaJustification ?? '',
    internalCode: process.internalCode ?? '',
    notes: process.notes ?? '',
  };
}

export type LockReason = 'DRAFT_ONLY' | 'NUMBERING';

/** RN-PROC-60/61: campos somente leitura no status atual (com o motivo). */
export function lockedFieldsOf(
  process: Pick<ProcessDto, 'status' | 'code'>,
  options: { readonly numberingByOrganization: boolean },
): Partial<Record<ProcessFormField, LockReason>> {
  if (process.status !== 'DRAFT') {
    return Object.fromEntries(DRAFT_ONLY.map((field) => [field, 'DRAFT_ONLY' as const]));
  }
  return process.code !== null && options.numberingByOrganization
    ? { organizationId: 'NUMBERING' }
    : {};
}

/** RN-PROC-63: fonte de maior precedência que deixa o valor estimado somente leitura. */
export function estimatedValueLock(
  process: Pick<ProcessDto, 'estimatedValueSource'>,
): Exclude<EstimatedValueSource, 'MANUAL'> | null {
  const source = process.estimatedValueSource;
  return source === null || source === 'MANUAL' ? null : source;
}

const text = (value: string) => value.trim();
const optionalText = (value: string): string | null => (value.trim() === '' ? null : value.trim());

function yearOf(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Valor de cada campo como a API o grava (para comparar e para o corpo). */
function apiValue(values: ProcessFormValues, field: UpdatableProcessField): unknown {
  switch (field) {
    case 'title':
    case 'object':
      return text(values[field]);
    case 'description':
    case 'notes':
    case 'internalCode':
    case 'pcaItemCode':
    case 'pcaJustification':
      return optionalText(values[field]);
    case 'modalityId':
    case 'targetDate':
      return values[field] === '' ? null : values[field];
    case 'estimatedValue':
      return toDecimalMoney(values.estimatedValue) ?? parseMoneyText(values.estimatedValue) ?? null;
    case 'pcaYear':
      return yearOf(values.pcaYear);
    case 'priority':
    case 'pcaStatus':
      return values[field] === '' ? undefined : values[field];
    default:
      return values[field];
  }
}

/** Situação no PCA resultante: só os campos que se aplicam (RN-PROC-12). */
function pcaValues(values: ProcessFormValues): Record<(typeof PCA_FIELDS)[number], unknown> {
  const status = values.pcaStatus;
  return {
    pcaStatus: status === '' ? undefined : status,
    pcaYear: status === 'PLANNED' ? yearOf(values.pcaYear) : null,
    pcaItemCode: status === 'PLANNED' ? optionalText(values.pcaItemCode) : null,
    pcaJustification: status === 'NOT_PLANNED' ? optionalText(values.pcaJustification) : null,
  };
}

const EDITABLE_FIELDS: readonly UpdatableProcessField[] = [
  'organizationId',
  'requestingSecretariatId',
  'requestingDepartmentId',
  'title',
  'object',
  'description',
  'contractingTypeId',
  'modalityId',
  'isPriceRegistration',
  'priority',
  'targetDate',
  'estimatedValue',
  'originId',
  'internalCode',
  'notes',
];

/**
 * Corpo do PRC-05 só com as diferenças (FA-08: vazio = nada a salvar). Campos bloqueados nunca vão
 * no corpo; a situação no PCA vai inteira quando qualquer parte dela mudou.
 */
export function buildUpdatePatch(
  initial: ProcessFormValues,
  values: ProcessFormValues,
  locked: ReadonlySet<ProcessFormField> = new Set(),
): UpdateProcessInput {
  const patch: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (locked.has(field)) continue;
    const next = apiValue(values, field);
    if (next !== apiValue(initial, field)) patch[field] = next;
  }
  const before = pcaValues(initial);
  const after = pcaValues(values);
  if (PCA_FIELDS.some((field) => before[field] !== after[field])) {
    for (const field of PCA_FIELDS) {
      if (after[field] !== undefined) patch[field] = after[field];
    }
  }
  return patch;
}

/**
 * V-01..V-12 sobre os campos ENVIADOS (RN-PROC-64): o mesmo schema da API por campo, as regras do
 * PCA quando ela muda, o prazo alvo ≥ hoje e o código interno obrigatório por configuração.
 */
export function validateEdit(
  patch: UpdateProcessInput,
  values: ProcessFormValues,
  context: ValidationContext,
): FieldMessages {
  const messages: FieldMessages = {};
  const shape = updateProcessSchema.shape;
  for (const [field, value] of Object.entries(patch)) {
    const schema = shape[field as keyof typeof shape];
    const result = schema.safeParse(value);
    const message = result.success ? undefined : result.error.issues[0]?.message;
    if (message !== undefined) messages[field as ProcessFormField] = message;
  }
  if (PCA_FIELDS.some((field) => field in patch)) {
    const pca = {
      pcaStatus: values.pcaStatus === '' ? undefined : values.pcaStatus,
      pcaYear: yearOf(values.pcaYear),
      pcaJustification: values.pcaJustification,
    };
    for (const issue of pcaIssues(pca)) messages[issue.path] ??= issue.message;
    for (const issue of processDateIssues(pca, context)) {
      if (issue.path === 'pcaYear') messages.pcaYear ??= issue.message;
    }
  }
  if ('targetDate' in patch) {
    const issue = processDateIssues({ targetDate: patch.targetDate ?? null }, context)[0];
    if (issue) messages.targetDate ??= issue.message;
  }
  if (context.requireInternalCode && 'internalCode' in patch && patch.internalCode === null) {
    messages.internalCode = PROCESS_UPDATE_MESSAGES.internalCodeRequired;
  }
  return messages;
}

/** `meta.current` do 412 `VERSION_CONFLICT` (ou `null` se o corpo não o trouxer). */
export function conflictCurrentOf(error: ApiError): ProcessConflictCurrent | null {
  const meta = (error.problem as { meta?: { current?: unknown } } | null)?.meta;
  const parsed = processConflictCurrentSchema.safeParse(meta?.current);
  return parsed.success ? parsed.data : null;
}

export interface ConflictRow {
  readonly field: UpdatableProcessField;
  /** O que a pessoa digitou (valor da API). */
  readonly mine: unknown;
  /** O valor gravado agora pela outra pessoa. */
  readonly current: unknown;
}

/**
 * FA-05: campos do PATCH que a outra pessoa também alterou (base lida ≠ atual) — a comparação do
 * diálogo — e o PATCH reaplicável (os demais campos, contra o ETag atual).
 */
export function resolveConflict(
  base: ProcessDto,
  current: ProcessDto,
  patch: UpdateProcessInput,
): { readonly conflicts: ConflictRow[]; readonly reapply: UpdateProcessInput } {
  const before = editValuesOf(base);
  const now = editValuesOf(current);
  const conflicts: ConflictRow[] = [];
  const reapply: Record<string, unknown> = {};
  for (const [field, mine] of Object.entries(patch) as [UpdatableProcessField, unknown][]) {
    const changedByOther =
      field === 'estimatedValue'
        ? base.estimatedValue !== current.estimatedValue ||
          base.estimatedValueSource !== current.estimatedValueSource
        : apiValue(before, field) !== apiValue(now, field);
    if (changedByOther) conflicts.push({ field, mine, current: apiValue(now, field) });
    else reapply[field] = mine;
  }
  return { conflicts, reapply: reapply };
}

/** Textos digitados para "Copiar meus textos" (FA-06). */
export function typedTexts(values: ProcessFormValues): string {
  return [values.title, values.object, values.description, values.notes, values.pcaJustification]
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .join('\n\n');
}

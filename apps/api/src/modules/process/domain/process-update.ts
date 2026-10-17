import {
  DRAFT_ONLY_PROCESS_FIELDS,
  EDITABLE_PROCESS_STATUSES,
  PROCESS_UPDATE_MESSAGES,
  UPDATE_PROCESS_FIELDS,
  pcaIssues,
  processDateIssues,
} from '@contrataflow/validation';
import type {
  EstimatedValueSource,
  ProcessStatus,
  UpdatableProcessField,
  UpdateProcess,
} from '@contrataflow/validation';

import { moneyOf, pcaReference, textOrNull } from './process.js';
import type { Process, ProcessIssue } from './process.js';

/*
 * Edição dos dados do processo (US-005 · PRC-05): funções puras sobre o agregado `Process`.
 * `diffProcess` normaliza o PATCH (trim, decimal canônico, situação no PCA — RN-PROC-12) e devolve o
 * `ChangeSet` — a MESMA fonte de `changedFields` do evento, do `changes[]` da auditoria e do
 * `params.fields` da timeline (RN-PROC-68). `fieldLock` é a política de bloqueio campo × status
 * (RN-PROC-60/61), `estimatedValueLockedBy` a precedência do valor estimado (DEC-032 · RN-PROC-63)
 * e `revalidationIssues` a revalidação parcial do estado resultante (RN-PROC-64). Referências,
 * escopo, unicidade e custódia são do caso de uso.
 */

type EditableValue = string | number | boolean | null;

/** Valores editáveis do processo (os campos de `UPDATE_PROCESS_FIELDS`). */
export type EditableValues = Pick<Process, UpdatableProcessField>;

export interface FieldChange {
  readonly field: UpdatableProcessField;
  readonly old: EditableValue;
  readonly new: EditableValue;
}

export interface ProcessChangeSet {
  /** Estado resultante dos campos editáveis (normalizado). */
  readonly next: EditableValues;
  /** Diferenças efetivas, na ordem canônica de `UPDATE_PROCESS_FIELDS`. Vazio = no-op (RN-PROC-67). */
  readonly changes: readonly FieldChange[];
  /** Campos presentes no corpo (RN-PROC-64: só eles — e as regras cruzadas — são revalidados). */
  readonly sent: ReadonlySet<UpdatableProcessField>;
}

const PCA_FIELDS = ['pcaStatus', 'pcaYear', 'pcaItemCode', 'pcaJustification'] as const;
const OPTIONAL_TEXT_FIELDS = new Set<UpdatableProcessField>([
  'description',
  'notes',
  'pcaItemCode',
  'pcaJustification',
  'internalCode',
]);

function editableValuesOf(process: Process): EditableValues {
  const values: Partial<Record<UpdatableProcessField, EditableValue>> = {};
  for (const field of UPDATE_PROCESS_FIELDS) values[field] = process[field];
  return values as EditableValues;
}

function normalize(field: UpdatableProcessField, value: unknown): EditableValue {
  if (value === null || value === undefined) return null;
  if (OPTIONAL_TEXT_FIELDS.has(field)) return textOrNull(value as string);
  if (field === 'estimatedValue') return moneyOf(value as string);
  if (typeof value === 'string') return value.trim();
  return value as EditableValue;
}

/** RN-PROC-67: o PATCH normalizado contra o estado atual — só as diferenças efetivas contam. */
export function diffProcess(process: Process, patch: UpdateProcess): ProcessChangeSet {
  const current = editableValuesOf(process);
  const draft: Record<UpdatableProcessField, EditableValue> = { ...current };
  const sent = new Set<UpdatableProcessField>();
  for (const field of UPDATE_PROCESS_FIELDS) {
    if (!Object.hasOwn(patch, field) || patch[field] === undefined) continue;
    sent.add(field);
    draft[field] = normalize(field, patch[field]);
  }
  // RN-PROC-12 (DEC-029): só os campos da situação resultante são gravados.
  if (PCA_FIELDS.some((field) => sent.has(field))) {
    Object.assign(
      draft,
      pcaReference({
        pcaStatus: draft.pcaStatus as Process['pcaStatus'],
        pcaYear: draft.pcaYear as number | null,
        pcaItemCode: draft.pcaItemCode as string | null,
        pcaJustification: draft.pcaJustification as string | null,
      }),
    );
  }
  const next = draft as unknown as EditableValues;
  const changes = UPDATE_PROCESS_FIELDS.filter((field) => next[field] !== current[field]).map(
    (field): FieldChange => ({ field, old: current[field], new: next[field] }),
  );
  return { next, changes, sent };
}

/** RN-PROC-59: o processo admite edição neste status? */
export function isEditableStatus(status: ProcessStatus): boolean {
  return (EDITABLE_PROCESS_STATUSES as readonly ProcessStatus[]).includes(status);
}

export interface FieldLockContext {
  readonly status: ProcessStatus;
  /** O processo já tem número (`code`). */
  readonly numbered: boolean;
  /** `numbering.process.scope = ORGANIZATION` ou máscara com `{org}` (RN-PROC-61). */
  readonly numberingDependsOnOrganization: boolean;
}

/**
 * `FieldLockPolicy` (RN-PROC-60/61): `EDITABLE`; `STATUS` (processo fora dos status editáveis —
 * nenhum campo); `DRAFT_ONLY` (órgão e unidade solicitante depois do primeiro encaminhamento);
 * `NUMBERING` (órgão de processo já numerado cuja numeração depende do órgão).
 */
export type FieldLock = 'EDITABLE' | 'STATUS' | 'DRAFT_ONLY' | 'NUMBERING';

export function fieldLock(field: UpdatableProcessField, context: FieldLockContext): FieldLock {
  if (!isEditableStatus(context.status)) return 'STATUS';
  if ((DRAFT_ONLY_PROCESS_FIELDS as readonly string[]).includes(field)) {
    if (context.status !== 'DRAFT') return 'DRAFT_ONLY';
    if (field === 'organizationId' && context.numbered && context.numberingDependsOnOrganization) {
      return 'NUMBERING';
    }
  }
  return 'EDITABLE';
}

/** RN-PROC-61: a numeração do processo depende do órgão (escopo ou token `{org}` da máscara). */
export function numberingDependsOnOrganization(settings: {
  readonly processScope: string;
  readonly processMask: string;
}): boolean {
  return settings.processScope === 'ORGANIZATION' || settings.processMask.includes('{org}');
}

/** V-02 (RN-PROC-60/61): `NOT_ALLOWED` em cada campo alterado que está bloqueado. */
export function lockIssues(changes: ProcessChangeSet, context: FieldLockContext): ProcessIssue[] {
  return changes.changes.flatMap(({ field }): ProcessIssue[] => {
    const lock = fieldLock(field, context);
    if (lock === 'EDITABLE') return [];
    return [
      {
        field,
        code: 'NOT_ALLOWED',
        message:
          lock === 'NUMBERING'
            ? PROCESS_UPDATE_MESSAGES.lockedByNumbering
            : PROCESS_UPDATE_MESSAGES.lockedByStatus,
      },
    ];
  });
}

/** DEC-032: fonte de maior precedência que o valor manual (`DFD`, `ETP`, `PRICE_RESEARCH`, `TERM`). */
export function hasHigherPrecedenceSource(
  source: EstimatedValueSource | null,
): source is Exclude<EstimatedValueSource, 'MANUAL'> {
  return source !== null && source !== 'MANUAL';
}

/**
 * `EstimatedValuePolicy` (RN-PROC-63 · V-07): a fonte que impede a alteração manual do valor
 * estimado, ou `null` quando o valor pode ser alterado (sem fonte ou `MANUAL`).
 */
export function estimatedValueLockedBy(
  process: Pick<Process, 'estimatedValueSource'>,
  changes: ProcessChangeSet,
): EstimatedValueSource | null {
  if (!changes.changes.some((change) => change.field === 'estimatedValue')) return null;
  return hasHigherPrecedenceSource(process.estimatedValueSource)
    ? process.estimatedValueSource
    : null;
}

export interface RevalidationContext {
  /** Hoje (`YYYY-MM-DD`) no fuso do tenant. */
  readonly today: string;
  readonly currentYear: number;
  /** `process.requireInternalCode` (RN-PROC-70 · V-12). */
  readonly requireInternalCode: boolean;
}

/**
 * RN-PROC-64: regras de US-001 sobre o estado resultante, SÓ para os campos enviados e as regras
 * cruzadas que eles afetam (PCA). Datas e referências não alteradas não são revalidadas.
 */
export function revalidationIssues(
  changes: ProcessChangeSet,
  context: RevalidationContext,
): ProcessIssue[] {
  const { next, sent } = changes;
  const changed = new Set(changes.changes.map((change) => change.field));
  const issues: ProcessIssue[] = [];
  if (PCA_FIELDS.some((field) => sent.has(field))) {
    for (const issue of pcaIssues(next)) {
      issues.push({ field: issue.path, code: 'CONDITIONAL_REQUIRED', message: issue.message });
    }
  }
  const dated = processDateIssues(
    {
      targetDate: changed.has('targetDate') ? next.targetDate : null,
      pcaStatus: next.pcaStatus,
      pcaYear: changed.has('pcaYear') || changed.has('pcaStatus') ? next.pcaYear : null,
    },
    context,
  );
  for (const issue of dated) {
    issues.push({
      field: issue.path,
      code: issue.path === 'targetDate' ? 'DATE_IN_PAST' : 'OUT_OF_RANGE',
      message: issue.message,
    });
  }
  if (context.requireInternalCode && changed.has('internalCode') && next.internalCode === null) {
    issues.push({
      field: 'internalCode',
      code: 'REQUIRED',
      message: PROCESS_UPDATE_MESSAGES.internalCodeRequired,
    });
  }
  // RN-PROC-61: trocar o órgão exige secretaria e setor do novo órgão na mesma requisição.
  if (changed.has('organizationId')) {
    for (const field of ['requestingSecretariatId', 'requestingDepartmentId'] as const) {
      if (!sent.has(field)) {
        issues.push({
          field,
          code: 'CONDITIONAL_REQUIRED',
          message: PROCESS_UPDATE_MESSAGES.organizationNeedsUnits,
        });
      }
    }
  }
  return issues;
}

/** RN-PROC-63: a origem do valor depois da alteração manual (informado → `MANUAL`; limpo → nula). */
function sourceAfter(process: Process, changes: ProcessChangeSet): EstimatedValueSource | null {
  if (!changes.changes.some((change) => change.field === 'estimatedValue')) {
    return process.estimatedValueSource;
  }
  return changes.next.estimatedValue === null ? null : 'MANUAL';
}

/** `Process.applyChanges`: o agregado com o estado resultante e a nova versão (RN-PROC-66). */
export function applyProcessChanges(
  process: Process,
  changes: ProcessChangeSet,
  context: { readonly now: Date; readonly userId: string },
): Process {
  return {
    ...process,
    ...changes.next,
    estimatedValueSource: sourceAfter(process, changes),
    updatedAt: context.now,
    updatedById: context.userId,
    version: process.version + 1,
  };
}

/** POL-01: responsável atual ou, na fila da unidade (sem responsável), lotado na unidade atual. */
export function isProcessCustodian(
  process: Pick<Process, 'currentResponsibleId' | 'currentDepartmentId'>,
  viewer: { readonly userId: string; readonly departmentIds: readonly string[] },
): boolean {
  return process.currentResponsibleId === null
    ? viewer.departmentIds.includes(process.currentDepartmentId)
    : process.currentResponsibleId === viewer.userId;
}

/** Mensagem de status não editável (FA-02): "aguarda aprovação" ou o status atual. */
export function notEditableStatusMessage(status: ProcessStatus): string {
  if (status === 'AWAITING_APPROVAL') return PROCESS_UPDATE_MESSAGES.awaitingApproval;
  const labels: Partial<Record<ProcessStatus, string>> = {
    SUSPENDED: 'suspenso',
    CANCELED: 'cancelado',
    COMPLETED: 'concluído',
    PUBLISHED: 'publicado',
  };
  return `Não é possível editar com o processo ${labels[status] ?? status}.`;
}

import {
  PROCESS_ASSIGN_LIMITS,
  TASK_BULK_LIMITS,
  TASK_BULK_MESSAGES,
} from '@contrataflow/validation';
import type { BulkResultResponse, TaskInboxItemDto } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras de tela das ações em lote (US-058 · SCR-013/SCR-115), puras: o que pode ser selecionado,
 * o teto de 50 (FA-01), o diálogo de atribuição em lote, o resumo por item (FA-02) e o que a UI faz
 * em cada recusa do lote inteiro (tabela "Casos de erro").
 */

/**
 * O que a seleção guarda de cada linha (sobrevive à troca de página e ao polling). US-125: a
 * chave é a da LINHA (`rowKey` — um processo pode ter uma linha por ramo); a linha de ramo leva a
 * etapa (`processStageId`), e o lote passa a ir no formato `items[]` (RN-WF2-32).
 */
export interface BulkSelectedItem {
  readonly key: string;
  readonly processId: string;
  /** Etapa da linha de ramo; `null` na linha do processo (MVP 1). */
  readonly processStageId: string | null;
  readonly code: string | null;
  readonly title: string;
  readonly departmentId: string;
}

export type BulkSelection = ReadonlyMap<string, BulkSelectedItem>;

export const EMPTY_SELECTION: BulkSelection = new Map();

/** Só linhas sem responsável entram no lote (fila da unidade). */
export function isSelectable(item: TaskInboxItemDto): boolean {
  return item.currentResponsible === null;
}

/** Chave da linha na seleção (US-125): o `rowKey` da API; o processo nas respostas do MVP 1. */
export function rowKeyOf(item: Pick<TaskInboxItemDto, 'rowKey' | 'processId'>): string {
  return item.rowKey ?? item.processId;
}

export function selectedItemOf(item: TaskInboxItemDto): BulkSelectedItem {
  const branched = (item.branchKey ?? null) !== null;
  return {
    key: rowKeyOf(item),
    processId: item.processId,
    processStageId: branched ? (item.processStageId ?? null) : null,
    code: item.code,
    title: item.title,
    departmentId: item.currentDepartment.id,
  };
}

/**
 * O corpo do lote (RN-WF2-32): só linhas do processo → `processIds` (MVP 1); com alguma linha de
 * ramo → `items[]` com o par processo/etapa de cada linha.
 */
export function bulkTargetsBody(
  selection: BulkSelection,
):
  | { readonly processIds: string[] }
  | { readonly items: { readonly processId: string; readonly processStageId: string }[] } {
  const selected = [...selection.values()];
  if (selected.every((item) => item.processStageId === null)) {
    return { processIds: selected.map((item) => item.processId) };
  }
  return {
    items: selected.flatMap((item) =>
      item.processStageId === null
        ? []
        : [{ processId: item.processId, processStageId: item.processStageId }],
    ),
  };
}

/** FA-01: chegou ao teto, novas seleções ficam desabilitadas. */
export function isFull(selection: BulkSelection): boolean {
  return selection.size >= TASK_BULK_LIMITS.max;
}

/** Marca/desmarca uma linha; acima de 50 não marca (FA-01). */
export function toggleSelection(selection: BulkSelection, item: BulkSelectedItem): BulkSelection {
  const next = new Map(selection);
  if (next.has(item.key)) next.delete(item.key);
  else if (!isFull(selection)) next.set(item.key, item);
  return next;
}

/** "Selecionar todos da página": marca os que cabem até 50; se todos já estão, desmarca a página. */
export function togglePage(
  selection: BulkSelection,
  items: readonly BulkSelectedItem[],
): BulkSelection {
  const next = new Map(selection);
  if (items.length > 0 && items.every((item) => next.has(item.key))) {
    for (const item of items) next.delete(item.key);
    return next;
  }
  for (const item of items) {
    if (next.size >= TASK_BULK_LIMITS.max) break;
    next.set(item.key, item);
  }
  return next;
}

/** V-01: os botões só enviam com 2 ou mais. */
export function canSubmit(selection: BulkSelection): boolean {
  return selection.size >= TASK_BULK_LIMITS.min && selection.size <= TASK_BULK_LIMITS.max;
}

/**
 * Atribuir em lote: a lista de responsáveis é a da unidade atual (USR-02 com `departmentId`) — só
 * existe uma lista quando todos os selecionados estão na mesma unidade.
 */
export function sharedDepartmentOf(selection: BulkSelection): string | null {
  const departments = new Set([...selection.values()].map((item) => item.departmentId));
  const [only] = [...departments];
  return departments.size === 1 && only !== undefined ? only : null;
}

export interface BulkAssignDraft {
  readonly assigneeId: string;
  readonly reason: string;
}

export interface BulkAssignErrors {
  readonly assignee?: string;
  readonly reason?: string;
}

/** V-04 no cliente (as mesmas mensagens e limites da API). Vazio = pode enviar. */
export function validateBulkAssign(draft: BulkAssignDraft): BulkAssignErrors {
  const errors: { assignee?: string; reason?: string } = {};
  if (draft.assigneeId === '') errors.assignee = TASK_BULK_MESSAGES.assignRequired;
  const length = draft.reason.trim().length;
  if (length === 0) errors.reason = TASK_BULK_MESSAGES.assignRequired;
  else if (length < PROCESS_ASSIGN_LIMITS.reasonMin) {
    errors.reason = TASK_BULK_MESSAGES.reasonTooShort;
  } else if (length > PROCESS_ASSIGN_LIMITS.reasonMax) {
    errors.reason = TASK_BULK_MESSAGES.reasonTooLong;
  }
  return errors;
}

export type BulkOutcomeKind = 'success' | 'partial' | 'failure';

export interface BulkItemProblem {
  /** Chave da linha na seleção (US-125: um processo pode ter duas linhas no lote). */
  readonly key: string;
  readonly processId: string;
  /** Código do processo (ou o título, quando ainda sem número). */
  readonly label: string;
  readonly code: string;
  readonly message: string;
}

export interface BulkSummary {
  readonly kind: BulkOutcomeKind;
  readonly total: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly problems: readonly BulkItemProblem[];
  /** As chaves das linhas bem-sucedidas (saem da fila e da seleção). */
  readonly succeeded: readonly string[];
}

/** A chave da seleção de um resultado: a linha do ramo (`items[]`) ou o processo. */
function resultKeyOf(item: BulkResultResponse['data'][number], selection: BulkSelection): string {
  const byStage = [...selection.values()].find(
    (selected) =>
      selected.processId === item.processId &&
      item.processStageId !== undefined &&
      selected.processStageId === item.processStageId,
  );
  return byStage?.key ?? item.processId;
}

/** FA-02: todos falharam = falha total, a lista fica como está. */
export function summarizeBulk(result: BulkResultResponse, selection: BulkSelection): BulkSummary {
  const { successCount, errorCount } = result.meta;
  return {
    kind: errorCount === 0 ? 'success' : successCount === 0 ? 'failure' : 'partial',
    total: result.data.length,
    successCount,
    errorCount,
    succeeded: result.data.filter((item) => item.ok).map((item) => resultKeyOf(item, selection)),
    problems: result.data
      .filter((item) => !item.ok)
      .map((item) => {
        const key = resultKeyOf(item, selection);
        const selected = selection.get(key);
        return {
          key,
          processId: item.processId,
          label: selected?.code ?? selected?.title ?? item.processId,
          code: item.code ?? 'INTERNAL_ERROR',
          message: item.message ?? '',
        };
      }),
  };
}

/** Recusa do lote inteiro (sem resultado por item). */
export type BulkProblem =
  | { readonly kind: 'tooShort' }
  | { readonly kind: 'tooLong' }
  | { readonly kind: 'field'; readonly message: string }
  | { readonly kind: 'denied' }
  | { readonly kind: 'reused' }
  | { readonly kind: 'inProgress' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function describeBulkError(error: unknown): BulkProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 403) return { kind: 'denied' };
  if (code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'reused' };
  if (code === 'IDEMPOTENCY_IN_PROGRESS') return { kind: 'inProgress' };
  if (code === 'VALIDATION_ERROR') {
    const [first] = error.errors;
    if (first?.field === 'processIds' && first.code === 'TOO_SHORT') return { kind: 'tooShort' };
    if (first?.field === 'processIds' && first.code === 'TOO_LONG') return { kind: 'tooLong' };
    return { kind: 'field', message: first?.message ?? TASK_BULK_MESSAGES.assignRequired };
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}

import {
  TASK_INBOX_COUNTER_KEYS,
  TASK_INBOX_VIEWS,
  formatTaskInboxSort,
  parseTaskInboxSort,
  taskInboxSortFieldsOf,
} from '@contrataflow/validation';
import type { TaskInboxCountersDto, TaskInboxSort, TaskInboxView } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras de tela da caixa de tarefas (US-056 · SCR-013), puras: abas visíveis (FA-01), ordenação
 * por visão (RN-INBOX-10 — a troca de aba mantém a ordenação), contador de cada aba e o que a UI
 * faz em cada falha da consulta e do "Assumir" (tabela "Casos de erro").
 */

export const DEFAULT_SORT: TaskInboxSort = { field: 'dueAt', direction: 'desc' };

/** FA-01: "Na fila da minha unidade" só aparece quando TSK-02 traz `unitQueue`. */
export function visibleTabs(counters: TaskInboxCountersDto | undefined): TaskInboxView[] {
  return TASK_INBOX_VIEWS.filter(
    (view) => view !== 'UNIT_QUEUE' || counters?.unitQueue !== undefined,
  );
}

export function counterOf(
  counters: TaskInboxCountersDto | undefined,
  view: TaskInboxView,
): number | undefined {
  return counters?.[TASK_INBOX_COUNTER_KEYS[view]];
}

/** A ordenação vale na nova aba; "entrada na etapa" ↔ "solicitação" conforme a visão. */
export function sortForView(sort: TaskInboxSort, view: TaskInboxView): TaskInboxSort {
  const fields = taskInboxSortFieldsOf(view);
  if (fields.includes(sort.field)) return sort;
  if (sort.field === 'enteredAt' || sort.field === 'requestedAt') {
    return {
      field: view === 'PENDING_APPROVALS' ? 'requestedAt' : 'enteredAt',
      direction: sort.direction,
    };
  }
  return DEFAULT_SORT;
}

/** Opções do seletor de ordenação da visão (texto do parâmetro `sort`). */
export function sortOptions(view: TaskInboxView): string[] {
  return taskInboxSortFieldsOf(view).flatMap((field) => [
    formatTaskInboxSort({ field, direction: field === 'dueAt' ? 'desc' : 'asc' }),
    formatTaskInboxSort({ field, direction: field === 'dueAt' ? 'asc' : 'desc' }),
  ]);
}

export function parseSortOption(value: string, view: TaskInboxView): TaskInboxSort {
  return parseTaskInboxSort(value, view) ?? DEFAULT_SORT;
}

export type InboxLoadProblem =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function describeLoadError(error: unknown): InboxLoadProblem {
  if (!isApiError(error)) return { kind: 'unavailable' };
  if (error.status === 429) return { kind: 'rateLimited' };
  if (error.status >= 500 && error.status !== 503) {
    return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
  }
  return { kind: 'unavailable' };
}

export type QuickClaimProblem =
  | { readonly kind: 'alreadyAssigned' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'status' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** FA-04 e "Casos de erro" do "Assumir" (PRC-21); toda falha recarrega a lista e os contadores. */
export function describeQuickClaimError(error: unknown): QuickClaimProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 409 && code === 'PROCESS_ALREADY_ASSIGNED') return { kind: 'alreadyAssigned' };
  if (status === 409) return { kind: 'status' };
  if (status === 412) return { kind: 'changed' };
  if (status === 428) return { kind: 'reload' };
  if (status === 403) return { kind: 'denied' };
  if (status === 404) return { kind: 'notFound' };
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}

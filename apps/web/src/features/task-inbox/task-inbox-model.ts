import {
  TASK_INBOX_COUNTER_KEYS,
  TASK_INBOX_VIEWS,
  formatTaskInboxSort,
  parseTaskInboxSort,
  taskInboxSortFieldsOf,
} from '@contrataflow/validation';
import type {
  TaskInboxCountersDto,
  TaskInboxItemDto,
  TaskInboxSort,
  TaskInboxView,
} from '@contrataflow/validation';

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

/** Chave da mensagem `taskInbox.deadline.*` do chip de prazo. */
export type InboxDeadlineKey =
  | 'overdue'
  | 'overdueCalendar'
  | 'overdueUnknown'
  | 'overduePaused'
  | 'paused'
  | 'dueToday'
  | 'dueIn'
  | 'dueInCalendar'
  | 'none';

export interface InboxDeadline {
  readonly key: InboxDeadlineKey;
  readonly count: number;
  readonly tone: 'danger' | 'warning' | 'neutral';
}

/**
 * Um só chip de prazo por linha (prd-5 · regra 3): o atraso da etapa (`deadline.isOverdue`) e o
 * marcado pelo job (`isOverdue`/`overdueSince`) viram "Atrasado · N dias úteis"; senão "Vence
 * hoje" ou "Vence em N dias", com âmbar quando está perto (`isDueSoon`).
 */
export function inboxDeadlineOf(
  item: Pick<TaskInboxItemDto, 'deadline' | 'isOverdue' | 'overdueSince'>,
): InboxDeadline {
  const { deadline } = item;
  const calendar = deadline.slaType === 'CALENDAR';
  if (deadline.isPaused) {
    return item.overdueSince === null
      ? { key: 'paused', count: 0, tone: 'neutral' }
      : { key: 'overduePaused', count: 0, tone: 'danger' };
  }
  if (deadline.isOverdue || item.isOverdue) {
    return deadline.overdueDays === null
      ? { key: 'overdueUnknown', count: 0, tone: 'danger' }
      : {
          key: calendar ? 'overdueCalendar' : 'overdue',
          count: deadline.overdueDays,
          tone: 'danger',
        };
  }
  if (deadline.dueAt === null || deadline.daysLeft === null) {
    return { key: 'none', count: 0, tone: 'neutral' };
  }
  if (deadline.daysLeft === 0) return { key: 'dueToday', count: 0, tone: 'warning' };
  return {
    key: calendar ? 'dueInCalendar' : 'dueIn',
    count: deadline.daysLeft,
    tone: deadline.isDueSoon ? 'warning' : 'neutral',
  };
}

/** Responsável "sem responsável" no filtro local. */
export const NO_RESPONSIBLE = 'none';

/**
 * Refino da aba carregada (busca e filtros do popover). TSK-01 não aceita busca nem filtros — a
 * API só recebe visão, ordenação e página —, então o refino vale para as linhas desta página.
 */
export interface InboxRefine {
  readonly q: string;
  readonly departmentId: string | null;
  readonly stageKey: string | null;
  readonly responsibleId: string | null;
}

export const EMPTY_REFINE: InboxRefine = {
  q: '',
  departmentId: null,
  stageKey: null,
  responsibleId: null,
};

export type InboxRefineFilter = Exclude<keyof InboxRefine, 'q'>;

/** Filtros do popover ativos (o número do botão "Filtros"). */
export function activeRefineFilters(refine: InboxRefine): InboxRefineFilter[] {
  return (['departmentId', 'stageKey', 'responsibleId'] as const).filter(
    (key) => refine[key] !== null,
  );
}

export function isRefined(refine: InboxRefine): boolean {
  return refine.q.trim() !== '' || activeRefineFilters(refine).length > 0;
}

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Linhas que passam pela busca (código, título, aprovação) e pelos filtros do popover. */
export function refineItems(
  items: readonly TaskInboxItemDto[],
  refine: InboxRefine,
): TaskInboxItemDto[] {
  const q = normalize(refine.q.trim());
  return items.filter((item) => {
    if (refine.departmentId !== null && item.currentDepartment.id !== refine.departmentId) {
      return false;
    }
    if (refine.stageKey !== null && item.currentStage?.key !== refine.stageKey) return false;
    if (refine.responsibleId !== null) {
      const responsible = item.currentResponsible?.id ?? NO_RESPONSIBLE;
      if (responsible !== refine.responsibleId) return false;
    }
    if (q === '') return true;
    return [item.code ?? '', item.title, item.approval?.title ?? ''].some((text) =>
      normalize(text).includes(q),
    );
  });
}

export interface RefineOption {
  readonly value: string;
  readonly label: string;
}

/** Opções dos filtros: as unidades, etapas e responsáveis presentes nas linhas carregadas. */
export function refineOptionsOf(items: readonly TaskInboxItemDto[]): {
  readonly departments: RefineOption[];
  readonly stages: RefineOption[];
  readonly responsibles: RefineOption[];
  readonly hasUnassigned: boolean;
} {
  const unique = (pairs: readonly (RefineOption | null)[]) =>
    [
      ...new Map(pairs.flatMap((pair) => (pair ? [[pair.value, pair] as const] : []))).values(),
    ].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  return {
    departments: unique(
      items.map((item) => ({
        value: item.currentDepartment.id,
        label: item.currentDepartment.name,
      })),
    ),
    stages: unique(
      items.map((item) =>
        item.currentStage ? { value: item.currentStage.key, label: item.currentStage.name } : null,
      ),
    ),
    responsibles: unique(
      items.map((item) =>
        item.currentResponsible
          ? { value: item.currentResponsible.id, label: item.currentResponsible.name }
          : null,
      ),
    ),
    hasUnassigned: items.some((item) => item.currentResponsible === null),
  };
}

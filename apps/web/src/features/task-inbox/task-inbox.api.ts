import type {
  PageMeta,
  TaskInboxCountersDto,
  TaskInboxItemDto,
  TaskInboxSort,
  TaskInboxView,
} from '@contrataflow/validation';
import {
  TASK_INBOX_DEFAULT_PAGE_SIZE,
  TASK_INBOX_POLL_INTERVAL_MS,
  formatTaskInboxSort,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Leituras da caixa de tarefas (US-056 · SCR-013): TSK-01 (aba ativa) e TSK-02 (contadores), em
 * paralelo, sob a raiz `['t', tenantId, 'tasks']` — a mesma que as ações de tramitação invalidam.
 * RN-INBOX-13: as duas repetem a cada 60 s só com a aba do navegador visível (o TanStack Query
 * suspende o intervalo em segundo plano) e atualizam ao voltar o foco (FA-06); a nova leitura da
 * mesma chave mantém os dados na tela (sem perder rolagem nem seleção).
 */

export const taskInboxKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'tasks'),
  list: (tenantId: string, view: TaskInboxView, sort: string, page: number) =>
    tenantKey(tenantId, 'tasks', 'list', { view, sort, page }),
  counters: (tenantId: string) => tenantKey(tenantId, 'tasks', 'counters'),
};

export interface TaskInboxPage {
  readonly items: TaskInboxItemDto[];
  readonly meta: PageMeta;
}

/** TSK-01. */
export async function fetchTaskInbox(
  query: { readonly view: TaskInboxView; readonly sort: TaskInboxSort; readonly page: number },
  signal?: AbortSignal,
): Promise<TaskInboxPage> {
  const result = await apiRequest<TaskInboxItemDto[]>('/tasks', {
    query: {
      view: query.view,
      sort: formatTaskInboxSort(query.sort),
      page: query.page,
      pageSize: TASK_INBOX_DEFAULT_PAGE_SIZE,
    },
    signal,
  });
  const meta = result.meta as unknown as PageMeta;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    meta: {
      page: meta.page,
      pageSize: meta.pageSize,
      totalItems: meta.totalItems,
      totalPages: meta.totalPages,
    },
  };
}

/** TSK-02. */
export async function fetchTaskInboxCounters(signal?: AbortSignal): Promise<TaskInboxCountersDto> {
  return (await apiRequest<TaskInboxCountersDto>('/tasks/counters', { signal })).data;
}

const pollingOptions = {
  refetchInterval: TASK_INBOX_POLL_INTERVAL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  throwOnError: false,
  retry: false,
} as const;

export function useTaskInbox(
  view: TaskInboxView,
  sort: TaskInboxSort,
  page: number,
  enabled: boolean,
) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: taskInboxKeys.list(tenantId, view, formatTaskInboxSort(sort), page),
    queryFn: ({ signal }) => fetchTaskInbox({ view, sort, page }, signal),
    enabled,
    ...pollingOptions,
  });
}

export function useTaskInboxCounters(enabled: boolean) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: taskInboxKeys.counters(tenantId),
    queryFn: ({ signal }) => fetchTaskInboxCounters(signal),
    enabled,
    ...pollingOptions,
  });
}

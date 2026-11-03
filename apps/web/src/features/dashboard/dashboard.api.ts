import type {
  DashboardCacheMeta,
  DashboardFilters,
  DashboardSummaryDto,
  DashboardWidgetDto,
  DashboardWidgetKey,
  DepartmentDto,
  TaskInboxItemDto,
  TaskInboxView,
} from '@contrataflow/validation';
import { DASHBOARD_POLL_INTERVAL_MS } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { APPROVALS_PREVIEW_SIZE, PENDING_PREVIEW_SIZE } from './dashboard-model';

/*
 * Leituras do painel (US-076 · SCR-003): DSH-01 (resumo) e DSH-02 (um indicador por cartão), com
 * as chaves `['t', tenantId, 'dashboard', 'summary' | 'widget', …, filters]`. Cada cartão busca e
 * falha sozinho; todos repetem a cada 60 s só com a aba do navegador visível (mesma cadência de
 * TSK-02) e mantêm os dados na tela durante a nova leitura. As opções do filtro vêm de DEP-01.
 */

export const dashboardKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'dashboard'),
  summary: (tenantId: string, filters: DashboardFilters) =>
    tenantKey(tenantId, 'dashboard', 'summary', filters),
  widget: (tenantId: string, widgetKey: DashboardWidgetKey, filters: DashboardFilters) =>
    tenantKey(tenantId, 'dashboard', 'widget', widgetKey, filters),
  units: (tenantId: string) => tenantKey(tenantId, 'dashboard', 'units'),
  /** Sob a raiz `tasks`: as ações de tramitação que invalidam a caixa também a renovam. */
  pendingPreview: (tenantId: string) =>
    tenantKey(tenantId, 'tasks', 'preview', { view: 'MINE', sort: 'dueAt' }),
  approvalsPreview: (tenantId: string) =>
    tenantKey(tenantId, 'tasks', 'preview', { view: 'PENDING_APPROVALS', sort: 'dueAt' }),
};

export interface DashboardRead<T> {
  readonly data: T;
  readonly cache: DashboardCacheMeta | undefined;
}

const queryOf = (filters: DashboardFilters) => ({
  secretariatId: filters.secretariatId,
  departmentId: filters.departmentId,
});

/** DSH-01. */
export async function fetchDashboardSummary(
  filters: DashboardFilters,
  signal?: AbortSignal,
): Promise<DashboardRead<DashboardSummaryDto>> {
  const result = await apiRequest<DashboardSummaryDto>('/dashboard/summary', {
    query: queryOf(filters),
    signal,
  });
  return { data: result.data, cache: result.meta.cache as DashboardCacheMeta | undefined };
}

/** DSH-02. */
export async function fetchDashboardWidget(
  widgetKey: DashboardWidgetKey,
  filters: DashboardFilters,
  signal?: AbortSignal,
): Promise<DashboardRead<DashboardWidgetDto>> {
  const result = await apiRequest<DashboardWidgetDto>(`/dashboard/widgets/${widgetKey}`, {
    query: queryOf(filters),
    signal,
  });
  return { data: result.data, cache: result.meta.cache as DashboardCacheMeta | undefined };
}

interface PageMeta {
  readonly totalItems?: number;
}

const PAGE_SIZE = 100;

/** DEP-01: unidades ativas do tenant (todas as do órgão), na ordem da árvore. */
export async function fetchDashboardUnits(signal?: AbortSignal): Promise<DepartmentDto[]> {
  const all: DepartmentDto[] = [];
  for (let page = 1; ; page += 1) {
    const result = await apiRequest<DepartmentDto[]>('/departments', {
      query: { isActive: true, page, pageSize: PAGE_SIZE },
      signal,
    });
    all.push(...result.data);
    const total = (result.meta as PageMeta | undefined)?.totalItems ?? all.length;
    if (result.data.length < PAGE_SIZE || all.length >= total) {
      return all.filter((unit) => unit.isActive);
    }
  }
}

/**
 * TSK-01 na visão "Comigo", só a primeira página curta e pelo prazo mais próximo: os itens de
 * "Minhas pendências" sem endpoint novo (prd-4 · sem alteração de contrato).
 */
export async function fetchPendingPreview(signal?: AbortSignal): Promise<TaskInboxItemDto[]> {
  return fetchTaskPreview('MINE', PENDING_PREVIEW_SIZE, signal);
}

/** TSK-01 na visão "Aprovações pendentes": os itens do cartão "Aprovações" (prd-6 §2.5). */
export async function fetchApprovalsPreview(signal?: AbortSignal): Promise<TaskInboxItemDto[]> {
  return fetchTaskPreview('PENDING_APPROVALS', APPROVALS_PREVIEW_SIZE, signal);
}

async function fetchTaskPreview(
  view: TaskInboxView,
  size: number,
  signal?: AbortSignal,
): Promise<TaskInboxItemDto[]> {
  const result = await apiRequest<TaskInboxItemDto[]>('/tasks', {
    query: { view, sort: 'dueAt', page: 1, pageSize: size },
    signal,
  });
  return Array.isArray(result.data) ? result.data.slice(0, size) : [];
}

const pollingOptions = {
  refetchInterval: DASHBOARD_POLL_INTERVAL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  throwOnError: false,
  retry: false,
} as const;

export function useDashboardSummary(filters: DashboardFilters, enabled: boolean) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: dashboardKeys.summary(tenantId, filters),
    queryFn: ({ signal }) => fetchDashboardSummary(filters, signal),
    enabled,
    ...pollingOptions,
  });
}

export function useDashboardWidget(
  widgetKey: DashboardWidgetKey,
  filters: DashboardFilters,
  enabled: boolean,
) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: dashboardKeys.widget(tenantId, widgetKey, filters),
    queryFn: ({ signal }) => fetchDashboardWidget(widgetKey, filters, signal),
    enabled,
    ...pollingOptions,
  });
}

/** Unidades mudam pouco: mesma janela de catálogos (architecture.md §8.5). */
export function useDashboardUnits(enabled: boolean) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: dashboardKeys.units(tenantId),
    queryFn: ({ signal }) => fetchDashboardUnits(signal),
    enabled,
    staleTime: 5 * 60_000,
    throwOnError: false,
  });
}

/** Itens de "Minhas pendências"; só com `INBOX_VIEW` (sem ela, o cartão fica nas contagens). */
export function usePendingPreview(enabled: boolean) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: dashboardKeys.pendingPreview(tenantId),
    queryFn: ({ signal }) => fetchPendingPreview(signal),
    enabled,
    ...pollingOptions,
  });
}

/** Itens do cartão "Aprovações"; só com `INBOX_VIEW` (a mesma leitura da caixa de tarefas). */
export function useApprovalsPreview(enabled: boolean) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: dashboardKeys.approvalsPreview(tenantId),
    queryFn: ({ signal }) => fetchApprovalsPreview(signal),
    enabled,
    ...pollingOptions,
  });
}

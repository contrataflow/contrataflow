import type { ApprovalListItemDto, PageMeta } from '@contrataflow/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Leitura da lista de aprovações (US-057 · SCR-014): APV-01 sob a raiz `['t', tenantId,
 * 'approvals']` — a mesma que a decisão (SCR-015 · APV-03) invalida, então a linha decidida sai do
 * filtro `PENDING` ao voltar (passo 6). Atualiza ao focar a janela (FA-03); a página anterior fica
 * na tela durante a nova leitura e enquanto o período está inválido (V-02 — sem chamada).
 */

export const approvalListKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'approvals'),
  list: (tenantId: string, query: Readonly<Record<string, string | number | undefined>>) =>
    tenantKey(tenantId, 'approvals', 'list', query),
};

export interface ApprovalListPage {
  readonly items: ApprovalListItemDto[];
  readonly meta: PageMeta;
}

/** APV-01. */
export async function fetchApprovalList(
  query: Readonly<Record<string, string | number | undefined>>,
  signal?: AbortSignal,
): Promise<ApprovalListPage> {
  const result = await apiRequest<ApprovalListItemDto[]>('/approvals', { query, signal });
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

export function useApprovalList(
  query: Readonly<Record<string, string | number | undefined>>,
  enabled: boolean,
) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: approvalListKeys.list(tenantId, query),
    queryFn: ({ signal }) => fetchApprovalList(query, signal),
    enabled,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    throwOnError: false,
    retry: false,
  });
}

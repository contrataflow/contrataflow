import type { ProcessStageEntryDto, ProcessSummaryDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { useCallback } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Painel situacional do processo (US-004 · SCR-006): PRC-07 (`summary`) e PRC-10 (`stages`) de
 * api/02-processes.md; PRC-04 fica em `processes` e PRC-08/09 em `process-actions`. Chaves
 * `['t', tenantId, 'processes', id, 'detail'|'summary'|'actions'|'stages'|'checklist']`
 * (RN-FND-90). RN-PROC-56: refaz ao focar a janela e a cada 60 s com a aba visível, mantendo os
 * dados anteriores; 429 suspende a sondagem até o `Retry-After`.
 */

export const panelKeys = {
  all: (tenantId: string, processId: string) => tenantKey(tenantId, 'processes', processId),
  detail: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'detail'),
  summary: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'summary'),
  stages: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'stages'),
};

/** Sondagem do painel com a aba visível (RN-PROC-56). */
export const PANEL_REFETCH_MS = 60_000;

/** PRC-07 — as 7 perguntas de DEC-180. */
export async function fetchProcessSummary(
  processId: string,
  signal?: AbortSignal,
): Promise<ProcessSummaryDto> {
  const result = await apiRequest<ProcessSummaryDto>(`/processes/${processId}/summary`, {
    signal,
  });
  return result.data;
}

/** PRC-10 — etapas da versão fixada e passagens. */
export async function fetchProcessStages(
  processId: string,
  signal?: AbortSignal,
): Promise<ProcessStageEntryDto[]> {
  const result = await apiRequest<ProcessStageEntryDto[]>(`/processes/${processId}/stages`, {
    signal,
  });
  return Array.isArray(result.data) ? result.data : [];
}

/** 429: a sondagem para até o `Retry-After` (sem martelar a API — "Casos de erro"). */
export function panelRefetchInterval(
  query: Pick<Query, 'state'>,
  now: number = Date.now(),
): number | false {
  const { error, errorUpdatedAt } = query.state;
  if (isApiError(error) && error.status === 429) {
    const waitMs = (error.retryAfterSeconds ?? 60) * 1000;
    return errorUpdatedAt + waitMs > now ? false : PANEL_REFETCH_MS;
  }
  return PANEL_REFETCH_MS;
}

/** Opções comuns das consultas do painel: o erro fica no bloco, nunca derruba a tela. */
const panelQueryOptions = {
  refetchOnWindowFocus: true,
  refetchInterval: panelRefetchInterval,
  placeholderData: <T>(previous: T | undefined) => previous,
  throwOnError: false,
} as const;

export function useProcessSummary(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: panelKeys.summary(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessSummary(processId, signal),
    ...panelQueryOptions,
  });
}

export function useProcessStages(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: panelKeys.stages(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessStages(processId, signal),
    ...panelQueryOptions,
  });
}

/** FA-11: comando recusado por dado desatualizado (vindo das stories donas dos diálogos). */
export function isStaleProcessError(error: unknown): boolean {
  return (
    isApiError(error) &&
    ((error.status === 409 && error.code === 'STAGE_CHANGED') ||
      (error.status === 412 && error.code === 'VERSION_CONFLICT') ||
      (error.status === 403 && error.code === 'NOT_PROCESS_CUSTODIAN'))
  );
}

/** Invalida TODAS as consultas do processo (detalhe, resumo, ações, etapas, checklist…). */
export function useInvalidateProcess(processId: string): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: panelKeys.all(tenantId, processId) }),
    [queryClient, tenantId, processId],
  );
}

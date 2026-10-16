import type { ActionEntry, ChecklistViolation, ProcessChecklist } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Painel situacional do processo — leituras do motor de workflow (US-041 · PRC-08/PRC-09 de
 * api/02-processes.md). Chaves `['t', tenantId, 'processes', id, …]` (RN-FND-90). Sondagem
 * silenciosa: falha pontual mantém o que já está na tela (o TanStack conserva `data` no erro) e
 * não renova a ociosidade da sessão (`POLLING_PATTERNS` — RN-IAM-21).
 */

export const processActionKeys = {
  all: (tenantId: string, processId: string) => tenantKey(tenantId, 'processes', processId),
  actions: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'available-actions'),
  checklist: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'checklist'),
};

/** Intervalo da sondagem do painel (só com a aba em foco). */
export const PROCESS_PANEL_REFETCH_MS = 30_000;

/** PRC-08 — ações na ordem da API (avanços com a principal primeiro, devoluções, ciclo de vida). */
export async function fetchAvailableActions(
  processId: string,
  signal?: AbortSignal,
): Promise<ActionEntry[]> {
  const result = await apiRequest<ActionEntry[]>(`/processes/${processId}/available-actions`, {
    signal,
  });
  return Array.isArray(result.data) ? result.data : [];
}

/** PRC-09 — pendências da etapa atual. */
export async function fetchProcessChecklist(
  processId: string,
  signal?: AbortSignal,
): Promise<ChecklistViolation[]> {
  const result = await apiRequest<ProcessChecklist | undefined>(
    `/processes/${processId}/checklist`,
    { signal },
  );
  return Array.isArray(result.data?.violations) ? result.data.violations : [];
}

export function useAvailableActions(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: processActionKeys.actions(tenantId, processId),
    queryFn: ({ signal }) => fetchAvailableActions(processId, signal),
    refetchInterval: PROCESS_PANEL_REFETCH_MS,
    // Erro fica no painel ("Tentar novamente"), sem derrubar o segmento.
    throwOnError: false,
  });
}

export function useProcessChecklist(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: processActionKeys.checklist(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessChecklist(processId, signal),
    refetchInterval: PROCESS_PANEL_REFETCH_MS,
    throwOnError: false,
  });
}

/** Avanços principais primeiro, preservando a ordem da API (RN-WF-23 · `isPrimary`/`displayOrder`). */
export function orderActions(entries: readonly ActionEntry[]): ActionEntry[] {
  return [
    ...entries.filter((entry) => entry.primary === true),
    ...entries.filter((entry) => entry.primary !== true),
  ];
}

/** Bloqueantes em destaque, avisos depois (RN-WF-25). */
export function splitViolations(violations: readonly ChecklistViolation[]) {
  return {
    blocking: violations.filter((violation) => violation.severity === 'BLOCKING'),
    warnings: violations.filter((violation) => violation.severity === 'WARNING'),
  };
}

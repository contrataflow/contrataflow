import type {
  ActionEntry,
  ActionStageDto,
  ChecklistViolation,
  ProcessChecklist,
} from '@contrataflow/validation';
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

/** PRC-08: as ações e, no paralelismo (US-124), as etapas ativas (`stages[]`, irmão de `data`). */
export interface AvailableActionsResult {
  readonly entries: ActionEntry[];
  readonly stages: ActionStageDto[] | undefined;
}

/** PRC-08 — ações na ordem da API (avanços com a principal primeiro, devoluções, ciclo de vida). */
export async function fetchAvailableActionsResult(
  processId: string,
  signal?: AbortSignal,
): Promise<AvailableActionsResult> {
  const result = await apiRequest<ActionEntry[]>(`/processes/${processId}/available-actions`, {
    signal,
  });
  const stages = result.members?.stages;
  return {
    entries: Array.isArray(result.data) ? result.data : [],
    stages: Array.isArray(stages) ? (stages as ActionStageDto[]) : undefined,
  };
}

export async function fetchAvailableActions(
  processId: string,
  signal?: AbortSignal,
): Promise<ActionEntry[]> {
  return (await fetchAvailableActionsResult(processId, signal)).entries;
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

const selectEntries = (result: AvailableActionsResult) => result.entries;
const selectStages = (result: AvailableActionsResult) => result.stages;

function useAvailableActionsQuery<T>(
  processId: string,
  select: (result: AvailableActionsResult) => T,
) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: processActionKeys.actions(tenantId, processId),
    queryFn: ({ signal }) => fetchAvailableActionsResult(processId, signal),
    select,
    refetchInterval: PROCESS_PANEL_REFETCH_MS,
    // Erro fica no painel ("Tentar novamente"), sem derrubar o segmento.
    throwOnError: false,
  });
}

/** As entradas do PRC-08 (mesma consulta de `useAvailableActionStages`: um só pedido). */
export function useAvailableActions(processId: string) {
  return useAvailableActionsQuery(processId, selectEntries);
}

/** `stages[]` do PRC-08: só existe no paralelismo (US-124). */
export function useAvailableActionStages(processId: string) {
  return useAvailableActionsQuery(processId, selectStages);
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

/** Há ramos para escolher: mais de uma etapa ativa em `stages[]` (US-124). */
export function hasBranches(stages: readonly ActionStageDto[] | undefined): boolean {
  return (stages?.length ?? 0) > 1;
}

/** Etapa inicial: a primeira com a custódia (`isMine`) ou, sem nenhuma, a primeira. */
export function defaultBranchStageId(stages: readonly ActionStageDto[] | undefined): string | null {
  return (stages?.find((stage) => stage.isMine) ?? stages?.[0])?.processStageId ?? null;
}

/**
 * Entradas da etapa escolhida. Entradas sem `processStageId` (editar, etiquetas…) ficam; sem etapa
 * escolhida (fora do paralelismo) a lista não muda.
 */
export function entriesOfStage(
  entries: readonly ActionEntry[] | undefined,
  processStageId: string | null | undefined,
): ActionEntry[] {
  const all = entries ?? [];
  if (processStageId === null || processStageId === undefined) return [...all];
  return all.filter(
    (entry) => entry.processStageId === undefined || entry.processStageId === processStageId,
  );
}

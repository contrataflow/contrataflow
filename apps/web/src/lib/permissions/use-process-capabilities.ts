'use client';

import type { ActionEntry, ActionReason, ProcessAction } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * `useProcessCapabilities(processId)` (US-097 · permissions.md §9): o que o usuário pode fazer NO
 * processo, como a API decide — PRC-08 `GET /processes/{id}/available-actions` já aplica escopo,
 * participação e políticas e devolve os motivos de indisponibilidade (tooltip). Mesma chave do
 * painel situacional (`['t', tenantId, 'processes', id, 'available-actions']`): uma leitura serve
 * os dois. Carregando ou em erro, nada é permitido (oculto, nunca habilitado por engano).
 */

export interface ProcessCapabilities {
  readonly status: 'pending' | 'error' | 'success';
  readonly entries: readonly ActionEntry[];
  /** A ação aparece para o usuário (mesmo desabilitada no momento). */
  offers(action: ProcessAction): boolean;
  /** A ação está habilitada agora. */
  can(action: ProcessAction): boolean;
  /** Motivos de indisponibilidade (vazio se habilitada ou se a ação não é oferecida). */
  reasonsOf(action: ProcessAction): readonly ActionReason[];
}

export function processCapabilities(
  entries: readonly ActionEntry[] | undefined,
  status: ProcessCapabilities['status'],
): ProcessCapabilities {
  const list = status === 'success' ? (entries ?? []) : [];
  const of = (action: ProcessAction) => list.filter((entry) => entry.action === action);
  return {
    status,
    entries: list,
    offers: (action) => of(action).length > 0,
    can: (action) => of(action).some((entry) => entry.enabled),
    reasonsOf: (action) =>
      of(action).some((entry) => entry.enabled) ? [] : of(action).flatMap((entry) => entry.reasons),
  };
}

export function useProcessCapabilities(processId: string): ProcessCapabilities {
  const tenantId = useTenantId();
  const query = useQuery({
    queryKey: tenantKey(tenantId, 'processes', processId, 'available-actions'),
    queryFn: async ({ signal }) => {
      const result = await apiRequest<ActionEntry[]>(`/processes/${processId}/available-actions`, {
        signal,
      });
      return Array.isArray(result.data) ? result.data : [];
    },
    throwOnError: false,
  });
  return processCapabilities(query.data, query.status);
}

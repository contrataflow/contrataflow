import type { MovementItemDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Histórico de tramitações (US-054 · SCR-006 aba "Tramitação"): PRC-11 de api/02-processes.md,
 * paginado por cursor (`useInfiniteQuery`). Chave `['t', tenantId, 'processes', id, 'movements',
 * filtros]` (RN-FND-90): trocar o filtro troca a chave e reinicia a paginação.
 */

export const movementKeys = {
  all: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'movements'),
  list: (
    tenantId: string,
    processId: string,
    query: Readonly<Record<string, string | undefined>>,
  ) => tenantKey(tenantId, 'processes', processId, 'movements', query),
};

/** Página padrão de PRC-11 (fluxo principal 2). */
export const MOVEMENTS_PAGE_SIZE = 50;

/** A lista cresce com a atividade do processo ("Dados" da US-054). */
export const MOVEMENTS_STALE_TIME_MS = 30_000;

export interface MovementsPage {
  readonly items: readonly MovementItemDto[];
  readonly nextCursor: string | null;
  /** FA-02: sem `AUDIT_VIEW` a coluna de IP não aparece (em vez de vazia). */
  readonly canViewIp: boolean;
}

/** PRC-11. */
export async function fetchMovements(
  processId: string,
  options: {
    readonly query: Readonly<Record<string, string | undefined>>;
    readonly cursor?: string | null | undefined;
    readonly limit?: number | undefined;
  },
  signal?: AbortSignal,
): Promise<MovementsPage> {
  const result = await apiRequest<MovementItemDto[]>(`/processes/${processId}/movements`, {
    query: {
      ...options.query,
      limit: options.limit ?? MOVEMENTS_PAGE_SIZE,
      cursor: options.cursor ?? undefined,
    },
    signal,
  });
  const nextCursor = result.meta.nextCursor;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
    canViewIp: result.meta.canViewIp === true,
  };
}

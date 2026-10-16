import type { TimelineEntryDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Timeline do processo (US-060 · SCR-006): PRC-12 de api/02-processes.md, paginado por cursor
 * (`useInfiniteQuery`). Chave `['t', tenantId, 'processes', id, 'timeline', filtros]` (RN-FND-90):
 * trocar o filtro troca a chave e reinicia a paginação.
 */

export const timelineKeys = {
  all: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'timeline'),
  list: (
    tenantId: string,
    processId: string,
    query: Readonly<Record<string, string | undefined>>,
  ) => tenantKey(tenantId, 'processes', processId, 'timeline', query),
};

/** Página padrão de PRC-12 (RN-TML-09). */
export const TIMELINE_PAGE_SIZE = 50;

export interface TimelinePage {
  readonly items: readonly TimelineEntryDto[];
  readonly nextCursor: string | null;
}

/** PRC-12. */
export async function fetchTimeline(
  processId: string,
  options: {
    readonly query: Readonly<Record<string, string | undefined>>;
    readonly cursor?: string | null | undefined;
    readonly limit?: number | undefined;
  },
  signal?: AbortSignal,
): Promise<TimelinePage> {
  const result = await apiRequest<TimelineEntryDto[]>(`/processes/${processId}/timeline`, {
    query: {
      ...options.query,
      limit: options.limit ?? TIMELINE_PAGE_SIZE,
      cursor: options.cursor ?? undefined,
    },
    signal,
  });
  const nextCursor = result.meta.nextCursor;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
  };
}

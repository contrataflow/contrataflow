import { QueryClient } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/api-error';

/*
 * Padrões do TanStack Query (architecture.md §8.5): `staleTime` 30 s, sem refetch no foco por
 * padrão (só caixa de tarefas, aprovações e contador ligam), sem retentativa em 4xx e erros
 * 404/5xx levados ao boundary do segmento (`error.tsx`) com o `ApiError` completo.
 */

export const DEFAULT_STALE_TIME_MS = 30_000;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status < 500) return false;
  return failureCount < 2;
}

/** 404 e 5xx (e falhas desconhecidas) vão ao boundary; os demais são tratados pela política. */
export function shouldThrowToBoundary(error: unknown): boolean {
  if (!isApiError(error)) return true;
  return error.status === 404 || error.status >= 500;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        throwOnError: shouldThrowToBoundary,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Assina as falhas de consultas e mutações do cliente (política global de erros); devolve a
 * função de cancelamento.
 */
export function subscribeToErrors(
  queryClient: QueryClient,
  onError: (error: unknown, source: 'query' | 'mutation') => void,
): () => void {
  const stopQueries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error')
      onError(event.action.error, 'query');
  });
  const stopMutations = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      onError(event.action.error, 'mutation');
    }
  });
  return () => {
    stopQueries();
    stopMutations();
  };
}

/** QueryClient de prefetch dos Server Components (um por requisição — nunca compartilhado). */
export function makeServerQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: DEFAULT_STALE_TIME_MS, retry: false } },
  });
}

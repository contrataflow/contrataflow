'use client';

import { useQuery } from '@tanstack/react-query';

import { useTenantId } from '@/lib/session/session-context';

import {
  RENDITION_POLL_MS,
  fetchRendition,
  isRenditionInProgress,
  renditionKeys,
} from './renditions.api';

/*
 * Acompanhamento do PDF por DOC-22 (US-067): consulta a cada 2 s enquanto `PENDING`/`PROCESSING` e
 * para ao chegar em `READY`/`FAILED`/`EXPIRED` (ou sem dado ainda). Não consulta em segundo plano
 * (aba oculta). `renditionId` nulo desliga a consulta. O `staleTime` curto evita um GET extra logo
 * depois de o pedido (DOC-20/21) semear o cache com a rendition `PENDING`.
 */
export function useRendition(renditionId: string | null) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: renditionKeys.detail(tenantId, renditionId ?? 'none'),
    queryFn: ({ signal }) => fetchRendition(renditionId ?? '', signal),
    enabled: renditionId !== null,
    staleTime: RENDITION_POLL_MS / 2,
    refetchInterval: (query) =>
      isRenditionInProgress(query.state.data?.status) ? RENDITION_POLL_MS : false,
    refetchIntervalInBackground: false,
    // O erro fica na tela ("Tentar novamente"); não derruba o segmento.
    throwOnError: false,
  });
}

import type { ProcessDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';

/*
 * Assumir o processo (US-049 · SCR-115): PRC-21 (`POST /processes/{id}/claim`), comando sem corpo e
 * sem `Idempotency-Key` — o clique duplo é barrado pelo `If-Match` (412, tratado como sucesso já
 * aplicado). A versão vem do PRC-04, lido pelo painel.
 */

export async function claimProcess(processId: string, version: number): Promise<ProcessDto> {
  const result = await apiRequest<ProcessDto>(`/processes/${processId}/claim`, {
    method: 'POST',
    ifMatch: `"${String(version)}"`,
  });
  return result.data;
}

export interface ClaimVariables {
  readonly processId: string;
  /** `version` do PRC-04 (o `If-Match`). */
  readonly version: number;
}

export function useClaimMutation() {
  return useMutation({
    mutationFn: ({ processId, version }: ClaimVariables) => claimProcess(processId, version),
  });
}

import type { CompleteProcessInput, CompletedProcessDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { RetryOptions } from '@/lib/api/client';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';

/*
 * Concluir o processo (US-010 · SCR-116): PRC-26 (`POST /processes/{id}/complete`) com `If-Match`
 * (versão do PRC-04) e `Idempotency-Key` por intenção — a mesma chave vale para as retentativas
 * automáticas, e o reenvio já aplicado devolve a mesma resposta (`Idempotent-Replayed`).
 */

/** PRC-26: o processo `COMPLETED` com `completedAt`/`completedBy`. */
export async function completeProcess(
  processId: string,
  body: CompleteProcessInput,
  version: number,
  context: IdempotentContext,
): Promise<CompletedProcessDto> {
  const result = await apiRequest<CompletedProcessDto>(`/processes/${processId}/complete`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return result.data;
}

export interface CompletionVariables {
  readonly processId: string;
  readonly body: CompleteProcessInput;
  /** `version` do PRC-04 (o `If-Match`). */
  readonly version: number;
}

export function useCompleteProcess(retry?: RetryOptions) {
  return useIdempotentMutation<CompletionVariables, CompletedProcessDto>({
    mutationFn: (variables, context) =>
      completeProcess(variables.processId, variables.body, variables.version, context),
    retry,
  });
}

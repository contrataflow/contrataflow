import type { ReturnProcessInput, ReturnedProcessDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { RetryOptions } from '@/lib/api/client';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';

/*
 * Devolução do processo (US-048 · SCR-104): PRC-20 (`POST /processes/{id}/return`). Os destinos
 * vêm do PRC-08 e a versão do PRC-04, lidos pelos módulos donos.
 */

/** PRC-20: a mesma `Idempotency-Key` vale para as retentativas automáticas (FA-04). */
export async function returnProcess(
  processId: string,
  body: ReturnProcessInput,
  version: number,
  context: IdempotentContext,
): Promise<ReturnedProcessDto> {
  const result = await apiRequest<ReturnedProcessDto>(`/processes/${processId}/return`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return result.data;
}

export interface ReturnVariables {
  readonly processId: string;
  readonly body: ReturnProcessInput;
  /** `version` do PRC-04 (o `If-Match`). */
  readonly version: number;
}

/** Mutação da devolução: chave de idempotência por intenção (reenvios da falha de rede). */
export function useReturnProcess(retry?: RetryOptions) {
  return useIdempotentMutation<ReturnVariables, ReturnedProcessDto>({
    mutationFn: (variables, context) =>
      returnProcess(variables.processId, variables.body, variables.version, context),
    retry,
  });
}

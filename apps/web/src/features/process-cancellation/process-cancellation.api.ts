import type {
  CancelProcessInput,
  CanceledProcessDto,
  DiscardProcessDraftInput,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { RetryOptions } from '@/lib/api/client';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';

/*
 * Cancelar o processo e descartar o rascunho sem número (US-009 · SCR-116): PRC-25
 * (`POST /processes/{id}/cancel`) e PRC-06 (`DELETE /processes/{id}`), com `If-Match` (versão do
 * PRC-04). A API não guarda resposta por chave nessas rotas: o reenvio depois do sucesso é 409.
 */

/** PRC-25: o processo `CANCELED` com a justificativa. */
export async function cancelProcess(
  processId: string,
  body: CancelProcessInput,
  version: number,
  context: IdempotentContext,
): Promise<CanceledProcessDto> {
  const result = await apiRequest<CanceledProcessDto>(`/processes/${processId}/cancel`, {
    method: 'POST',
    body,
    ifMatch: `"${String(version)}"`,
    correlationId: context.correlationId,
  });
  return result.data;
}

/** PRC-06: 204 sem corpo; o motivo opcional vai só para a auditoria. */
export async function discardProcessDraft(
  processId: string,
  body: DiscardProcessDraftInput,
  version: number,
  context: IdempotentContext,
): Promise<void> {
  await apiRequest<unknown>(`/processes/${processId}`, {
    method: 'DELETE',
    ifMatch: `"${String(version)}"`,
    correlationId: context.correlationId,
    ...(body.reason === undefined ? {} : { body }),
  });
}

export interface CancellationVariables<B> {
  readonly processId: string;
  readonly body: B;
  /** `version` do PRC-04 (o `If-Match`). */
  readonly version: number;
}

export function useCancelProcess(retry?: RetryOptions) {
  return useIdempotentMutation<CancellationVariables<CancelProcessInput>, CanceledProcessDto>({
    mutationFn: (variables, context) =>
      cancelProcess(variables.processId, variables.body, variables.version, context),
    retry,
  });
}

export function useDiscardProcessDraft(retry?: RetryOptions) {
  return useIdempotentMutation<CancellationVariables<DiscardProcessDraftInput>, undefined>({
    mutationFn: async (variables, context) => {
      await discardProcessDraft(variables.processId, variables.body, variables.version, context);
      return undefined;
    },
    retry,
  });
}

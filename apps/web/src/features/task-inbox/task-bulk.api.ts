import { bulkResultResponseSchema } from '@contrataflow/validation';
import type { BulkAssignInput, BulkResultResponse } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';

/*
 * Ações em lote da caixa de tarefas (US-058 · SCR-013/SCR-115): TSK-03 (`POST /tasks/bulk-claim`)
 * e TSK-04 (`POST /tasks/bulk-assign`), sempre com `Idempotency-Key` (a chave cobre o lote inteiro
 * — RN-INBOX-23). A resposta é `200` com um resultado por item, inclusive quando todos falham.
 */

async function postBulk(
  path: '/tasks/bulk-claim' | '/tasks/bulk-assign',
  body: object,
  idempotencyKey: string,
): Promise<BulkResultResponse> {
  const result = await apiRequest<BulkResultResponse['data']>(path, {
    method: 'POST',
    body,
    idempotencyKey,
  });
  return bulkResultResponseSchema.parse({ data: result.data, meta: result.meta });
}

/** TSK-03. */
export function bulkClaim(
  processIds: readonly string[],
  idempotencyKey: string,
): Promise<BulkResultResponse> {
  return postBulk('/tasks/bulk-claim', { processIds }, idempotencyKey);
}

/** TSK-04. */
export function bulkAssign(
  body: BulkAssignInput,
  idempotencyKey: string,
): Promise<BulkResultResponse> {
  return postBulk('/tasks/bulk-assign', body, idempotencyKey);
}

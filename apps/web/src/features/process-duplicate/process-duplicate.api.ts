import type { DuplicateProcessInput, ProcessDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';

/*
 * Duplicação do processo (US-011 · SCR-113): PRC-27 de api/02-processes.md — `POST` com os ajustes
 * do diálogo e a `Idempotency-Key` gerada ao abrir o diálogo (a mesma vale para cada reenvio).
 */

/** PRC-27: devolve o novo processo (`duplicatedFromId` = origem). */
export async function duplicateProcess(
  processId: string,
  body: DuplicateProcessInput,
  idempotencyKey: string,
): Promise<ProcessDto> {
  return (
    await apiRequest<ProcessDto>(`/processes/${processId}/duplicate`, {
      method: 'POST',
      body,
      idempotencyKey,
    })
  ).data;
}

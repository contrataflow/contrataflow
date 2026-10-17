import type { ProcessDto, UpdateProcessInput } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';

/*
 * Edição dos dados do processo (US-005 · SCR-006): PRC-05 de api/02-processes.md — `PATCH` só com
 * os campos alterados e `If-Match` com a versão lida no PRC-04 (`ETag` = versão).
 */

/** PRC-05: devolve o processo atualizado (ou o atual, se não havia diferença — RN-PROC-67). */
export async function updateProcess(
  processId: string,
  body: UpdateProcessInput,
  version: number,
): Promise<ProcessDto> {
  return (
    await apiRequest<ProcessDto>(`/processes/${processId}`, {
      method: 'PATCH',
      body,
      ifMatch: `"${String(version)}"`,
    })
  ).data;
}

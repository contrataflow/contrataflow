import type { ProcessDto } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';

/*
 * Sigilo do orçamento estimado (US-013 · SCR-006): PRC-33 de api/02-processes.md — `PUT` com
 * `{ isBudgetConfidential }` e `If-Match` com a versão lida no PRC-04 (`ETag` = versão).
 */

/** PRC-33: devolve o processo com o novo sigilo (valor já mascarado pela POL-09). */
export async function setProcessConfidentiality(
  processId: string,
  isBudgetConfidential: boolean,
  version: number,
): Promise<ProcessDto> {
  return (
    await apiRequest<ProcessDto>(`/processes/${processId}/confidentiality`, {
      method: 'PUT',
      body: { isBudgetConfidential },
      ifMatch: `"${String(version)}"`,
    })
  ).data;
}

/** Chave da mensagem de erro do PRC-33 ("Casos de erro" da story); 401 fica com o cliente. */
export type ConfidentialityErrorKey =
  'conflict' | 'precondition' | 'permission' | 'rateLimited' | 'unavailable' | 'unexpected';

export function confidentialityErrorOf(error: unknown): {
  readonly key: ConfidentialityErrorKey;
  readonly correlationId: string;
  /** O processo pode ter mudado: recarregar o painel. */
  readonly reload: boolean;
} {
  const correlationId = isApiError(error) ? (error.correlationId ?? '—') : '—';
  if (!isApiError(error)) return { key: 'unexpected', correlationId, reload: false };
  switch (error.status) {
    case 412:
      return { key: 'conflict', correlationId, reload: true };
    case 428:
      return { key: 'precondition', correlationId, reload: true };
    case 403:
      return { key: 'permission', correlationId, reload: true };
    case 429:
      return { key: 'rateLimited', correlationId, reload: false };
    case 503:
      return { key: 'unavailable', correlationId, reload: false };
    default:
      return { key: 'unexpected', correlationId, reload: false };
  }
}

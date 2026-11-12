import { isApiError } from '@/lib/api/api-error';

/*
 * Resultado de uma recusa do PRC-21 (US-049 · "Casos de erro"): o que a UI faz em cada uma. O 412 do
 * clique duplo (FA-03) é "sucesso já aplicado": só atualiza a tela, sem erro percebido.
 */
export type ClaimProblem =
  | { readonly kind: 'alreadyDone' }
  | { readonly kind: 'alreadyAssigned'; readonly name: string | null }
  | { readonly kind: 'status' }
  /** US-124: 409 `STAGE_CHANGED` — o ramo foi movimentado por outra pessoa. */
  | { readonly kind: 'stageChanged' }
  /** US-124: 422 `PROCESS_STAGE_REQUIRED`. */
  | { readonly kind: 'stageRequired' }
  /** US-124: 422 `PROCESS_STAGE_INVALID`. */
  | { readonly kind: 'stageInvalid' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** O responsável que o 409 devolve em `currentResponsible` (FA-01). */
function responsibleName(problem: unknown): string | null {
  if (typeof problem !== 'object' || problem === null) return null;
  const responsible = (problem as { currentResponsible?: { name?: unknown } }).currentResponsible;
  return typeof responsible?.name === 'string' ? responsible.name : null;
}

export function describeClaimError(error: unknown): ClaimProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 412 && code === 'VERSION_CONFLICT') return { kind: 'alreadyDone' };
  if (status === 409 && code === 'PROCESS_ALREADY_ASSIGNED') {
    return { kind: 'alreadyAssigned', name: responsibleName(error.problem) };
  }
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'status' };
  if (status === 409 && code === 'STAGE_CHANGED') return { kind: 'stageChanged' };
  if (status === 422 && code === 'PROCESS_STAGE_REQUIRED') return { kind: 'stageRequired' };
  if (status === 422 && code === 'PROCESS_STAGE_INVALID') return { kind: 'stageInvalid' };
  if (status === 403) return { kind: 'denied' };
  if (status === 404) return { kind: 'notFound' };
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}

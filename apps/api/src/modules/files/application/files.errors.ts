import { ApiError } from '#shared/errors/api-error.js';
import { TenantIsolationViolationError } from '#shared/tenancy/isolation.js';

/*
 * Erros de aplicação do `files` (US-068). O storage fora do ar responde 503 como o banco
 * (`DEPENDENCY_UNAVAILABLE`) — mas a violação de isolamento de tenant segue como está (500 e
 * alerta), nunca mascarada de indisponibilidade.
 */

export function storageUnavailable(cause: unknown): Error {
  if (cause instanceof ApiError || cause instanceof TenantIsolationViolationError) {
    return cause;
  }
  return new ApiError('DEPENDENCY_UNAVAILABLE', {
    detail: 'Não foi possível enviar o arquivo agora. Tente novamente.',
    headers: { 'Retry-After': '5' },
    cause,
  });
}

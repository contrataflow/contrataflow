import { ApiError } from '#shared/errors/api-error.js';

/**
 * Chamada do `AuditService` fora do contrato (V-01 ação fora do catálogo, V-02 negação/falha sem
 * motivo, V-03 fora de transação, ids inválidos, `occurredAt` inválido ou no futuro,
 * `oncePerSession` sem sessão ou tenant no contexto): erro de programação, recusado antes do INSERT. O
 * filtro RFC 9457 o trata como exceção não mapeada → 500 `INTERNAL_ERROR` com o `correlationId`.
 */
export class AuditContractError extends Error {
  constructor(
    readonly rule: 'V-01' | 'V-02' | 'V-03' | 'IDS' | 'OCCURRED_AT' | 'SESSION',
    message: string,
  ) {
    super(`${rule}: ${message}`);
    this.name = 'AuditContractError';
  }
}

/**
 * Auditoria não gravada por indisponibilidade do banco (partição ausente — FA-03): a transação de
 * negócio é desfeita e a API responde 503 `DEPENDENCY_UNAVAILABLE` (casos de erro da US-073).
 */
export class AuditUnavailableError extends ApiError {
  constructor(cause: unknown) {
    super('DEPENDENCY_UNAVAILABLE', {
      detail: 'Não foi possível concluir a operação agora. Tente novamente em instantes.',
      headers: { 'Retry-After': '5' },
      cause,
    });
    this.name = 'AuditUnavailableError';
  }
}

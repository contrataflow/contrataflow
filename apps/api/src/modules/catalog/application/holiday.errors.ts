import { MAX_BUSINESS_DAYS_RANGE } from '@contrataflow/validation';
import type { Logger } from '@nestjs/common';

import { ApiError, validationError } from '#shared/errors/api-error.js';

/** 404 de feriado inexistente ou de outro tenant (indistinguíveis — RN-TEN). */
export function holidayNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Feriado não encontrado.' });
}

/** V-03 · RN-TEN-75: `(date, lower(name))` repetido no tenant → 409 `CONFLICT`. */
export function holidayAlreadyExists(): ApiError {
  return new ApiError('CONFLICT', { detail: 'Já existe um feriado com esta data e nome.' });
}

/** V-04 · RN-TEN-77: alterar o nome / excluir feriado de sistema → 409 `CATALOG_ITEM_SYSTEM`. */
export function holidaySystem(): ApiError {
  return new ApiError('CATALOG_ITEM_SYSTEM', {
    detail: 'Feriados padrão do sistema não podem ser excluídos.',
  });
}

/** RN-TEN-74: escopo `NATIONAL` é reservado ao seed. */
export function holidayScopeNotAllowed(): ApiError {
  return validationError([
    {
      field: 'scope',
      code: 'NOT_ALLOWED',
      message: 'O escopo nacional é reservado aos feriados padrão do sistema.',
    },
  ]);
}

/** 412 `VERSION_CONFLICT` com a versão atual (`currentVersion`) para o cliente recarregar. */
export function holidayVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Este feriado foi alterado por outra pessoa. Recarregue a lista.',
    extensions: { currentVersion },
  });
}

/** CAL-05: intervalo invertido ou além da janela máxima. */
export function businessDaysRangeInvalid(reason: 'INVERTED' | 'TOO_LONG'): ApiError {
  return validationError([
    {
      field: 'to',
      code: 'OUT_OF_RANGE',
      message:
        reason === 'INVERTED'
          ? 'A data final não pode ser anterior à inicial.'
          : `Informe um intervalo de no máximo ${String(MAX_BUSINESS_DAYS_RANGE)} dias.`,
    },
  ]);
}

/**
 * `error` `calendar.operation_failed`: só falha de gravação/leitura (erro inesperado ou dependência
 * fora); regra de negócio e validação (4xx) não entram.
 */
export function logOperationFailure(logger: Logger, error: unknown, correlationId: string): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error(
    { event: 'calendar.operation_failed', errorCode: code ?? 'INTERNAL_ERROR', correlationId },
    'calendar.operation_failed',
  );
}

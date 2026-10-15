import type { Logger } from '@nestjs/common';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type {
  InvalidSettingValuesError,
  MissingExpectedVersionsError,
  SettingVersionConflictError,
  UnknownSettingKeysError,
} from '../domain/settings-update.js';

/** RN-TEN-52: nenhuma chave do lote é alterada. */
export function settingKeyUnknown(error: UnknownSettingKeysError): ApiError {
  return new ApiError('SETTING_KEY_UNKNOWN', {
    detail: `Configuração desconhecida: ${error.keys.join(', ')}.`,
    extensions: { keys: [...error.keys] },
  });
}

/**
 * RN-TEN-53: só máscaras de numeração → 422 `NUMBERING_MASK_INVALID` (código do módulo dono); com
 * qualquer outra violação, 422 `VALIDATION_ERROR` com um item por chave em `values.<chave>`.
 */
export function invalidSettingValues(error: InvalidSettingValuesError): ApiError {
  const onlyNumbering = error.violations.every(
    (violation) => violation.code === 'NUMBERING_MASK_INVALID',
  );
  if (onlyNumbering) {
    return new ApiError('NUMBERING_MASK_INVALID', {
      errors: error.violations.map(({ key }) => ({
        field: `values.${key}`,
        code: 'INVALID_FORMAT',
        message: 'A máscara deve conter {seq:N} e {year}.',
      })),
    });
  }
  return validationError(
    error.violations.map(({ key }) => ({
      field: `values.${key}`,
      code: 'INVALID_FORMAT',
      message: `Valor inválido para ${key}.`,
    })),
  );
}

/** V-05: 428 `PRECONDITION_REQUIRED` — o front recarrega `SET-01`. */
export function expectedVersionsMissing(error: MissingExpectedVersionsError): ApiError {
  return new ApiError('PRECONDITION_REQUIRED', {
    detail: 'Recarregue a página de configurações e tente novamente.',
    extensions: { keys: [...error.keys] },
  });
}

/**
 * V-04: 412 `VERSION_CONFLICT` identificando a(s) chave(s) em conflito; `currentVersion` quando a
 * divergência é de uma única chave (Gherkin "Concorrência").
 */
export function settingVersionConflict(error: SettingVersionConflictError): ApiError {
  const [only] = error.conflicts;
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Esta configuração foi alterada por outra pessoa. Recarregue.',
    extensions: {
      conflicts: error.conflicts.map(({ key, currentVersion }) => ({ key, currentVersion })),
      ...(error.conflicts.length === 1 && only ? { currentVersion: only.currentVersion } : {}),
    },
  });
}

/**
 * `error` `settings.save_failed`: só falha de gravação (erro inesperado ou dependência fora);
 * regra de negócio e validação (4xx) não entram. Sem valores no log.
 */
export function logSaveFailure(logger: Logger, error: unknown, correlationId: string): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error(
    { event: 'settings.save_failed', errorCode: code ?? 'INTERNAL_ERROR', correlationId },
    'settings.save_failed',
  );
}

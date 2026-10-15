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

/** V-01 da US-105: formato da máscara (tokens obrigatórios, desconhecidos ou fora do lugar). */
const MASK_FORMAT_MESSAGE =
  'A máscara deve conter {seq:N} e {year}; verifique os marcadores usados.';
/** V-02 da US-105: escopo `ORGANIZATION` sem `{org}` na máscara do processo. */
const MASK_ORG_MESSAGE = 'Com numeração por órgão, a máscara deve incluir {org}.';

/** Só violações de máscara de numeração (RN-TEN-53: o lote vira `NUMBERING_MASK_INVALID`). */
export function isNumberingMaskOnly(error: InvalidSettingValuesError): boolean {
  return error.violations.every((violation) => violation.code === 'NUMBERING_MASK_INVALID');
}

/**
 * RN-TEN-53: só máscaras de numeração → 422 `NUMBERING_MASK_INVALID` (código do módulo dono); com
 * qualquer outra violação, 422 `VALIDATION_ERROR` com um item por chave em `values.<chave>`.
 */
export function invalidSettingValues(error: InvalidSettingValuesError): ApiError {
  if (isNumberingMaskOnly(error)) {
    const errors = error.violations.map(({ key, missingOrganization }) => ({
      field: `values.${key}`,
      code: 'INVALID_FORMAT' as const,
      message: missingOrganization === true ? MASK_ORG_MESSAGE : MASK_FORMAT_MESSAGE,
    }));
    return new ApiError('NUMBERING_MASK_INVALID', {
      detail: errors[0]?.message ?? MASK_FORMAT_MESSAGE,
      errors,
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

/**
 * `error` `numbering.mask_invalid` (US-105 · Logs): chave, máscara recusada e motivo — máscaras não
 * são dados pessoais.
 */
export function logMaskInvalid(
  logger: Logger,
  error: InvalidSettingValuesError,
  values: Readonly<Record<string, unknown>>,
  correlationId: string,
): void {
  for (const violation of error.violations) {
    if (violation.code !== 'NUMBERING_MASK_INVALID') continue;
    const maskKey =
      violation.missingOrganization === true ? 'numbering.process.mask' : violation.key;
    logger.error(
      {
        event: 'numbering.mask_invalid',
        key: violation.key,
        mask: typeof values[maskKey] === 'string' ? values[maskKey] : null,
        reason: violation.missingOrganization === true ? 'MISSING_ORG' : 'FORMAT',
        correlationId,
      },
      'numbering.mask_invalid',
    );
  }
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

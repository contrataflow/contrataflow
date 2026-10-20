import type { Logger } from '@nestjs/common';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { LogoCheck } from './organization-ports.js';
import type { PrimaryOrganizationRequiredError } from '../domain/organization.js';

/** 404 de órgão inexistente ou de outro tenant (indistinguíveis — RN-TEN). */
export function organizationNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Órgão não encontrado.' });
}

/** V-02: sigla repetida no tenant → 422 `INVALID_FORMAT` em `shortName`. */
export function shortNameTaken(): ApiError {
  return validationError([
    {
      field: 'shortName',
      code: 'INVALID_FORMAT',
      message: 'Use 2 a 30 letras, números ou hífen, sem repetir uma sigla existente.',
    },
  ]);
}

/** V-04: CNPJ repetido no tenant → 422 `INVALID_CNPJ` em `cnpj`. */
export function cnpjTaken(): ApiError {
  return validationError([
    { field: 'cnpj', code: 'INVALID_CNPJ', message: 'Já existe um órgão com este CNPJ.' },
  ]);
}

/** V-07: anexo do logotipo inexistente, de outro tenant ou não disponível. */
export function logoRejected(check: Exclude<LogoCheck, 'OK'>): ApiError {
  return validationError([
    {
      field: 'logoAttachmentId',
      code: check === 'INACTIVE' ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
      message: 'Não foi possível usar esta imagem como logotipo.',
    },
  ]);
}

/** 412 `VERSION_CONFLICT` com a versão atual do órgão (`currentVersion`) para o cliente recarregar. */
export function versionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', { extensions: { currentVersion } });
}

/**
 * `error` `organization.save_failed`: só falha de gravação (erro inesperado ou dependência fora);
 * regra de negócio e validação (4xx) não entram. Sem dados do órgão no log.
 */
export function logSaveFailure(logger: Logger, error: unknown, correlationId: string): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error(
    { event: 'organization.save_failed', errorCode: code ?? 'INTERNAL_ERROR', correlationId },
    'organization.save_failed',
  );
}

/** V-06 · RN-TEN-41. */
export function primaryOrganizationRequired(error: PrimaryOrganizationRequiredError): ApiError {
  return new ApiError('PRIMARY_ORGANIZATION_REQUIRED', {
    detail:
      error.reason === 'PRIMARY'
        ? 'Este é o órgão principal do tenant e não pode ser inativado.'
        : 'Este é o único órgão ativo do tenant e não pode ser inativado.',
    extensions: { reason: error.reason },
  });
}

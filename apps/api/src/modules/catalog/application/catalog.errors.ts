import type { Logger } from '@nestjs/common';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type {
  CatalogMetadataInvalidError,
  CatalogOrderInvalidError,
} from '../domain/catalog-item.js';

/** 404 de item inexistente ou de outro tenant (indistinguíveis — RN-TEN). */
export function catalogItemNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Item de catálogo não encontrado.' });
}

/** V-02: `code` repetido no catálogo → 422 `INVALID_FORMAT` em `code`. */
export function catalogCodeTaken(): ApiError {
  return validationError([
    {
      field: 'code',
      code: 'INVALID_FORMAT',
      message: 'Já existe um item com este código neste catálogo.',
    },
  ]);
}

/** V-04 · RN-TEN-63: pai inexistente, de outro tenant/catálogo, o próprio item ou ciclo. */
export function catalogParentInvalid(): ApiError {
  return validationError([
    {
      field: 'parentId',
      code: 'REFERENCE_NOT_FOUND',
      message: 'Selecione um item superior válido.',
    },
  ]);
}

/** V-03 · RN-TEN-62: `metadata` fora do schema do tipo. */
export function catalogMetadataInvalid(error: CatalogMetadataInvalidError): ApiError {
  return validationError(error.errors);
}

/** V-05 · FA-01: alterar `code` de item de sistema → 409 `CATALOG_ITEM_SYSTEM`. */
export function catalogItemSystem(code: string): ApiError {
  return new ApiError('CATALOG_ITEM_SYSTEM', { extensions: { catalogItemCode: code } });
}

/** RN-TEN-59: `code` é imutável também nos itens que não são de sistema. */
export function catalogCodeImmutable(): ApiError {
  return validationError([
    {
      field: 'code',
      code: 'NOT_ALLOWED',
      message: 'O código do item não pode ser alterado depois da criação.',
    },
  ]);
}

/** RN-TEN-65: ID fora do catálogo/tenant ou lista incompleta bloqueia a operação inteira. */
export function catalogOrderInvalid(error: CatalogOrderInvalidError): ApiError {
  return validationError([
    {
      field: 'orderedIds',
      code: error.reason === 'UNKNOWN_ID' ? 'REFERENCE_NOT_FOUND' : 'CONDITIONAL_REQUIRED',
      message:
        error.reason === 'UNKNOWN_ID'
          ? 'Há itens que não pertencem a este catálogo.'
          : 'Informe todos os itens do catálogo na nova ordem.',
    },
  ]);
}

/** V-06: 412 `VERSION_CONFLICT` com a versão atual (`currentVersion`) para o cliente recarregar. */
export function catalogVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Este item foi alterado por outra pessoa. Recarregue a lista.',
    extensions: { currentVersion },
  });
}

/**
 * `error` `catalog.operation_failed`: só falha de gravação (erro inesperado ou dependência fora);
 * regra de negócio e validação (4xx) não entram. Sem `description`/`metadata` no log.
 */
export function logOperationFailure(logger: Logger, error: unknown, correlationId: string): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error(
    { event: 'catalog.operation_failed', errorCode: code ?? 'INTERNAL_ERROR', correlationId },
    'catalog.operation_failed',
  );
}

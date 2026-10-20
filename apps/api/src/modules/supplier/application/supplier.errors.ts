import { SUPPLIER_DOCUMENT_IMMUTABLE_MESSAGE } from '@contrataflow/validation';
import type { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { ApiError, validationError } from '#shared/errors/api-error.js';

/** 404 de fornecedor inexistente, excluído ou de outro tenant (indistinguíveis). */
export function supplierNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Fornecedor não encontrado.' });
}

/** V-04 · RN-PRICE-17: o front mostra o link do fornecedor existente (`existingSupplierId`). */
export function supplierAlreadyExists(existingSupplierId?: string): ApiError {
  return new ApiError('SUPPLIER_ALREADY_EXISTS', {
    ...(existingSupplierId === undefined ? {} : { extensions: { existingSupplierId } }),
  });
}

/** V-08 · RN-PRICE-19: a UI oferece "Inativar". */
export function supplierInUse(): ApiError {
  return new ApiError('SUPPLIER_IN_USE');
}

/** V-07 · RN-PRICE-14: tipo/número do documento não mudam depois da criação. */
export function documentNotAllowed(): ApiError {
  return validationError([
    { field: 'documentNumber', code: 'NOT_ALLOWED', message: SUPPLIER_DOCUMENT_IMMUTABLE_MESSAGE },
  ]);
}

/** 412 `VERSION_CONFLICT` com a versão atual do fornecedor (`currentVersion`). */
export function versionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', { extensions: { currentVersion } });
}

/**
 * `error` `supplier.create_failed`/`supplier.save_failed`: só falha de gravação (erro inesperado
 * ou dependência fora, inclusive o KMS); regra de negócio e validação (4xx) não entram. Sem dados
 * do fornecedor (documento, e-mail, telefone, endereço, observações) no log.
 */
export function logSaveFailure(
  logger: Logger,
  event: 'supplier.create_failed' | 'supplier.save_failed',
  error: unknown,
  correlationId: string,
): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error({ event, errorCode: code ?? 'INTERNAL_ERROR', correlationId }, event);
}

let supplierCreated: Counter | undefined;

/** `supplier_created_total{documentType}` — cadastros confirmados (US-025 · DoD). */
export function countSupplierCreated(documentType: string): void {
  supplierCreated ??= metrics.getMeter('contrataflow-api').createCounter('supplier_created_total', {
    description: 'Fornecedores cadastrados, por tipo de documento.',
  });
  supplierCreated.add(1, { documentType });
}

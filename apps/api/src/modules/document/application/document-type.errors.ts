import { NUMBERING_MASK_MESSAGE } from '@contrataflow/validation';
import type { FieldError } from '@contrataflow/validation';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { DocumentTypeRuleError } from '../domain/document-type.js';

/** 404 de tipo inexistente ou de outro tenant (indistinguíveis — RN-TEN). */
export function documentTypeNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Tipo de documento não encontrado.' });
}

/** 409 `CONFLICT` do código já usado no tenant (V-05). */
export function documentTypeCodeTaken(code: string): ApiError {
  return new ApiError('CONFLICT', {
    detail: `Já existe um tipo com o código ${code}.`,
    extensions: { conflictField: 'code' },
  });
}

/**
 * Violação de regra do domínio → erro canônico: máscara inválida sozinha é
 * `NUMBERING_MASK_INVALID` (422, com o campo marcado); qualquer outra combinação é
 * `VALIDATION_ERROR` com `errors[]` (`NOT_ALLOWED`, `CONDITIONAL_REQUIRED`).
 */
export function ruleErrorToApiError(error: DocumentTypeRuleError): ApiError {
  const errors: FieldError[] = error.violations.map((violation) =>
    violation.kind === 'NUMBERING_MASK'
      ? { field: violation.field, code: 'INVALID_FORMAT', message: violation.message }
      : { field: violation.field, code: violation.code, message: violation.message },
  );
  const onlyMask = error.violations.every((violation) => violation.kind === 'NUMBERING_MASK');
  if (onlyMask) {
    return new ApiError('NUMBERING_MASK_INVALID', { detail: NUMBERING_MASK_MESSAGE, errors });
  }
  return validationError(errors);
}

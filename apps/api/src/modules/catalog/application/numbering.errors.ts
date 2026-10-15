import type { Logger } from '@nestjs/common';

import { ApiError } from '#shared/errors/api-error.js';

import type { NumberMaskProblem } from '../domain/number-mask.js';

/** V-01: formato da máscara (tokens obrigatórios, desconhecidos ou fora do lugar). */
export const NUMBERING_MASK_FORMAT_MESSAGE =
  'A máscara deve conter {seq:N} e {year}; verifique os marcadores usados.';
/** V-02: escopo `ORGANIZATION` sem `{org}`. */
export const NUMBERING_MASK_ORG_MESSAGE = 'Com numeração por órgão, a máscara deve incluir {org}.';

export function numberingMaskMessage(problem: NumberMaskProblem): string {
  return problem === 'MISSING_ORG' ? NUMBERING_MASK_ORG_MESSAGE : NUMBERING_MASK_FORMAT_MESSAGE;
}

/** RN-TEN-67 · V-01/V-02: 422 `NUMBERING_MASK_INVALID` com o campo marcado. */
export function numberingMaskInvalid(field: string, problem: NumberMaskProblem): ApiError {
  const message = numberingMaskMessage(problem);
  return new ApiError('NUMBERING_MASK_INVALID', {
    detail: message,
    errors: [{ field, code: 'INVALID_FORMAT', message }],
  });
}

/** `error` `numbering.mask_invalid` (story US-105 · Logs): máscara e motivo não são dados pessoais. */
export function logMaskInvalid(
  logger: Logger,
  details: {
    readonly mask: string;
    readonly problem: NumberMaskProblem;
    readonly correlationId: string;
  },
): void {
  logger.error(
    {
      event: 'numbering.mask_invalid',
      mask: details.mask,
      reason: details.problem,
      correlationId: details.correlationId,
    },
    'numbering.mask_invalid',
  );
}

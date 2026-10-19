import { AI_MESSAGES, AI_SECTION_MESSAGES } from '@contrataflow/validation';
import type { AiSectionAdjustProblem } from '@contrataflow/validation';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { AiGateDenial } from './ai-extension-points.js';

/*
 * Erros HTTP da camada de IA (US-115 · "Casos de erro" · api/16-ai.md). Nenhuma mensagem leva o
 * resumo, a instrução ou a saída.
 */

/** 404 de geração inexistente ou de outro tenant (CA-T-01) — indistinguíveis. */
export function generationNotFound(): ApiError {
  return new ApiError('AI_GENERATION_NOT_FOUND');
}

/** 403 `AI_GENERATION_NOT_OWNED` (RN-AI-13), auditado como `access.denied`. */
export function generationNotOwned(): ApiError {
  return new ApiError('AI_GENERATION_NOT_OWNED', {
    auditReasonCode: 'AI_GENERATION_NOT_OWNED',
    auditDenial: true,
  });
}

/** 409 `AI_GENERATION_NOT_APPLICABLE` (V-09 · aplicação concorrente). */
export function generationNotApplicable(detail?: string): ApiError {
  return new ApiError('AI_GENERATION_NOT_APPLICABLE', detail === undefined ? {} : { detail });
}

/** 409 `AI_GENERATION_IN_PROGRESS` com `meta.generationId` da ativa (RN-AI-12 · V-08). */
export function generationInProgress(activeId: string | null): ApiError {
  return new ApiError('AI_GENERATION_IN_PROGRESS', {
    extensions: activeId === null ? {} : { meta: { generationId: activeId } },
  });
}

/** 503 `AI_PROVIDER_UNAVAILABLE` com `Retry-After` (FA-03). */
export function providerUnavailable(retryAfterSeconds: number): ApiError {
  return new ApiError('AI_PROVIDER_UNAVAILABLE', {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

/** Recusa do portão do órgão (US-116): 403 `AI_DISABLED` ou 422 de limite. */
export function gateDenied(code: AiGateDenial): ApiError {
  return new ApiError(code);
}

/** V-01: par `targetModule`/`kind` sem gerador registrado. */
export function generatorUnavailable(): ApiError {
  return validationError([
    {
      field: 'targetModule',
      code: 'NOT_ALLOWED',
      message: 'Este tipo de geração não está disponível.',
    },
  ]);
}

/** V-03: resumo obrigatório para o gerador (rascunho do DFD). */
export function needSummaryRequired(): ApiError {
  return validationError([
    { field: 'needSummary', code: 'REQUIRED', message: AI_MESSAGES.needSummary },
  ]);
}

/** V-02/V-03 do ajuste de seção (US-121): 422 `AI_SECTION_EMPTY` / `AI_SECTION_NOT_SUPPORTED`. */
export function sectionNotAdjustable(problem: AiSectionAdjustProblem): ApiError {
  return new ApiError(problem, {
    detail:
      problem === 'AI_SECTION_EMPTY' ? AI_SECTION_MESSAGES.empty : AI_SECTION_MESSAGES.notSupported,
  });
}

import { PRICE_RESEARCH_MESSAGES } from '@contrataflow/validation';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { ApiError, businessRuleViolation, validationError } from '#shared/errors/api-error.js';

/*
 * Erros e métricas da pesquisa de preços (US-024 · "Casos de erro"). 404 indistinguível para
 * pesquisa/item inexistente, de outro tenant ou de processo não visível (DEC-024).
 */

export function priceResearchNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: PRICE_RESEARCH_MESSAGES.notFound });
}

export function priceItemNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: PRICE_RESEARCH_MESSAGES.itemNotFound });
}

/** 412 `VERSION_CONFLICT` com a versão atual (pesquisa no PRS-04, item no PRS-08). */
export function priceResearchVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PRICE_RESEARCH_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}

/** V-08 (RN-PRICE-02): 422 `BUSINESS_RULE_VIOLATION` com `PRICE_ITEMS_REQUIRED`. */
export function priceItemsRequired(): ApiError {
  return businessRuleViolation([
    {
      code: 'PRICE_ITEMS_REQUIRED',
      severity: 'BLOCKING',
      message: PRICE_RESEARCH_MESSAGES.noProcessItems,
      ruleId: 'RN-PRICE-02',
      sectionKey: null,
      field: 'items',
      itemId: null,
      params: {},
    },
  ]);
}

/** V-10 (RN-PRICE-11): remover o último item → 422 `VALIDATION_ERROR` (`NOT_ALLOWED`). */
export function lastItemNotRemovable(): ApiError {
  return validationError([
    { field: 'itemId', code: 'NOT_ALLOWED', message: PRICE_RESEARCH_MESSAGES.lastItem },
  ]);
}

/**
 * RN-PRICE-12: em processo sigiloso, quem não atende POL-09 não edita a pesquisa (editar exige ler
 * os valores) — 403 `PERMISSION_DENIED` com `access.denied` (`reasonCode = POL-09`).
 */
export function confidentialEditDenied(): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: PRICE_RESEARCH_MESSAGES.confidentialDenied,
    auditReasonCode: 'POL-09',
    auditDenial: true,
  });
}

let createdCounter: Counter | undefined;

/** `price_research_created_total` (DoD da US-024). */
export function countPriceResearchCreated(): void {
  createdCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('price_research_created_total', {
      description: 'Pesquisas de preços criadas (PRS-02).',
    });
  createdCounter.add(1);
}

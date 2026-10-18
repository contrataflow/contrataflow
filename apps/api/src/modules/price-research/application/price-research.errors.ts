import { PRICE_RESEARCH_MESSAGES, PRICE_SOURCE_MESSAGES } from '@contrataflow/validation';
import type { PriceSourceField } from '@contrataflow/validation';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

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

// --- US-026: fontes e cotações ------------------------------------------------------------------

export function priceSourceNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: PRICE_SOURCE_MESSAGES.sourceNotFound });
}

export function quotationNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: PRICE_SOURCE_MESSAGES.quotationNotFound });
}

/** 412 `VERSION_CONFLICT` da fonte (PRS-11/12/13) com a versão atual. */
export function priceSourceVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PRICE_SOURCE_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}

/** 412 `VERSION_CONFLICT` da cotação (PRS-14/15) com a versão atual. */
export function quotationVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: PRICE_SOURCE_MESSAGES.quotationVersionConflict,
    extensions: { currentVersion },
  });
}

/** V-01 (RN-PRICE-21): 422 `QUOTATION_REQUIRED_FIELDS` com um erro por campo exigido ausente. */
export function quotationRequiredFields(missing: readonly PriceSourceField[]): ApiError {
  return new ApiError('QUOTATION_REQUIRED_FIELDS', {
    detail: PRICE_SOURCE_MESSAGES.requiredFields(missing),
    errors: missing.map((field) => ({
      field,
      code: 'CONDITIONAL_REQUIRED',
      message:
        field === 'supplierId'
          ? PRICE_SOURCE_MESSAGES.supplierRequired
          : PRICE_SOURCE_MESSAGES.fieldRequired,
    })),
  });
}

/** V-07 (RN-PRICE-25): cotação `EXCLUDED` não muda pela grade nem pela edição — 409 `INVALID_STATE`. */
export function quotationExcluded(priceItemIds: readonly string[]): ApiError {
  return new ApiError('INVALID_STATE', {
    detail: PRICE_SOURCE_MESSAGES.quotationExcluded,
    extensions: { meta: { priceItemIds } },
  });
}

let gridDuration: Histogram | undefined;

/** `price_research_quotations_upsert_duration_ms` — latência da grade (DoD da US-026). */
export function recordQuotationGridDuration(durationMs: number, lines: number): void {
  gridDuration ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('price_research_quotations_upsert_duration_ms', {
      description: 'Duração da gravação da grade de cotações (PRS-13).',
      unit: 'ms',
    });
  gridDuration.record(durationMs, { lines: lines > 50 ? '>50' : lines > 10 ? '11-50' : '1-10' });
}

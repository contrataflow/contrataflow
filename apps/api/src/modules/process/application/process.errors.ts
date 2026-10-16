import type { DuplicateCandidate, FieldError } from '@contrataflow/validation';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { ProcessIssue } from '../domain/process.js';

/*
 * Erros e telemetria do módulo `process` (US-001 · api.md §2.2 · "Casos de erro" e "Logs" da story).
 */

/** 422 `VALIDATION_ERROR` com os campos de RN-PROC-01..12 (V-01..V-09). */
export function processValidationError(issues: readonly ProcessIssue[]): ApiError {
  return validationError(issues.map((issue): FieldError => ({ ...issue })));
}

/** 409 `DUPLICATE_INTERNAL_CODE` (V-10). */
export function duplicateInternalCode(internalCode: string): ApiError {
  return new ApiError('DUPLICATE_INTERNAL_CODE', {
    detail: `Já existe um processo com o código interno ${internalCode}.`,
    errors: [
      {
        field: 'internalCode',
        code: 'NOT_ALLOWED',
        message: `Já existe um processo com o código interno ${internalCode}.`,
      },
    ],
  });
}

/** 409 `POSSIBLE_DUPLICATE_PROCESS` (V-11 · FA-02) com os candidatos no corpo. */
export function possibleDuplicate(candidates: readonly DuplicateCandidate[]): ApiError {
  return new ApiError('POSSIBLE_DUPLICATE_PROCESS', { extensions: { candidates } });
}

/** 404 `PROCESS_NOT_FOUND`: inexistente, de outro tenant ou não visível (permissions.md §5). */
export function processNotFoundError(): ApiError {
  return new ApiError('PROCESS_NOT_FOUND');
}

let createdCounter: Counter | undefined;
let createDuration: Histogram | undefined;

/** `cf_process_created_total{channel}` e `cf_process_create_duration_ms` (DoD da US-001). */
export function recordProcessCreated(channel: string, durationMs: number): void {
  const meter = metrics.getMeter('contrataflow-api');
  createdCounter ??= meter.createCounter('cf_process_created_total', {
    description: 'Processos de contratação criados (commit da criação), por canal.',
  });
  createDuration ??= meter.createHistogram('cf_process_create_duration_ms', {
    description: 'Duração da criação de processo (validação, numeração e gravação).',
    unit: 'ms',
  });
  createdCounter.add(1, { channel });
  createDuration.record(durationMs, { channel });
}

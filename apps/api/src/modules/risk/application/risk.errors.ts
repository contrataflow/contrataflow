import { TREATMENT_MESSAGES } from '@contrataflow/validation';
import type { RiskTreatmentChange, TreatmentStatus } from '@contrataflow/validation';
import type { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { RiskIssue } from '../domain/risk.js';

/** 404 de risco inexistente, excluído, de outro tenant ou de processo não visível (indistinguíveis). */
export function riskNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Risco não encontrado.' });
}

/** 412 `VERSION_CONFLICT` com a versão atual do risco (`currentVersion` — Concorrência). */
export function riskVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Este risco foi alterado por outra pessoa. Recarregue para ver a versão atual.',
    extensions: { currentVersion },
  });
}

/** 404 de tratamento inexistente, excluído, de outro tenant ou de processo não visível. */
export function treatmentNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: TREATMENT_MESSAGES.notFound });
}

/** 412 `VERSION_CONFLICT` com a versão atual do tratamento (Concorrência da US-034). */
export function treatmentVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: TREATMENT_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}

/** V-04 (RN-RISK-15): 409 `INVALID_STATE` com o status atual e o pedido. */
export function invalidTreatmentTransition(from: TreatmentStatus, to: TreatmentStatus): ApiError {
  return new ApiError('INVALID_STATE', {
    detail: TREATMENT_MESSAGES.invalidTransition(from, to),
    extensions: { currentStatus: from, requestedStatus: to },
  });
}

/** 422 `VALIDATION_ERROR` com os campos (V-03 `OUT_OF_RANGE` · FA-05 `CONDITIONAL_REQUIRED`). */
export function riskValidationError(issues: readonly RiskIssue[]): ApiError {
  return validationError(issues);
}

/** Campos de responsável do risco (US-033) e do tratamento (US-034). */
export type ResponsibleField =
  'ownerId' | 'ownerDepartmentId' | 'responsibleId' | 'responsibleDepartmentId';

/** V-05 (US-033) · V-03 (US-034): responsável inexistente, inativo ou de outro tenant. */
export function ownerReferenceError(
  field: ResponsibleField,
  code: 'REFERENCE_NOT_FOUND' | 'REFERENCE_INACTIVE',
): ApiError {
  return validationError([{ field, code, message: 'Selecione um responsável válido.' }]);
}

/**
 * `error` `risk.create_failed`/`risk.save_failed`: só falha de gravação (erro inesperado ou
 * dependência fora); regra de negócio e validação (4xx) não entram. Nunca título, descrição, causa
 * nem consequência no log (story · "Logs").
 */
export function logRiskSaveFailure(
  logger: Logger,
  event: 'risk.create_failed' | 'risk.save_failed',
  error: unknown,
  correlationId: string,
): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error(
    {
      event,
      errorCode: code ?? 'INTERNAL_ERROR',
      cause: error instanceof Error ? error.name : 'unknown',
      correlationId,
    },
    event,
  );
}

let risksCreated: Counter | undefined;
let risksAssessed: Counter | undefined;

/** `risk_created_total{level}` — riscos registrados (US-033 · DoD "métricas"). */
export function countRiskCreated(level: string): void {
  risksCreated ??= metrics.getMeter('contrataflow-api').createCounter('risk_created_total', {
    description: 'Riscos registrados, por nível.',
  });
  risksCreated.add(1, { level });
}

/** `risk_assessed_total{levelChanged}` — reavaliações de probabilidade × impacto. */
export function countRiskAssessed(levelChanged: boolean): void {
  risksAssessed ??= metrics.getMeter('contrataflow-api').createCounter('risk_assessed_total', {
    description: 'Reavaliações de risco, por mudança de nível.',
  });
  risksAssessed.add(1, { levelChanged: String(levelChanged) });
}

let treatmentsChanged: Counter | undefined;

/** `risk_treatment_changed_total{change}` — tratamentos criados, editados, concluídos, excluídos. */
export function countTreatmentChanged(change: RiskTreatmentChange): void {
  treatmentsChanged ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('risk_treatment_changed_total', {
      description: 'Mudanças em ações de tratamento de riscos, por tipo de mudança.',
    });
  treatmentsChanged.add(1, { change });
}

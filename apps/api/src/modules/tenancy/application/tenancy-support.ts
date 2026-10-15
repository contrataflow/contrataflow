import type { PlatformChannel } from '@contrataflow/types';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

import { ApiError } from '#shared/errors/api-error.js';

import type { ProvisioningChecklist } from '../domain/seeding-plan.js';
import { TENANT_ACTION_LABELS, TENANT_STATUS_LABELS } from '../domain/tenant.js';
import type { TenantAction, TenantStatus } from '../domain/tenant.js';

/** Operador que executa a ação de plataforma (API autenticada ou `--operator` da CLI). */
export interface PlatformOperatorRef {
  readonly id: string;
  readonly name: string;
}

export interface PlatformActionOptions {
  readonly operator: PlatformOperatorRef;
  readonly channel: PlatformChannel;
  /** Identificador da execução da CLI (`metadata.runId` — RN-TEN-17). */
  readonly runId?: string;
}

export function slugTaken(slug: string): ApiError {
  return new ApiError('TENANT_SLUG_TAKEN', {
    detail: `O identificador "${slug}" já está em uso.`,
  });
}

export function tenantNotFound(): ApiError {
  return new ApiError('TENANT_NOT_FOUND');
}

/** V-08: transição fora de RN-TEN-09. */
export function invalidTransition(action: TenantAction, status: TenantStatus): ApiError {
  return invalidState(TENANT_ACTION_LABELS[action], status);
}

/** V-08: "Não é possível {ação}: a instituição está {status}." */
export function invalidState(actionLabel: string, status: TenantStatus): ApiError {
  return new ApiError('INVALID_STATE', {
    detail: `Não é possível ${actionLabel}: a instituição está ${TENANT_STATUS_LABELS[status]}.`,
    extensions: { currentStatus: status },
  });
}

/** V-08: ativar a partir de `PROVISIONING` com etapas pendentes (RN-TEN-06). */
export function pendingStepsError(pending: readonly string[]): ApiError {
  return new ApiError('INVALID_STATE', {
    detail: 'Não é possível ativar: há etapas pendentes no provisionamento.',
    extensions: { pendingSteps: pending },
  });
}

/** Etapa falhou: o que foi concluído fica, e a reexecução retoma (FA-01). */
export function provisioningIncomplete(checklist: ProvisioningChecklist): ApiError {
  return new ApiError('DEPENDENCY_UNAVAILABLE', {
    detail: 'Não foi possível concluir agora. Os passos concluídos foram mantidos.',
    headers: { 'Retry-After': '5' },
    extensions: { provisioning: checklist },
  });
}

/** Código estável de um erro qualquer (para logs e `metadata.errorCode`). */
export function errorCodeOf(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'INTERNAL_ERROR';
}

let provisioningDuration: Histogram | undefined;
let statusChanges: Counter | undefined;

/** `cf_tenant_provisioning_duration_seconds{result}` (DoD da US-099). */
export function recordProvisioningDuration(seconds: number, result: 'complete' | 'incomplete') {
  provisioningDuration ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('cf_tenant_provisioning_duration_seconds', {
      description: 'Duração do provisionamento de tenant por resultado.',
      unit: 's',
    });
  provisioningDuration.record(seconds, { result });
}

/** `cf_tenant_status_changes_total{from,to,channel}` (DoD da US-099). */
export function countStatusChange(from: TenantStatus, to: TenantStatus, channel: PlatformChannel) {
  statusChanges ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_tenant_status_changes_total', {
      description: 'Mudanças de status de tenant pela plataforma.',
    });
  statusChanges.add(1, { from, to, channel });
}

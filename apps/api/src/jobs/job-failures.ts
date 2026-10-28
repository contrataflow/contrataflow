import { AiRetryableError } from '#modules/ai/application/ai-generation.processor.js';
import {
  RenderDeferredError,
  RenderFailedError,
} from '#modules/document/application/render-document.processor.js';
import { ScanDeferredError } from '#modules/files/application/scan-file.processor.js';
import { InvalidJobDataError } from '#shared/jobs/tenant-job.js';
import { TenantContextMissingError } from '#shared/tenancy/isolation.js';

/*
 * Leitura das falhas dos jobs da API para o `runJob` do worker (queues.md §10.2/§10.3): o worker
 * não conhece os erros dos módulos; esta tradução é o contrato entre os dois lados.
 */

export type ApiJobFailure =
  /** Dependência fora (disjuntor aberto): adia o job SEM consumir tentativa. */
  | { readonly kind: 'deferred'; readonly dependency: string }
  /** Falha final (estado já gravado ou dados inválidos): cópia na `dead-letter`, sem retry. */
  | { readonly kind: 'permanent'; readonly code: string }
  /** Job de tenant sem tenant (V-09): falha final de segurança. */
  | { readonly kind: 'security'; readonly code: string }
  /** Retry com o backoff do job (ou dead-letter na última tentativa). */
  | { readonly kind: 'transient' };

export function classifyApiJobFailure(error: unknown): ApiJobFailure {
  if (error instanceof RenderDeferredError || error instanceof ScanDeferredError) {
    return { kind: 'deferred', dependency: error.dependency };
  }
  if (error instanceof AiRetryableError) {
    return error.consumesAttempt
      ? { kind: 'transient' }
      : { kind: 'deferred', dependency: 'ai-provider' };
  }
  if (error instanceof RenderFailedError) return { kind: 'permanent', code: error.errorCode };
  if (error instanceof InvalidJobDataError) {
    return { kind: 'permanent', code: `INVALID_JOB_${error.part.toUpperCase()}` };
  }
  if (error instanceof TenantContextMissingError) {
    return { kind: 'security', code: 'TENANT_CONTEXT_REQUIRED' };
  }
  return { kind: 'transient' };
}

import type { ErrorCode } from '@contrataflow/types';
import type { FieldError, Violation } from '@contrataflow/validation';

import { GENERIC_ERRORS } from './error-catalog.js';

export interface ApiErrorOptions {
  readonly status?: number;
  readonly title?: string;
  readonly detail?: string;
  readonly errors?: readonly FieldError[];
  readonly violations?: readonly Violation[];
  /** Cabeçalhos da resposta de erro (ex.: `Retry-After`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Membros de extensão do problem+json (ex.: `currentVersion`). */
  readonly extensions?: Readonly<Record<string, unknown>>;
  /**
   * Motivo gravado em `AuditLog.reasonCode` quando o erro é uma negação de acesso auditada
   * (RN-AUD-10): ex.: a permissão ausente (`PROCESS_CREATE`) num `PERMISSION_DENIED`. Nunca vai na
   * resposta. Padrão: o próprio código do erro.
   */
  readonly auditReasonCode?: string;
  /**
   * Negação de acesso por política contextual (US-097 · RN-IAM-105): grava `access.denied` mesmo
   * com código fora de `AUDITED_DENIAL_CODES` (ex.: `NOT_PROCESS_CUSTODIAN`).
   */
  readonly auditDenial?: boolean;
  /** Entidade negada gravada no `access.denied` (ex.: a visão salva de outro dono — US-003). */
  readonly auditEntity?: { readonly type: string; readonly id: string };
  readonly cause?: unknown;
}

/**
 * Erro com código estável (DEC-103), convertido em `application/problem+json` pelo
 * `ProblemDetailsExceptionFilter`. Códigos de domínio (api.md §2.2) informam `status`/`title`/`detail`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly errors: readonly FieldError[];
  readonly violations: readonly Violation[];
  readonly headers: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly auditReasonCode: string;
  readonly auditDenial: boolean;
  readonly auditEntity: { readonly type: string; readonly id: string } | null;

  constructor(
    readonly code: ErrorCode | (string & {}),
    options: ApiErrorOptions = {},
  ) {
    const generic = GENERIC_ERRORS[code as ErrorCode] as
      (typeof GENERIC_ERRORS)[ErrorCode] | undefined;
    const detail = options.detail ?? generic?.detail ?? code;
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.status = options.status ?? generic?.status ?? 500;
    this.title = options.title ?? generic?.title ?? code;
    this.detail = detail;
    this.errors = options.errors ?? [];
    this.violations = options.violations ?? [];
    this.headers = options.headers ?? {};
    this.extensions = options.extensions ?? {};
    this.auditReasonCode = options.auditReasonCode ?? code;
    this.auditDenial = options.auditDenial ?? false;
    this.auditEntity = options.auditEntity ?? null;
  }
}

/** 422 `VALIDATION_ERROR` com `errors[]` (api.md §2.1.1). */
export function validationError(errors: readonly FieldError[]): ApiError {
  return new ApiError('VALIDATION_ERROR', { errors });
}

/** 422 `BUSINESS_RULE_VIOLATION` (ou código de domínio) com `violations[]` (api.md §2.1.2). */
export function businessRuleViolation(
  violations: readonly Violation[],
  code = 'BUSINESS_RULE_VIOLATION',
): ApiError {
  return new ApiError(code, { status: 422, violations });
}

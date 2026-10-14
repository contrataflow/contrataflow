import { problemDetailsSchema } from '@contrataflow/validation';
import type { FieldError, ProblemDetails, Violation } from '@contrataflow/validation';

/** Códigos que só o BFF emite (api.md §2.2). */
export const BFF_ERROR_CODES = ['CSRF_REJECTED'] as const;

/**
 * Erro de uma chamada à API (RFC 9457 · api.md §2), igual no servidor e no cliente. Guarda só o
 * necessário para a UI: código, `correlationId`, erros de campo/violações e `Retry-After`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;
  readonly errors: readonly FieldError[];
  readonly violations: readonly Violation[];
  /** Segundos de `Retry-After` (429/503), quando informado. */
  readonly retryAfterSeconds: number | null;
  /** Corpo completo (ex.: `currentVersion`/`meta.current` do 412). */
  readonly problem: ProblemDetails | null;

  constructor(init: {
    status: number;
    code: string;
    detail?: string | undefined;
    correlationId?: string | null | undefined;
    errors?: readonly FieldError[] | undefined;
    violations?: readonly Violation[] | undefined;
    retryAfterSeconds?: number | null | undefined;
    problem?: ProblemDetails | null | undefined;
  }) {
    super(init.detail ?? `Falha na chamada à API (${init.code}).`);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.correlationId = init.correlationId ?? null;
    this.errors = init.errors ?? [];
    this.violations = init.violations ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.problem = init.problem ?? null;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** `Retry-After` em segundos (aceita segundos ou data HTTP). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** Código genérico por status quando o corpo não é um problem+json válido. */
export function fallbackCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 412) return 'VERSION_CONFLICT';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503 || status === 502 || status === 504) return 'DEPENDENCY_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'MALFORMED_REQUEST';
}

/** Constrói o `ApiError` a partir de uma resposta não-OK (corpo já lido). */
export function apiErrorFromResponse(status: number, headers: Headers, body: unknown): ApiError {
  const parsed = problemDetailsSchema.safeParse(body);
  const retryAfterSeconds = parseRetryAfter(headers.get('Retry-After'));
  const headerCorrelation = headers.get('X-Correlation-Id');
  if (parsed.success) {
    return new ApiError({
      status,
      code: parsed.data.code,
      detail: parsed.data.detail,
      correlationId: parsed.data.correlationId,
      errors: parsed.data.errors,
      violations: parsed.data.violations,
      retryAfterSeconds,
      problem: parsed.data,
    });
  }
  const code =
    typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
      ? body.code
      : fallbackCode(status);
  return new ApiError({ status, code, correlationId: headerCorrelation, retryAfterSeconds });
}

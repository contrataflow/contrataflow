/**
 * Códigos de erro da API (SCREAMING_SNAKE_CASE — DEC-001; docs/mvp-01/api.md §2).
 * Os genéricos (§2.1) entram com a US-080 (esqueleto HTTP e RFC 9457); os de domínio (§2.2),
 * com as stories donas.
 */
export const ERROR_CODES = [
  'MALFORMED_REQUEST',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'MFA_REQUIRED',
  'PERMISSION_DENIED',
  'TENANT_SUSPENDED',
  'MEMBERSHIP_INACTIVE',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE',
  'IDEMPOTENCY_IN_PROGRESS',
  'VERSION_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VALIDATION_ERROR',
  'BUSINESS_RULE_VIOLATION',
  'IDEMPOTENCY_KEY_REUSED',
  'PRECONDITION_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'DEPENDENCY_UNAVAILABLE',
  'NUMBERING_MASK_INVALID',
  'APPROVER_UNRESOLVED',
] as const satisfies readonly string[];

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Códigos por campo usados em `errors[].code` de `VALIDATION_ERROR` (api.md §2.1.1). */
export const FIELD_ERROR_CODES = [
  'REQUIRED',
  'TOO_SHORT',
  'TOO_LONG',
  'INVALID_FORMAT',
  'INVALID_ENUM',
  'OUT_OF_RANGE',
  'DATE_IN_PAST',
  'INVALID_DECIMAL',
  'INVALID_CNPJ',
  'INVALID_CPF',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_INACTIVE',
  'DEPARTMENT_NOT_IN_SECRETARIAT',
  'CONDITIONAL_REQUIRED',
  'DUPLICATE_IN_LIST',
  'NOT_ALLOWED',
] as const satisfies readonly string[];

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

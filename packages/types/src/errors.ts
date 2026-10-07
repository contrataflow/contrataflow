/**
 * Códigos de erro da API (SCREAMING_SNAKE_CASE — DEC-001; docs/mvp-01/api.md §2).
 * Preenchido pela US-080 (esqueleto HTTP e RFC 9457) e pelas stories donas.
 */
export const ERROR_CODES = [] as const satisfies readonly string[];

export type ErrorCode = (typeof ERROR_CODES)[number];

import { FIELD_ERROR_CODES } from '@contrataflow/types';
import { z } from 'zod';

/** Erro de um campo dentro de `VALIDATION_ERROR` (api.md §2.1.1). */
export const fieldErrorSchema = z
  .object({
    field: z.string(),
    code: z.enum(FIELD_ERROR_CODES),
    message: z.string(),
  })
  .meta({ id: 'FieldError' });

export type FieldError = z.infer<typeof fieldErrorSchema>;

/** Violação de regra ou de completude (api.md §2.1.2). */
export const violationSchema = z
  .object({
    code: z.string(),
    severity: z.enum(['BLOCKING', 'WARNING']),
    message: z.string(),
    ruleId: z.string().nullable(),
    sectionKey: z.string().nullable(),
    field: z.string().nullable(),
    itemId: z.string().nullable(),
    params: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'Violation' });

export type Violation = z.infer<typeof violationSchema>;

/**
 * Corpo `application/problem+json` (RFC 9457 · DEC-103 · api.md §2). `code` aceita os genéricos
 * de §2.1 e os de domínio (§2.2), que nascem nas stories donas.
 */
export const problemDetailsSchema = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string(),
    instance: z.string(),
    code: z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/),
    correlationId: z.string(),
    errors: z.array(fieldErrorSchema),
    violations: z.array(violationSchema),
  })
  .catchall(z.unknown())
  .meta({ id: 'ProblemDetails' });

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

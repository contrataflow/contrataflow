import { Body, Param, Query } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import { ptBrErrorMap, toFieldErrors } from './zod-issues.js';
import { validationError } from '../errors/api-error.js';
import { recordRequestSchema } from '../openapi/api-operation.js';

/**
 * Valida `body`/`query`/`params` com um schema de `packages/validation` (DEC-054 · RN-FND-32).
 * Falha → 422 `VALIDATION_ERROR` com `errors[]` (V-02); o valor devolvido é o já convertido.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value, { error: ptBrErrorMap, reportInput: true });
    if (!result.success) throw validationError(toFieldErrors(result.error.issues));
    return result.data;
  }
}

/** `@ZodBody(schema)`: valida o corpo e documenta o schema no OpenAPI. */
export function ZodBody(schema: z.ZodType): ParameterDecorator {
  return (target, propertyKey, index) => {
    Body(new ZodValidationPipe(schema))(target, propertyKey, index);
    if (propertyKey !== undefined) recordRequestSchema(target, propertyKey, 'body', schema);
  };
}

/** `@ZodQuery(schema)`: valida a query string e documenta os parâmetros no OpenAPI. */
export function ZodQuery(schema: z.ZodType): ParameterDecorator {
  return (target, propertyKey, index) => {
    Query(new ZodValidationPipe(schema))(target, propertyKey, index);
    if (propertyKey !== undefined) recordRequestSchema(target, propertyKey, 'query', schema);
  };
}

/** `@ZodParams(schema)`: valida os parâmetros de rota e documenta-os no OpenAPI. */
export function ZodParams(schema: z.ZodType): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param(new ZodValidationPipe(schema))(target, propertyKey, index);
    if (propertyKey !== undefined) recordRequestSchema(target, propertyKey, 'params', schema);
  };
}

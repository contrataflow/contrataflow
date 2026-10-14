import { randomUUID } from 'node:crypto';

import type { ErrorCode } from '@contrataflow/types';
import type { ProblemDetails } from '@contrataflow/validation';
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';

import { ApiError, validationError } from './api-error.js';
import { problemType } from './error-catalog.js';
import { CORRELATION_HEADER } from '../context/correlation.js';
import { currentRequestContext } from '../context/request-context.js';
import { requestPath } from '../http/http-types.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';
import { toFieldErrors } from '../validation/zod-issues.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** Código genérico para exceções HTTP do próprio Nest (rota inexistente, método não suportado…). */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
    case 405:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 422:
      return 'VALIDATION_ERROR';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'DEPENDENCY_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'MALFORMED_REQUEST';
  }
}

/** Normaliza qualquer exceção em `ApiError` (RN-FND-31). `unexpected` = não mapeada (500). */
export function toApiError(exception: unknown): { error: ApiError; unexpected: boolean } {
  if (exception instanceof ApiError) return { error: exception, unexpected: false };
  if (exception instanceof ZodError) {
    // ZodError lançado fora do pipe (ex.: parse na camada application): mesma taxonomia de campos.
    return { error: validationError(toFieldErrors(exception.issues)), unexpected: false };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = codeForStatus(status);
    return { error: new ApiError(code, { cause: exception }), unexpected: status >= 500 };
  }
  return { error: new ApiError('INTERNAL_ERROR', { cause: exception }), unexpected: true };
}

/**
 * Filtro global RFC 9457 (DEC-103 · api.md §2): toda saída de erro vira `application/problem+json`
 * com `code` estável e `correlationId`; exceção não mapeada → 500 `INTERNAL_ERROR` sem detalhe
 * interno (stack só em log `debug`).
 */
@Catch()
export class ProblemDetailsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const { error, unexpected } = toApiError(exception);
    const correlationId = this.correlationId(response);

    if (unexpected) {
      const cause = exception instanceof Error ? exception : undefined;
      this.logger.error(
        `http.unhandled_exception correlationId=${correlationId} errorCode=${error.code} cause=${cause?.name ?? typeof exception}`,
      );
      if (cause?.stack) this.logger.debug(cause.stack);
    }

    const body: ProblemDetails = {
      ...error.extensions,
      type: problemType(error.code),
      title: error.title,
      status: error.status,
      detail: error.detail.replaceAll('{correlationId}', correlationId),
      instance: requestPath(request),
      code: error.code,
      correlationId,
      errors: [...error.errors],
      violations: [...error.violations],
    };

    if (response.headersSent) {
      response.end();
      return;
    }
    response.statusCode = error.status;
    for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value);
    response.setHeader(CORRELATION_HEADER, correlationId);
    response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
    response.end(JSON.stringify(body));
  }

  /** Do contexto; se o erro ocorreu antes do middleware de contexto, do cabeçalho ou gerado. */
  private correlationId(response: HttpResponse): string {
    const fromContext = currentRequestContext()?.correlationId;
    if (fromContext) return fromContext;
    const fromHeader = response.getHeader(CORRELATION_HEADER);
    return typeof fromHeader === 'string' ? fromHeader : randomUUID();
  }
}

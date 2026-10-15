import { uuidv7 } from '@contrataflow/observability';
import type { ErrorCode } from '@contrataflow/types';
import type { ProblemDetails } from '@contrataflow/validation';
import { Catch, HttpException, Inject, Logger, Optional } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { z, ZodError } from 'zod';

import { ApiError, validationError } from './api-error.js';
import { problemType } from './error-catalog.js';
import { AUDIT_TRAIL, AUDITED_DENIAL_CODES } from '../audit/audit-trail.js';
import type { AuditTrailPort } from '../audit/audit-trail.js';
import { CORRELATION_HEADER } from '../context/correlation.js';
import { currentRequestContext } from '../context/request-context.js';
import { annotateProblemCode, UNMATCHED_ROUTE } from '../context/request-context.middleware.js';
import { headerValue, requestPath } from '../http/http-types.js';
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

const uuidSchema = z.uuid();

/**
 * Filtro global RFC 9457 (DEC-103 · api.md §2): toda saída de erro vira `application/problem+json`
 * com `code` estável e `correlationId`; exceção não mapeada → 500 `INTERNAL_ERROR` sem detalhe
 * interno ao cliente — tipo, mensagem redigida e stack ficam só no log `error`, ligado ao trace.
 * Negação de autorização (RN-AUD-10) grava `access.denied` antes de responder; falha ao gravá-la
 * fica no log `audit.write_failed` e não muda a resposta (o acesso continua negado).
 */
@Catch()
export class ProblemDetailsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  constructor(@Optional() @Inject(AUDIT_TRAIL) private readonly audit?: AuditTrailPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const { error, unexpected } = toApiError(exception);
    const correlationId = this.correlationId(response);

    if (unexpected) {
      this.logger.error(
        { event: 'http.unhandled_exception', correlationId, errorCode: error.code, err: exception },
        'unhandled exception',
      );
    }
    annotateProblemCode(response, error.code);
    if (!AUDITED_DENIAL_CODES.has(error.code)) {
      this.send(request, response, error, correlationId);
      return;
    }
    // Negação: grava `access.denied` e só então responde — sem deixar rejeição sem tratamento.
    void this.auditDenial(request, error)
      .then(() => {
        this.send(request, response, error, correlationId);
      })
      .catch((failure: unknown) => {
        this.logger.error(
          { event: 'http.problem_response_failed', correlationId, err: failure },
          'problem response failed',
        );
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
  }

  private send(
    request: HttpRequest,
    response: HttpResponse,
    error: ApiError,
    correlationId: string,
  ): void {
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

  /**
   * `access.denied` (RN-AUD-10): no tenant já validado pelo pipeline ou, antes disso, como registro
   * de plataforma com o tenant pedido em `metadata.requestedTenantId` — quem não tem vínculo não
   * escreve na trilha de um tenant. Sem contexto de requisição (erro antes do middleware), nada.
   */
  private async auditDenial(request: HttpRequest, error: ApiError): Promise<void> {
    const context = currentRequestContext();
    if (!this.audit || !context) return;
    const requested = headerValue(request, 'x-tenant-id');
    const route = request.route?.path;
    try {
      await this.audit.recordStandalone({
        action: 'access.denied',
        result: 'DENIED',
        reasonCode: error.auditReasonCode,
        metadata: {
          code: error.code,
          method: request.method ?? null,
          route: route && !route.includes('{*') ? route : UNMATCHED_ROUTE,
          ...(context.tenantId === null && requested && uuidSchema.safeParse(requested).success
            ? { requestedTenantId: requested.toLowerCase() }
            : {}),
        },
      });
    } catch {
      // Já registrado (`audit.write_failed`) pelo serviço; a resposta continua a negação.
    }
  }

  /** Do contexto; se o erro ocorreu antes do middleware de contexto, do cabeçalho ou gerado. */
  private correlationId(response: HttpResponse): string {
    const fromContext = currentRequestContext()?.correlationId;
    if (fromContext) return fromContext;
    const fromHeader = response.getHeader(CORRELATION_HEADER);
    return typeof fromHeader === 'string' ? fromHeader : uuidv7();
  }
}

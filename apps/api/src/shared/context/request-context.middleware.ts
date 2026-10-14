import { Injectable, Logger } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';

import { CORRELATION_HEADER, resolveCorrelationId } from './correlation.js';
import { currentRequestContext, runWithRequestContext } from './request-context.js';
import { headerValue, requestPath } from '../http/http-types.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';

/**
 * Primeiro elo do pipeline (RN-FND-34): lê/gera o `X-Correlation-Id`, devolve-o em toda resposta
 * e abre o `AsyncLocalStorage` da requisição antes de qualquer guard. Registra
 * `http.request_completed` ao fim (sem corpo, query string nem cabeçalhos sensíveis).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware<HttpRequest, HttpResponse> {
  private readonly logger = new Logger('Http');

  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const correlationId = resolveCorrelationId(headerValue(request, CORRELATION_HEADER));
    response.setHeader(CORRELATION_HEADER, correlationId);
    const startedAt = process.hrtime.bigint();

    runWithRequestContext(
      {
        correlationId,
        ip: request.ip ?? request.socket.remoteAddress ?? '',
        userAgent: headerValue(request, 'user-agent') ?? '',
      },
      () => {
        response.once('finish', () => {
          const context = currentRequestContext();
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          this.logger.log(
            [
              'http.request_completed',
              `method=${request.method ?? ''}`,
              `route=${request.route?.path ?? requestPath(request)}`,
              `status=${response.statusCode}`,
              `durationMs=${durationMs.toFixed(1)}`,
              `tenantId=${context?.tenantId ?? '-'}`,
              `userId=${context?.actor.userId ?? '-'}`,
              `correlationId=${correlationId}`,
            ].join(' '),
          );
        });
        next();
      },
    );
  }
}

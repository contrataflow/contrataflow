import { AsyncResource } from 'node:async_hooks';

import { isIgnoredHttpPath } from '@contrataflow/observability/telemetry';
import { Injectable, Logger } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

import { CORRELATION_HEADER, resolveCorrelationId } from './correlation.js';
import { currentRequestContext, runWithRequestContext } from './request-context.js';
import { headerValue, requestPath } from '../http/http-types.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';

/** Rota sem template (nenhum handler casou): nunca a URL real nos logs. */
export const UNMATCHED_ROUTE = '(unmatched)';

/**
 * Template da rota que atendeu (`/api/v1/processes/:id`). Sem handler, o Express expõe o curinga
 * do próprio middleware (`/api/v1/{*path}`) — tratado como rota não casada.
 */
function routeTemplate(request: HttpRequest): string {
  const path = request.route?.path;
  return path && !path.includes('{*') ? path : UNMATCHED_ROUTE;
}

/** Motivo do 4xx (código estável do `problem+json`), anotado pelo filtro RFC 9457. */
const problemCodes = new WeakMap<HttpResponse, string>();

export function annotateProblemCode(response: HttpResponse, code: string): void {
  problemCodes.set(response, code);
}

/**
 * Primeiro elo do pipeline (RN-FND-34 · RN-FND-74): valida/gera o `X-Correlation-Id`, devolve-o
 * em toda resposta, abre o `AsyncLocalStorage` da requisição antes de qualquer guard e registra
 * `http.request.completed` ao fim — `info` (4xx com `reason`), `error` para 5xx — sem corpo, query
 * string nem cabeçalhos. `/health/*` e `/metrics` não são logados (FA-05).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware<HttpRequest, HttpResponse> {
  private readonly logger = new Logger('Http');

  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const correlationId = resolveCorrelationId(headerValue(request, CORRELATION_HEADER));
    response.setHeader(CORRELATION_HEADER, correlationId);
    const startedAt = process.hrtime.bigint();
    const requestId = (request as { id?: unknown }).id;
    // Span do servidor HTTP (instrumentação OTel): busca do trace pelo correlationId.
    trace.getActiveSpan()?.setAttribute('cf.correlation_id', correlationId);

    runWithRequestContext(
      {
        correlationId,
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ip: request.ip ?? request.socket.remoteAddress ?? '',
        userAgent: headerValue(request, 'user-agent') ?? '',
      },
      () => {
        if (!isIgnoredHttpPath(requestPath(request))) {
          // O `finish` dispara fora da cadeia assíncrona da requisição: o bind mantém o
          // RequestContext, o logger da requisição e o span ativo no log final.
          response.once(
            'finish',
            AsyncResource.bind(() => {
              this.logCompletion(request, response, startedAt);
            }),
          );
        }
        next();
      },
    );
  }

  private logCompletion(request: HttpRequest, response: HttpResponse, startedAt: bigint): void {
    const status = response.statusCode;
    const fields = {
      event: 'http.request.completed',
      method: request.method ?? '',
      route: routeTemplate(request),
      statusCode: status,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
      ...(status >= 400 ? { reason: problemCodes.get(response) ?? null } : {}),
      // Garante a correlação mesmo se o contexto já tiver sido descartado.
      ...(currentRequestContext() ? {} : { correlationId: response.getHeader(CORRELATION_HEADER) }),
    };
    if (status >= 500) this.logger.error(fields, 'request failed');
    else this.logger.log(fields, 'request completed');
  }
}

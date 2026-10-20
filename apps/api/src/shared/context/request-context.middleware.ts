import { AsyncResource } from 'node:async_hooks';

import { isIgnoredHttpPath } from '@contrataflow/observability/telemetry';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { resolveClientAddress, SESSION_HASH_HEADER, trustedProxyList } from './client-address.js';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation.js';
import { currentRequestContext, runWithRequestContext } from './request-context.js';
import { headerValue, requestPath } from '../http/http-types.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';
import { recordHttpRequest } from '../observability/http-metrics.js';

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
  private readonly trustedProxies;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.trustedProxies = trustedProxyList(config.http.trustedProxies);
  }

  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const correlationId = resolveCorrelationId(headerValue(request, CORRELATION_HEADER));
    response.setHeader(CORRELATION_HEADER, correlationId);
    const startedAt = process.hrtime.bigint();
    const requestId = (request as { id?: unknown }).id;
    // Span do servidor HTTP (instrumentação OTel): busca do trace pelo correlationId.
    trace.getActiveSpan()?.setAttribute('cf.correlation_id', correlationId);

    // IP real e sessão do navegador só quando quem conecta é o BFF (RN-AUD-05 · security.md §8).
    const client = resolveClientAddress(
      request.socket.remoteAddress ?? request.ip,
      {
        forwardedFor: headerValue(request, 'x-forwarded-for'),
        sessionIdHash: headerValue(request, SESSION_HASH_HEADER),
      },
      this.trustedProxies,
    );

    runWithRequestContext(
      {
        correlationId,
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...client,
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
    const elapsedNs = Number(process.hrtime.bigint() - startedAt);
    const route = routeTemplate(request);
    // Métrica RED (US-085): rota-template e classe de SLO, nunca o caminho bruto nem o tenant.
    recordHttpRequest({
      method: request.method ?? '',
      route,
      statusCode: status,
      durationSeconds: elapsedNs / 1e9,
      hasSearchQuery: /[?&]q=/.test(request.originalUrl),
    });
    const fields = {
      event: 'http.request.completed',
      method: request.method ?? '',
      route,
      statusCode: status,
      durationMs: Math.round(elapsedNs / 1e5) / 10,
      ...(status >= 400 ? { reason: problemCodes.get(response) ?? null } : {}),
      // Garante a correlação mesmo se o contexto já tiver sido descartado.
      ...(currentRequestContext() ? {} : { correlationId: response.getHeader(CORRELATION_HEADER) }),
    };
    if (status >= 500) this.logger.error(fields, 'request failed');
    else this.logger.log(fields, 'request completed');
  }
}

import 'server-only';

import { clientIpFrom } from './client-ip';
import { clearCookie, readCookie } from './cookies';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { checkCsrf, isMutatingMethod } from './csrf';
import { problemResponse } from './http';
import { log } from './logger';
import { bffRuntime } from './runtime';
import type { BffRuntime } from './runtime';
import { applyApiSecurityHeaders } from './security-headers';
import { SessionStoreUnavailableError } from './session/types';
import type { SessionRecord } from './session/types';
import {
  MAX_BODY_BYTES,
  buildUpstreamHeaders,
  callUpstream,
  filterOutboundHeaders,
  routeTemplate,
} from './upstream';

/*
 * Proxy autenticado `/api/v1/[...path]` (architecture.md §8.4 · RN-FND-89): único caminho do
 * browser até a API. Ordem: correlação → caminho → CSRF → corpo ≤ 2 MB → sessão → token →
 * chamada (timeout 30 s) → 401 da API: uma renovação forçada e nova tentativa; falhou de novo,
 * a sessão é destruída e o browser recebe 401 `SESSION_EXPIRED`.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9._~:@!$&'()*+,;=-]+$/;

/** Segmentos aceitos: sem `.`/`..`, barras ou caracteres fora do conjunto de *path* da RFC 3986. */
export function proxyPath(segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)) return null;
  }
  return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

type BodyRead =
  { readonly kind: 'ok'; readonly body: ArrayBuffer | null } | { readonly kind: 'too_large' };

export async function readLimitedBody(request: Request, limit = MAX_BODY_BYTES): Promise<BodyRead> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) {
    return { kind: 'ok', body: null };
  }
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > limit) return { kind: 'too_large' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { kind: 'too_large' };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', body: body.buffer };
}

export async function handleProxyRequest(
  request: Request,
  segments: readonly string[],
  runtime: BffRuntime = bffRuntime(),
): Promise<Response> {
  const started = runtime.now();
  const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_HEADER));
  const url = new URL(request.url);
  const instance = url.pathname;
  const context = { correlationId, instance };
  const { config, sessions } = runtime;
  const expireCookie = { 'Set-Cookie': clearCookie(config.sessionCookieName) };

  const path = proxyPath(segments);
  if (!path) return problemResponse('NOT_FOUND', context);

  try {
    const csrf = checkCsrf(request.method, request.headers, config.appOrigin);
    if (!csrf.ok) {
      log('warn', 'bff.csrf_rejected', {
        reason: csrf.reason,
        method: request.method,
        correlationId,
      });
      return problemResponse('CSRF_REJECTED', context);
    }

    const body = await readLimitedBody(request);
    if (body.kind === 'too_large') return problemResponse('PAYLOAD_TOO_LARGE', context);

    const lookup = await sessions.lookup(readCookie(request.headers, config.sessionCookieName));
    if (lookup.status === 'none') return problemResponse('UNAUTHENTICATED', context);
    if (lookup.status === 'expired') {
      return problemResponse('SESSION_EXPIRED', { ...context, headers: expireCookie });
    }

    const fresh = await sessions.ensureFreshToken(lookup.record);
    if (fresh.status === 'expired') {
      log('warn', 'bff.session_refresh_failed', { correlationId });
      return problemResponse('SESSION_EXPIRED', { ...context, headers: expireCookie });
    }
    if (fresh.status === 'unavailable') return problemResponse('DEPENDENCY_UNAVAILABLE', context);

    let record: SessionRecord = await sessions.touch(fresh.record);
    const clientIp = clientIpFrom(request.headers.get('X-Forwarded-For'), config.trustedProxies);
    const send = (session: SessionRecord) =>
      callUpstream(runtime, {
        method: request.method,
        path,
        search: url.search,
        headers: buildUpstreamHeaders(request.headers, {
          accessToken: session.tokens.accessToken,
          tenantId: session.activeTenantId,
          correlationId,
          clientIp,
          userAgent: request.headers.get('user-agent'),
          sessionIdHash: session.key,
        }),
        body: body.body,
        signal: request.signal,
      });

    let outcome = await send(record);
    if (outcome.kind === 'response' && outcome.response.status === 401) {
      // Token recusado pela API: uma renovação forçada e uma nova tentativa (corpo já em memória).
      await outcome.response.body?.cancel();
      const retry = await sessions.ensureFreshToken(record, { force: true });
      if (retry.status !== 'ok') {
        if (retry.status === 'expired') {
          log('warn', 'bff.session_refresh_failed', { correlationId });
          return problemResponse('SESSION_EXPIRED', { ...context, headers: expireCookie });
        }
        return problemResponse('DEPENDENCY_UNAVAILABLE', context);
      }
      record = retry.record;
      outcome = await send(record);
      if (outcome.kind === 'response' && outcome.response.status === 401) {
        await outcome.response.body?.cancel();
        await sessions.destroy(record.key);
        log('warn', 'bff.session_refresh_failed', { correlationId, afterRetry: true });
        return problemResponse('SESSION_EXPIRED', { ...context, headers: expireCookie });
      }
    }

    if (outcome.kind !== 'response') {
      log('info', 'bff.proxy_request_completed', {
        route: routeTemplate(path),
        method: request.method,
        status: 503,
        outcome: outcome.kind,
        durationMs: runtime.now() - started,
        correlationId,
      });
      return problemResponse('DEPENDENCY_UNAVAILABLE', context);
    }

    const { response } = outcome;
    const headers = filterOutboundHeaders(response.headers, config.apiInternalUrl);
    if (!headers.has(CORRELATION_HEADER)) headers.set(CORRELATION_HEADER, correlationId);
    applyApiSecurityHeaders(headers, config.cspReportUri);
    log('info', 'bff.proxy_request_completed', {
      route: routeTemplate(path),
      method: request.method,
      status: response.status,
      durationMs: runtime.now() - started,
      correlationId,
      mutating: isMutatingMethod(request.method),
    });
    // Corpo repassado em *streaming* (exportações CSV), sem leitura no BFF.
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof SessionStoreUnavailableError) {
      // Redis de sessões fora: indisponibilidade, nunca "sessão expirada" (DEC-131 · RN-IAM-33).
      log('error', 'bff.session_store_unavailable', { route: routeTemplate(path), correlationId });
      return problemResponse('DEPENDENCY_UNAVAILABLE', {
        ...context,
        headers: { 'Retry-After': '5' },
      });
    }
    log('error', 'bff.unhandled_exception', {
      route: routeTemplate(path),
      errorName: error instanceof Error ? error.name : 'unknown',
      correlationId,
    });
    return problemResponse('INTERNAL_ERROR', context);
  }
}

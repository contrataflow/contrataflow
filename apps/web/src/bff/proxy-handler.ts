import 'server-only';

import { isPollingRequest } from '@/lib/session/polling';

import { clientIpFrom } from './client-ip';
import { readCookie } from './cookies';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { checkCsrf, isMutatingMethod } from './csrf';
import { problemResponse } from './http';
import { log } from './logger';
import { recordProxyRequest } from './metrics';
import { bffRuntime } from './runtime';
import type { BffRuntime } from './runtime';
import { applyApiSecurityHeaders } from './security-headers';
import { SessionStoreUnavailableError } from './session/types';
import type { ClientDetails, SessionRecord } from './session/types';
import { inactiveSessionResponse } from './session-responses';
import {
  MAX_BODY_BYTES,
  buildUpstreamHeaders,
  callUpstream,
  filterOutboundHeaders,
  routeTemplate,
} from './upstream';

/*
 * Proxy autenticado `/api/v1/[...path]` (architecture.md §8.4 · RN-FND-89): único caminho do
 * browser até a API. Ordem: correlação → caminho → CSRF → corpo ≤ 2 MB → sessão (vencida →
 * encerrada com o motivo) → token (renovação com trava se vence em ≤ 60 s) → ociosidade renovada,
 * exceto em sondagem → chamada (timeout 30 s) → 401 da API: uma renovação forçada e nova
 * tentativa; falhou de novo, a sessão é encerrada (`REFRESH_FAILED`) e o browser recebe 401
 * `SESSION_EXPIRED`.
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

/**
 * `PATCH /me` aplicado (US-098 · RN-IAM-110): o nome exibido da sessão passa a ser o nome social,
 * se houver, ou o civil — o menu do usuário reflete a mudança na próxima renderização do shell.
 * Falha aqui nunca derruba a resposta já aplicada pela API.
 */
async function syncDisplayName(
  runtime: BffRuntime,
  record: SessionRecord,
  response: Response,
): Promise<void> {
  try {
    const body = (await response.json()) as {
      data?: { name?: unknown; socialName?: unknown };
    };
    const social = typeof body.data?.socialName === 'string' ? body.data.socialName.trim() : '';
    const name = typeof body.data?.name === 'string' ? body.data.name : '';
    const displayName = social === '' ? name : social;
    if (displayName !== '' && displayName !== record.displayName) {
      await runtime.sessions.setDisplayName(record, displayName);
    }
  } catch (error) {
    log('warn', 'bff.display_name_sync_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
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
  const cookieName = config.sessionCookieName;

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

    const clientIp = clientIpFrom(request.headers.get('X-Forwarded-For'), config.trustedProxies);
    const client: ClientDetails = {
      ip: clientIp,
      userAgent: request.headers.get('user-agent')?.slice(0, 512) ?? null,
    };
    const lookup = await sessions.lookup(readCookie(request.headers, cookieName), client);
    if (lookup.status !== 'active') return inactiveSessionResponse(lookup, context, cookieName);

    const fresh = await sessions.ensureFreshToken(lookup.record, { client });
    if (fresh.status === 'expired' || fresh.status === 'ended') {
      log('warn', 'bff.session_refresh_failed', { correlationId });
      return inactiveSessionResponse(fresh, context, cookieName);
    }
    if (fresh.status === 'unavailable') return problemResponse('DEPENDENCY_UNAVAILABLE', context);

    // Sondagens (contadores) não renovam a ociosidade; ação do usuário renova (RN-IAM-21).
    let record: SessionRecord = isPollingRequest(request.method, path)
      ? fresh.record
      : await sessions.touch(fresh.record);
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

    let upstreamStarted = runtime.now();
    let outcome = await send(record);
    if (outcome.kind === 'response' && outcome.response.status === 401) {
      // Token recusado pela API: uma renovação forçada e uma nova tentativa (corpo já em memória).
      await outcome.response.body?.cancel();
      const retry = await sessions.ensureFreshToken(record, { force: true, client });
      if (retry.status === 'expired' || retry.status === 'ended') {
        log('warn', 'bff.session_refresh_failed', { correlationId });
        return inactiveSessionResponse(retry, context, cookieName);
      }
      if (retry.status === 'unavailable') {
        return problemResponse('DEPENDENCY_UNAVAILABLE', context);
      }
      record = retry.record;
      upstreamStarted = runtime.now();
      outcome = await send(record);
      if (outcome.kind === 'response' && outcome.response.status === 401) {
        // Token recém-renovado também recusado: a sessão não tem como continuar.
        await outcome.response.body?.cancel();
        await sessions.end(record, 'REFRESH_FAILED', { client });
        log('warn', 'bff.session_refresh_failed', { correlationId, afterRetry: true });
        return inactiveSessionResponse({ status: 'expired' }, context, cookieName);
      }
    }

    if (outcome.kind !== 'response') {
      recordProxyRequest({
        method: request.method,
        path,
        status: 503,
        durationSeconds: (runtime.now() - started) / 1_000,
      });
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
    recordProxyRequest({
      method: request.method,
      path,
      status: response.status,
      durationSeconds: (runtime.now() - started) / 1_000,
      upstreamSeconds: (runtime.now() - upstreamStarted) / 1_000,
    });
    log('info', 'bff.proxy_request_completed', {
      route: routeTemplate(path),
      method: request.method,
      status: response.status,
      durationMs: runtime.now() - started,
      correlationId,
      mutating: isMutatingMethod(request.method),
    });
    if (request.method === 'PATCH' && path === '/me' && response.status === 200) {
      await syncDisplayName(runtime, record, response.clone());
    }
    // Corpo repassado em *streaming* (exportações CSV), sem leitura no BFF.
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof SessionStoreUnavailableError) {
      // Redis de sessões fora: indisponibilidade, nunca "sessão expirada" (DEC-131 · RN-IAM-33).
      log('error', 'auth.session_store_unavailable', { route: routeTemplate(path), correlationId });
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

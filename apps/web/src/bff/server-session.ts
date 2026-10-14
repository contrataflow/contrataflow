import 'server-only';

import { cookies, headers } from 'next/headers';

import { ApiError, apiErrorFromResponse } from '@/lib/api/api-error';
import type { ApiResult } from '@/lib/api/client';

import { clientIpFrom } from './client-ip';
import { resolveCorrelationId } from './correlation';
import { NONCE_HEADER, PATHNAME_HEADER } from './edge';
import { bffRuntime } from './runtime';
import type { BffRuntime } from './runtime';
import type { SessionLookup } from './session/session-service';
import { SessionStoreUnavailableError } from './session/types';
import { toShellSession } from './session/view';
import { buildUpstreamHeaders, callUpstream } from './upstream';

/*
 * Sessão e leitura da API em Server Components (architecture.md §8.1/§8.3 · RN-FND-88). Só
 * leitura (`GET`) — mutações passam pelo proxy `/api/v1/*`. Server Components não alteram
 * cookies: sessão vencida aqui é apagada do store e o layout redireciona ao login.
 */

export async function currentPathname(): Promise<string> {
  return (await headers()).get(PATHNAME_HEADER) ?? '/';
}

/** Nonce da CSP desta requisição (scripts inline de terceiros, quando houver). */
export async function currentNonce(): Promise<string | undefined> {
  return (await headers()).get(NONCE_HEADER) ?? undefined;
}

export async function currentSession(runtime: BffRuntime = bffRuntime()): Promise<SessionLookup> {
  const cookieStore = await cookies();
  return runtime.sessions.lookup(cookieStore.get(runtime.config.sessionCookieName)?.value);
}

/**
 * Sessão para páginas: o Redis de sessões fora do ar vira `unavailable` (a página leva a SCR-111
 * "manutenção"), nunca "sem sessão" — a sessão continua válida quando ele voltar (DEC-131).
 */
export async function currentSessionOrUnavailable(
  runtime: BffRuntime = bffRuntime(),
): Promise<SessionLookup | { readonly status: 'unavailable' }> {
  try {
    return await currentSession(runtime);
  } catch (error) {
    if (error instanceof SessionStoreUnavailableError) return { status: 'unavailable' };
    throw error;
  }
}

export async function currentShellSession(runtime: BffRuntime = bffRuntime()) {
  const lookup = await currentSession(runtime);
  return lookup.status === 'active' ? toShellSession(lookup.record) : null;
}

export interface ServerGetOptions {
  readonly query?: Readonly<Record<string, string | number | undefined>> | undefined;
}

/**
 * Cliente de leitura dos Server Components: mesma sessão, renovação de token e cabeçalhos do
 * proxy; devolve `{ data, meta }` como o cliente same-origin, ou lança `ApiError`.
 */
export const apiServerClient = {
  async get<T>(
    path: string,
    options: ServerGetOptions = {},
    runtime: BffRuntime = bffRuntime(),
  ): Promise<ApiResult<T>> {
    const requestHeaders = await headers();
    const correlationId = resolveCorrelationId(requestHeaders.get('X-Correlation-Id'));
    const lookup = await currentSessionOrUnavailable(runtime);
    if (lookup.status === 'unavailable') {
      throw new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId });
    }
    if (lookup.status !== 'active') {
      throw new ApiError({
        status: 401,
        code: lookup.status === 'expired' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED',
        correlationId,
      });
    }
    const fresh = await runtime.sessions.ensureFreshToken(lookup.record);
    if (fresh.status !== 'ok') {
      throw fresh.status === 'expired'
        ? new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId })
        : new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId });
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.size > 0 ? `?${params.toString()}` : '';
    const outcome = await callUpstream(runtime, {
      method: 'GET',
      path,
      search,
      headers: buildUpstreamHeaders(null, {
        accessToken: fresh.record.tokens.accessToken,
        tenantId: fresh.record.activeTenantId,
        correlationId,
        clientIp: clientIpFrom(
          requestHeaders.get('X-Forwarded-For'),
          runtime.config.trustedProxies,
        ),
      }),
      body: null,
    });
    if (outcome.kind !== 'response') {
      throw new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId });
    }
    const { response } = outcome;
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      body = null;
    }
    if (!response.ok) throw apiErrorFromResponse(response.status, response.headers, body);
    const envelope = (body ?? {}) as { data?: T; meta?: Record<string, unknown> };
    return {
      data: envelope.data as T,
      status: response.status,
      meta: {
        ...(envelope.meta ?? {}),
        etag: response.headers.get('ETag'),
        correlationId: response.headers.get('X-Correlation-Id') ?? correlationId,
        replayed: response.headers.get('Idempotent-Replayed') === 'true',
      },
    };
  },
};

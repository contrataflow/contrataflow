import 'server-only';

import { CORRELATION_HEADER } from './correlation';

/*
 * Chamada do BFF à API interna (architecture.md §8.4 · RN-FND-89). Os cabeçalhos são
 * reconstruídos do zero: só a allowlist de entrada vem do browser; `Authorization`,
 * `X-Tenant-Id`, `X-Correlation-Id`, `X-Forwarded-For` e `X-CF-Session-Id-Hash` vêm da sessão/BFF.
 * `Cookie` e qualquer `Authorization`/`X-Tenant-Id`/`X-Forwarded-*` do browser são descartados.
 * O `User-Agent` do navegador segue para a auditoria da API (US-073 · RN-AUD-05).
 */

export const API_PREFIX = '/api/v1';
export const UPSTREAM_TIMEOUT_MS = 30_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** SHA-256 do id da sessão (`AuditLog.sessionIdHash`), aceito pela API só vindo do BFF. */
export const SESSION_HASH_HEADER = 'X-CF-Session-Id-Hash';

/** Tamanho de `AuditLog.userAgent` (entities.md §4). */
const MAX_USER_AGENT_LENGTH = 512;

export const INBOUND_HEADER_ALLOWLIST = [
  'content-type',
  'if-match',
  'idempotency-key',
  'accept',
] as const;

/**
 * Saída: allowlist da arquitetura mais `Content-Type`/`Content-Disposition`, necessários ao corpo
 * e ao *streaming* de exportações CSV (PRC-34).
 */
export const OUTBOUND_HEADER_ALLOWLIST = [
  'content-type',
  'content-disposition',
  'etag',
  'location',
  'idempotent-replayed',
  'retry-after',
  'x-correlation-id',
] as const;

export function isAllowedOutboundHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (OUTBOUND_HEADER_ALLOWLIST as readonly string[]).includes(lower) ||
    lower.startsWith('ratelimit-')
  );
}

export interface UpstreamIdentity {
  readonly accessToken: string;
  readonly tenantId: string | null;
  readonly correlationId: string;
  readonly clientIp: string | null;
  /** User-agent do navegador; ausente → o do próprio BFF. */
  readonly userAgent?: string | null;
  /** `SessionRecord.key` (SHA-256 do id da sessão). */
  readonly sessionIdHash?: string | null;
}

export function buildUpstreamHeaders(inbound: Headers | null, identity: UpstreamIdentity): Headers {
  const headers = new Headers();
  if (inbound) {
    for (const name of INBOUND_HEADER_ALLOWLIST) {
      const value = inbound.get(name);
      if (value !== null) headers.set(name, value);
    }
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  headers.set('Authorization', `Bearer ${identity.accessToken}`);
  if (identity.tenantId) headers.set('X-Tenant-Id', identity.tenantId);
  headers.set(CORRELATION_HEADER, identity.correlationId);
  if (identity.clientIp) headers.set('X-Forwarded-For', identity.clientIp);
  if (identity.userAgent)
    headers.set('User-Agent', identity.userAgent.slice(0, MAX_USER_AGENT_LENGTH));
  if (identity.sessionIdHash) headers.set(SESSION_HASH_HEADER, identity.sessionIdHash);
  return headers;
}

export function filterOutboundHeaders(upstream: Headers, apiInternalUrl: string): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    if (!isAllowedOutboundHeader(name)) return;
    // `Location` absoluta da rede interna vira caminho relativo (a API nunca é exposta).
    if (name.toLowerCase() === 'location' && value.startsWith(apiInternalUrl)) {
      headers.set(name, value.slice(apiInternalUrl.length) || '/');
      return;
    }
    headers.set(name, value);
  });
  return headers;
}

/** O que a chamada à API usa do runtime do BFF (estrutural — sem depender de `runtime.ts`). */
export interface UpstreamContext {
  readonly fetch: typeof fetch;
  readonly config: { readonly apiInternalUrl: string };
  readonly upstreamTimeoutMs: number;
}

export type UpstreamOutcome =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' };

export async function callUpstream(
  runtime: UpstreamContext,
  request: {
    readonly method: string;
    /** Caminho relativo a `/api/v1` (começa com `/`). */
    readonly path: string;
    readonly search: string;
    readonly headers: Headers;
    readonly body: ArrayBuffer | null;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<UpstreamOutcome> {
  const timeout = AbortSignal.timeout(runtime.upstreamTimeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  try {
    const response = await runtime.fetch(
      `${runtime.config.apiInternalUrl}${API_PREFIX}${request.path}${request.search}`,
      {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        cache: 'no-store',
        signal,
      },
    );
    return { kind: 'response', response };
  } catch {
    return timeout.aborted ? { kind: 'timeout' } : { kind: 'network' };
  }
}

/** Template do caminho para log (ids e números substituídos — nunca dados). */
export function routeTemplate(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^\d+$/.test(segment)
        ? ':id'
        : segment,
    )
    .join('/');
}

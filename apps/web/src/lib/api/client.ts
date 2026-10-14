import { CORRELATION_HEADER, uuidv7 } from '@contrataflow/observability/correlation';

import { ApiError, apiErrorFromResponse } from './api-error';

/*
 * Cliente same-origin dos Client Components (architecture.md §8.4/§8.5 · RN-FND-89/90): único
 * caminho de leitura e mutação do browser, sempre via proxy `/api/v1/*` do BFF (sem Server
 * Actions). Envia `X-CF-Request` (CSRF), `If-Match`, `Idempotency-Key` e o `X-Correlation-Id` da
 * ação do usuário (reutilizado nas retentativas — observability.md §3); expõe `ETag` em
 * `meta.etag` e converte problem+json em `ApiError`.
 */

export const API_PROXY_PREFIX = '/api/v1';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiMeta {
  /** `ETag` da resposta, reenviado como `If-Match` pela mutação correspondente. */
  readonly etag: string | null;
  readonly correlationId: string | null;
  /** `Idempotent-Replayed: true` (resposta repetida pela API). */
  readonly replayed: boolean;
  readonly [key: string]: unknown;
}

export interface ApiResult<T> {
  readonly data: T;
  readonly meta: ApiMeta;
  readonly status: number;
}

export interface ApiRequestOptions {
  readonly method?: HttpMethod | undefined;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
  readonly body?: unknown;
  readonly ifMatch?: string | null | undefined;
  readonly idempotencyKey?: string | undefined;
  /** Um por ação do usuário; o BFF gera um se ausente. */
  readonly correlationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export function apiUrl(path: string, query?: ApiRequestOptions['query']): string {
  if (!path.startsWith('/')) throw new Error(`Caminho da API deve começar com "/": ${path}`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return `${API_PROXY_PREFIX}${path}${search ? `?${search}` : ''}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function envelopeMeta(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && 'meta' in body) {
    const meta = body.meta;
    if (typeof meta === 'object' && meta !== null) return meta as Record<string, unknown>;
  }
  return {};
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json', 'X-CF-Request': '1' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.ifMatch) headers.set('If-Match', options.ifMatch);
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.correlationId) headers.set(CORRELATION_HEADER, options.correlationId);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(apiUrl(path, options.query), {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal: options.signal ?? null,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'Falha de rede.' });
  }

  const body = await readJson(response);
  if (!response.ok) throw apiErrorFromResponse(response.status, response.headers, body);

  const data = (
    typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined
  ) as T;
  return {
    data,
    status: response.status,
    meta: {
      ...envelopeMeta(body),
      etag: response.headers.get('ETag'),
      correlationId: response.headers.get('X-Correlation-Id'),
      replayed: response.headers.get('Idempotent-Replayed') === 'true',
    },
  };
}

/** Falhas transitórias em que a mesma `Idempotency-Key` pode ser reenviada com segurança. */
export function isRetryableMutationError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    error.code === 'IDEMPOTENCY_IN_PROGRESS' ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504
  );
}

export interface RetryOptions {
  /** Tentativas além da primeira. */
  readonly retries?: number | undefined;
  readonly baseDelayMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Reexecuta uma mutação idempotente em falha transitória — a função recebe sempre a mesma chave,
 * gerada uma vez por intenção do usuário (DEC-105 · RN-FND-90).
 */
export async function retryIdempotent<T>(
  run: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retries || !isRetryableMutationError(error)) throw error;
      const retryAfter = error instanceof ApiError ? error.retryAfterSeconds : null;
      await sleep(retryAfter === null ? baseDelayMs * 2 ** attempt : retryAfter * 1000);
    }
  }
}

/** Nova chave de idempotência (UUID v4). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Novo `correlationId` de uma ação do usuário (UUIDv7, aceito pelo BFF — RN-FND-74). */
export function newCorrelationId(): string {
  return uuidv7();
}

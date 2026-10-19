import { CORRELATION_HEADER, uuidv7 } from '@contrataflow/observability/correlation';

import { isPollingRequest } from '@/lib/session/polling';
import { emitSessionSignal } from '@/lib/session/session-signals';

import { ApiError, apiErrorFromResponse } from './api-error';

/*
 * Cliente same-origin dos Client Components (architecture.md §8.4/§8.5 · RN-FND-89/90): único
 * caminho de leitura e mutação do browser, sempre via proxy `/api/v1/*` do BFF (sem Server
 * Actions). Envia `X-CF-Request` (CSRF), `If-Match`, `Idempotency-Key` e o `X-Correlation-Id` da
 * ação do usuário (reutilizado nas retentativas — observability.md §3); expõe `ETag` em
 * `meta.etag` e converte problem+json em `ApiError`. Interceptador da sessão (US-088): toda ação do
 * usuário atendida reinicia o contador de ociosidade do shell (sondagens não), 401
 * `SESSION_EXPIRED` abre o modal e 503 de um comando (não de uma sondagem de escrita, como o heartbeat
 * de presença), o banner de indisponibilidade (consultas com 5xx
 * já vão ao `error.tsx` do segmento, que mostra a indisponibilidade com "Tentar novamente").
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
  /** Membros irmãos de `data` fixados no contrato (ex.: `upload` de ATT-02 — US-068). */
  readonly members?: Readonly<Record<string, unknown>>;
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

/** Membros do envelope além de `data`/`meta` (`{ data, upload }` de ATT-02). */
function envelopeMembers(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const members: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'data' && key !== 'meta') members[key] = value;
  }
  return members;
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
  // `FormData` (upload multipart — PRS-18): o navegador monta o `Content-Type` com o `boundary`.
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers.set('Content-Type', 'application/json');
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
      body:
        options.body === undefined ? null : isForm ? options.body : JSON.stringify(options.body),
      signal: options.signal ?? null,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    if (method !== 'GET' && !isPollingRequest(method, path)) {
      emitSessionSignal({ type: 'unavailable' });
    }
    throw new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'Falha de rede.' });
  }

  const body = await readJson(response);
  if (!response.ok) {
    const error = apiErrorFromResponse(response.status, response.headers, body);
    if (error.status === 401 && error.code === 'SESSION_EXPIRED') {
      emitSessionSignal({ type: 'expired' });
    } else if (error.status === 503 && method !== 'GET' && !isPollingRequest(method, path)) {
      emitSessionSignal({ type: 'unavailable' });
    }
    throw error;
  }
  if (!isPollingRequest(method, path)) emitSessionSignal({ type: 'activity' });

  const data = (
    typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined
  ) as T;
  const members = envelopeMembers(body);
  return {
    data,
    status: response.status,
    ...(Object.keys(members).length > 0 ? { members } : {}),
    meta: {
      ...envelopeMeta(body),
      etag: response.headers.get('ETag'),
      correlationId: response.headers.get('X-Correlation-Id'),
      replayed: response.headers.get('Idempotent-Replayed') === 'true',
    },
  };
}

export interface ApiDownload {
  readonly blob: Blob;
  /** Nome do `Content-Disposition` (`filename="…"`); `null` sem o cabeçalho. */
  readonly fileName: string | null;
  readonly contentType: string | null;
  readonly correlationId: string | null;
}

/** `filename` de `Content-Disposition: attachment; filename="…"` (RFC 6266, forma simples). */
export function fileNameFromDisposition(header: string | null): string | null {
  const match = header === null ? null : /filename="?([^";]+)"?/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Download de arquivo (GET) pelo proxy do BFF — ex.: exportação CSV/NDJSON da auditoria (AUD-03 ·
 * US-075). Mesmos cabeçalhos e sinais de sessão de `apiRequest`; erro → `ApiError` (problem+json).
 */
export async function apiDownload(
  path: string,
  options: Pick<ApiRequestOptions, 'query' | 'correlationId' | 'signal' | 'fetchImpl'> = {},
): Promise<ApiDownload> {
  const headers = new Headers({ Accept: '*/*', 'X-CF-Request': '1' });
  if (options.correlationId) headers.set(CORRELATION_HEADER, options.correlationId);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(apiUrl(path, options.query), {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal ?? null,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'Falha de rede.' });
  }
  if (!response.ok) {
    const error = apiErrorFromResponse(response.status, response.headers, await readJson(response));
    if (error.status === 401 && error.code === 'SESSION_EXPIRED') {
      emitSessionSignal({ type: 'expired' });
    }
    throw error;
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    // Conexão interrompida no meio do envio: o arquivo não está completo (AUD-03).
    throw new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail: 'Falha de rede.' });
  }
  emitSessionSignal({ type: 'activity' });
  return {
    blob,
    fileName: fileNameFromDisposition(response.headers.get('Content-Disposition')),
    contentType: response.headers.get('Content-Type'),
    correlationId: response.headers.get('X-Correlation-Id'),
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

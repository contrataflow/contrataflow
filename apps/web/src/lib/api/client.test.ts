import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-error';
import {
  apiRequest,
  apiUrl,
  isRetryableMutationError,
  newCorrelationId,
  newIdempotencyKey,
  retryIdempotent,
} from './client';

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>(() => Promise.resolve(response));
}

describe('apiRequest (same-origin via proxy)', () => {
  it('GET com query, X-CF-Request e meta.etag', async () => {
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify({ data: [{ id: 1 }], meta: { page: 2, totalPages: 5 } }), {
        headers: { ETag: '"7"', 'X-Correlation-Id': 'c-1' },
      }),
    );
    const result = await apiRequest<{ id: number }[]>('/processes', {
      query: { page: 2, status: undefined, archived: false },
      fetchImpl,
    });
    expect(result).toEqual({
      data: [{ id: 1 }],
      status: 200,
      meta: { page: 2, totalPages: 5, etag: '"7"', correlationId: 'c-1', replayed: false },
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/processes?page=2&archived=false');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-CF-Request')).toBe('1');
    expect(headers.get('Content-Type')).toBeNull();
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
  });

  it('mutação reenvia If-Match e Idempotency-Key; 204 sem corpo', async () => {
    const fetchImpl = fetchReturning(
      new Response(null, { status: 204, headers: { 'Idempotent-Replayed': 'true' } }),
    );
    const result = await apiRequest('/processes/1', {
      method: 'PATCH',
      body: { title: 'x' },
      ifMatch: '"7"',
      idempotencyKey: 'k-1',
      fetchImpl,
    });
    expect(result.data).toBeUndefined();
    expect(result.meta.replayed).toBe(true);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"title":"x"}');
    expect(headers.get('If-Match')).toBe('"7"');
    expect(headers.get('Idempotency-Key')).toBe('k-1');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('erro → ApiError com o problem+json', async () => {
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify({ code: 'VERSION_CONFLICT' }), {
        status: 412,
        headers: { 'X-Correlation-Id': 'c-2' },
      }),
    );
    await expect(apiRequest('/processes/1', { fetchImpl })).rejects.toMatchObject({
      status: 412,
      code: 'VERSION_CONFLICT',
      correlationId: 'c-2',
    });
    const html = fetchReturning(new Response('<html>', { status: 502 }));
    await expect(apiRequest('/x', { fetchImpl: html })).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });

  it('falha de rede → 503; cancelamento propaga AbortError', async () => {
    const offline = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiRequest('/x', { fetchImpl: offline })).rejects.toMatchObject({ status: 503 });
    const aborted = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException('cancelado', 'AbortError')),
    );
    await expect(apiRequest('/x', { fetchImpl: aborted })).rejects.toThrow('cancelado');
  });

  it('caminho sem barra inicial é erro de programação', () => {
    expect(() => apiUrl('processes')).toThrow(/começar com/);
  });
});

describe('Idempotency-Key por intenção (DEC-105)', () => {
  it('reenvia a mesma chave em IDEMPOTENCY_IN_PROGRESS e 503', async () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const keys: string[] = [];
    const sleep = vi.fn(() => Promise.resolve());
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError({ status: 409, code: 'IDEMPOTENCY_IN_PROGRESS' }))
      .mockRejectedValueOnce(
        new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', retryAfterSeconds: 2 }),
      )
      .mockResolvedValueOnce('ok');
    const result = await retryIdempotent(
      () => {
        keys.push(key);
        return run();
      },
      { sleep, baseDelayMs: 10 },
    );
    expect(result).toBe('ok');
    expect(new Set(keys)).toEqual(new Set([key]));
    expect(sleep.mock.calls).toEqual([[10], [2000]]);
  });

  it('não repete erro definitivo e respeita o limite', async () => {
    const validation = new ApiError({ status: 422, code: 'VALIDATION_ERROR' });
    const run = vi.fn(() => Promise.reject(validation));
    await expect(retryIdempotent(run, { sleep: () => Promise.resolve() })).rejects.toBe(validation);
    expect(run).toHaveBeenCalledTimes(1);

    const busy = vi.fn(() =>
      Promise.reject(new ApiError({ status: 502, code: 'DEPENDENCY_UNAVAILABLE' })),
    );
    await expect(
      retryIdempotent(busy, { retries: 2, sleep: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(busy).toHaveBeenCalledTimes(3);
    expect(isRetryableMutationError(new Error('x'))).toBe(false);
    expect(isRetryableMutationError(new ApiError({ status: 504, code: 'X' }))).toBe(true);
  });

  it('espera padrão real entre tentativas', async () => {
    const run = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' }))
      .mockResolvedValueOnce(1);
    await expect(retryIdempotent(run, { baseDelayMs: 1 })).resolves.toBe(1);
  });
});

describe('correlationId por ação do usuário (US-084 — cenário "Duplicidade")', () => {
  it('a retentativa automática após falha de rede reenvia o mesmo X-Correlation-Id', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ data: { id: 1 } }, { status: 201 }));
    const correlationId = newCorrelationId();
    const result = await retryIdempotent(
      () =>
        apiRequest('/processes', {
          method: 'POST',
          body: {},
          idempotencyKey: 'k-retry',
          correlationId,
          fetchImpl,
        }),
      { sleep: () => Promise.resolve() },
    );
    expect(result.status).toBe(201);
    const sent = fetchImpl.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('X-Correlation-Id'),
    );
    expect(sent).toEqual([correlationId, correlationId]);
  });

  it('gera UUIDv7 aceito pelo BFF e omite o cabeçalho quando não há ação', async () => {
    expect(newCorrelationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const fetchImpl = fetchReturning(Response.json({ data: null }));
    await apiRequest('/x', { fetchImpl });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has('X-Correlation-Id')).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { exampleKeys } from '@/features/_example/example.api';
import { ApiError } from '@/lib/api/api-error';

import {
  assertQueryKeyConvention,
  isTenantKey,
  isUserKey,
  meKeys,
  permissionKeys,
  tenantKey,
} from './keys';
import {
  DEFAULT_STALE_TIME_MS,
  makeQueryClient,
  makeServerQueryClient,
  shouldRetryQuery,
  shouldThrowToBoundary,
  subscribeToErrors,
} from './query-client';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';

describe('query keys particionadas por tenant (RN-FND-90)', () => {
  it('toda chave de tenant começa por [t, tenantId]', () => {
    expect(tenantKey(A, 'processes', 'list', { page: 1 })).toEqual([
      't',
      A,
      'processes',
      'list',
      { page: 1 },
    ]);
    expect(permissionKeys.all(A)).toEqual(['t', A, 'me', 'permissions']);
    for (const key of [exampleKeys.ping(A), exampleKeys.items(A, 2), exampleKeys.all(A)]) {
      expect(key.slice(0, 2)).toEqual(['t', A]);
      expect(() => {
        assertQueryKeyConvention(key);
      }).not.toThrow();
    }
  });

  it('tenantId vazio é recusado', () => {
    expect(() => tenantKey('', 'x')).toThrow(/tenantId obrigatório/);
  });

  it('exceções: só dados do usuário independentes de tenant', () => {
    expect(isUserKey(meKeys.all)).toBe(true);
    expect(isUserKey(meKeys.memberships)).toBe(true);
    expect(isUserKey(['me', 'permissions'])).toBe(false);
    expect(() => {
      assertQueryKeyConvention(['processes']);
    }).toThrow(/fora da convenção/);
  });

  it('isTenantKey filtra por tenant', () => {
    expect(isTenantKey(exampleKeys.ping(A), A)).toBe(true);
    expect(isTenantKey(exampleKeys.ping(A), B)).toBe(false);
    expect(isTenantKey(['t', 1])).toBe(false);
  });
});

describe('QueryClient', () => {
  it('padrões de architecture.md §8.5', () => {
    const client = makeQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.mutations?.retry).toBe(false);
    expect(makeServerQueryClient().getDefaultOptions().queries?.retry).toBe(false);
  });

  it('retenta só falhas de servidor/rede, até 2 vezes', () => {
    expect(shouldRetryQuery(0, new ApiError({ status: 404, code: 'NOT_FOUND' }))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' }))).toBe(
      true,
    );
    expect(shouldRetryQuery(2, new Error('rede'))).toBe(false);
  });

  it('404 e 5xx vão ao boundary; 401/403/409/422/429 não', () => {
    expect(shouldThrowToBoundary(new ApiError({ status: 404, code: 'NOT_FOUND' }))).toBe(true);
    expect(shouldThrowToBoundary(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }))).toBe(true);
    expect(shouldThrowToBoundary(new Error('x'))).toBe(true);
    for (const status of [401, 403, 409, 422, 429]) {
      expect(shouldThrowToBoundary(new ApiError({ status, code: 'X' }))).toBe(false);
    }
  });

  it('assina erros de consultas e mutações', async () => {
    const client = makeQueryClient();
    const onError = vi.fn();
    const stop = subscribeToErrors(client, onError);
    const failure = new ApiError({ status: 422, code: 'VALIDATION_ERROR' });
    await client
      .query({ queryKey: ['t', A, 'x'], queryFn: () => Promise.reject(failure), retry: false })
      .catch(() => undefined);
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(failure) })
      .execute(undefined)
      .catch(() => undefined);
    expect(onError.mock.calls).toEqual([
      [failure, 'query'],
      [failure, 'mutation'],
    ]);
    stop();
    await client
      .query({ queryKey: ['t', A, 'y'], queryFn: () => Promise.reject(failure), retry: false })
      .catch(() => undefined);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

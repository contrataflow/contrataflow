import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '#config/env.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';

import { InMemoryCacheStore } from './cache-store.js';
import type { CacheStore } from './cache-store.js';
import { CacheKeyError, PlatformCache, TenantCache } from './tenant-cache.js';
import { TenantContextMissingError, TenantIsolationViolationError } from '../tenancy/isolation.js';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';
const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://cf_app:x@127.0.0.1:1/contrataflow',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1',
  OIDC_ISSUER_URL: 'https://issuer.contrataflow.test/',
});

const counter = z.strictObject({ value: z.number() });

function inTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-cache', ip: '', userAgent: '' }, () => {
    if (tenantId !== null) updateRequestContext({ tenantId });
    return fn();
  });
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantCache (RN-TEN-29 · multi-tenancy.md §7)', () => {
  it('[Sucesso] a chave nasce do tenant do contexto: o mesmo recurso lógico de A e B não colide', async () => {
    const store = new InMemoryCacheStore();
    const cache = new TenantCache(store, config);
    await inTenant(A, () => cache.set('access', 'eff:m1', { value: 1 }, { ttlSeconds: 60 }));
    await inTenant(B, () => cache.set('access', 'eff:m1', { value: 2 }, { ttlSeconds: 60 }));
    expect([...store.entries.keys()].sort()).toEqual([
      `cf:test:t:${A}:access:eff:m1`,
      `cf:test:t:${B}:access:eff:m1`,
    ]);
    expect(await inTenant(A, () => cache.get('access', 'eff:m1', counter))).toEqual({ value: 1 });
    // Invalidação em A não afeta B.
    await inTenant(A, () => cache.delete('access', 'eff:m1'));
    expect(await inTenant(A, () => cache.get('access', 'eff:m1', counter))).toBeNull();
    expect(await inTenant(B, () => cache.get('access', 'eff:m1', counter))).toEqual({ value: 2 });
  });

  it('[Validação] sem tenant no contexto falha fechado, sem tocar no Redis', async () => {
    const get = vi.fn(() => Promise.resolve(null));
    const store: CacheStore = { get, set: vi.fn(), delete: vi.fn() };
    const cache = new TenantCache(store, config);
    await expect(inTenant(null, () => cache.get('access', 'k', counter))).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    expect(get).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security.tenant_context_missing', barrier: 'cache' }),
      'security.tenant_context_missing',
    );
  });

  it('[Tenant incorreto] chave já com escopo (de outro tenant) é violação V-08', async () => {
    const cache = new TenantCache(new InMemoryCacheStore(), config);
    for (const key of [`cf:test:t:${B}:access:x`, `t:${B}:x`, 'p:status']) {
      await expect(inTenant(A, () => cache.get('access', key, counter))).rejects.toBeInstanceOf(
        TenantIsolationViolationError,
      );
    }
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security.tenant_isolation_violation', barrier: 'cache' }),
      'security.tenant_isolation_violation',
    );
  });

  it('módulo/chave com curinga e TTL ausente ou excessivo são erros de programação', async () => {
    const cache = new TenantCache(new InMemoryCacheStore(), config);
    await inTenant(A, async () => {
      await expect(cache.get('Access', 'k', counter)).rejects.toBeInstanceOf(CacheKeyError);
      await expect(cache.get('access', 'k*', counter)).rejects.toBeInstanceOf(CacheKeyError);
      await expect(cache.set('access', 'k', 1, { ttlSeconds: 0 })).rejects.toBeInstanceOf(
        CacheKeyError,
      );
      await expect(
        cache.set('access', 'k', 1, { ttlSeconds: 8 * 24 * 3600 }),
      ).rejects.toBeInstanceOf(CacheKeyError);
    });
  });

  it('getOrSet: lê do cache, carrega na ausência e degrada para o carregamento com o Redis fora', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryCacheStore();
    const cache = new TenantCache(store, config);
    const load = vi.fn(() => Promise.resolve({ value: 7 }));
    const options = { ttlSeconds: 30, schema: counter };
    await inTenant(A, async () => {
      expect(await cache.getOrSet('access', 'k', load, options)).toEqual({ value: 7 });
      expect(await cache.getOrSet('access', 'k', load, options)).toEqual({ value: 7 });
    });
    expect(load).toHaveBeenCalledTimes(1);

    // Valor corrompido ou de outra versão: ausência, não exceção.
    store.entries.set(`cf:test:t:${A}:access:k`, { value: '{"value":"x"}', expiresAt: Infinity });
    await inTenant(A, () => cache.getOrSet('access', 'k', load, options));
    expect(load).toHaveBeenCalledTimes(2);

    const down: CacheStore = {
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      set: () => Promise.reject(new Error('ECONNREFUSED')),
      delete: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const offline = new TenantCache(down, config);
    expect(await inTenant(A, () => offline.getOrSet('access', 'k', load, options))).toEqual({
      value: 7,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cache.unavailable', module: 'access' }),
      'cache.unavailable',
    );
  });

  it('getOrSet: falha ao gravar depois de carregar não derruba a operação', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store: CacheStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error('READONLY')),
      delete: () => Promise.resolve(),
    };
    const cache = new TenantCache(store, config);
    const value = await inTenant(A, () =>
      cache.getOrSet('access', 'k', () => Promise.resolve({ value: 1 }), {
        ttlSeconds: 30,
        schema: counter,
      }),
    );
    expect(value).toEqual({ value: 1 });
  });
});

describe('PlatformCache e InMemoryCacheStore', () => {
  it('chave de plataforma sem tenant, mesmo sem contexto', async () => {
    const store = new InMemoryCacheStore();
    const cache = new PlatformCache(store, config);
    await cache.set('tenant-status', A, { value: 1 }, { ttlSeconds: 30 });
    expect([...store.entries.keys()]).toEqual([`cf:test:p:tenant-status:${A}`]);
    expect(cache.keyFor('tenant-status', A)).toBe(`cf:test:p:tenant-status:${A}`);
  });

  it('respeita o TTL', async () => {
    let now = 1_000;
    const store = new InMemoryCacheStore(() => now);
    await store.set('k', 'v', 2);
    expect(await store.get('k')).toBe('v');
    now += 2_000;
    expect(await store.get('k')).toBeNull();
    expect(store.entries.has('k')).toBe(false);
  });
});

import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import type { TenantStatusPort } from '#shared/auth/ports.js';
import { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { PlatformCache } from '#shared/cache/tenant-cache.js';

import { TENANT_STATUS_TTL_SECONDS, TenantStatusCache } from './tenant-status.cache.js';

const A = '0192a000-0000-7000-8000-00000000000a';
const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://cf_app:x@127.0.0.1:1/contrataflow',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1',
  OIDC_ISSUER_URL: 'https://issuer.contrataflow.test/',
});

function source(status: Awaited<ReturnType<TenantStatusPort['findStatus']>> = 'ACTIVE') {
  return { findStatus: vi.fn(() => Promise.resolve(status)) };
}

const downStore: CacheStore = {
  get: () => Promise.reject(new Error('ECONNREFUSED')),
  set: () => Promise.reject(new Error('ECONNREFUSED')),
  delete: () => Promise.reject(new Error('ECONNREFUSED')),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantStatusCache (US-100 · passo 4 do fluxo principal)', () => {
  it('lê do banco na primeira vez e do cache (30 s) nas seguintes, em cf:{env}:p:tenant-status', async () => {
    const store = new InMemoryCacheStore();
    const db = source('OFFBOARDING');
    const cache = new TenantStatusCache(db, new PlatformCache(store, config));
    expect(await cache.findStatus(A)).toBe('OFFBOARDING');
    expect(await cache.findStatus(A)).toBe('OFFBOARDING');
    expect(db.findStatus).toHaveBeenCalledTimes(1);
    const entry = store.entries.get(`cf:test:p:tenant-status:${A}`);
    expect(entry?.value).toBe('{"status":"OFFBOARDING"}');
    expect(TENANT_STATUS_TTL_SECONDS).toBe(30);
  });

  it('tenant inexistente também fica em cache (IDs forjados não martelam o banco)', async () => {
    const db = source(null);
    const cache = new TenantStatusCache(db, new PlatformCache(new InMemoryCacheStore(), config));
    expect(await cache.findStatus(A)).toBeNull();
    expect(await cache.findStatus(A)).toBeNull();
    expect(db.findStatus).toHaveBeenCalledTimes(1);
  });

  it('invalidate descarta o status; a próxima leitura volta ao banco', async () => {
    const db = source('ACTIVE');
    const cache = new TenantStatusCache(db, new PlatformCache(new InMemoryCacheStore(), config));
    await cache.findStatus(A);
    db.findStatus.mockResolvedValueOnce('SUSPENDED');
    await cache.invalidate(A);
    expect(await cache.findStatus(A)).toBe('SUSPENDED');
  });

  it('[Falha de integração] Redis indisponível: status lido do banco e warn tenant.status_cache_unavailable', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let now = 0;
    const db = source('ACTIVE');
    const cache = new TenantStatusCache(db, new PlatformCache(downStore, config), () => now);
    expect(await cache.findStatus(A)).toBe('ACTIVE');
    expect(await cache.findStatus(A)).toBe('ACTIVE');
    expect(db.findStatus).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'tenant.status_cache_unavailable', errorName: 'Error' }),
      'tenant.status_cache_unavailable',
    );
    // No máximo um aviso a cada 30 s durante a queda.
    expect(warn).toHaveBeenCalledTimes(1);
    now += 30_000;
    await cache.invalidate(A);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('falha só na gravação do cache: devolve o status do banco', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store: CacheStore = { ...downStore, get: () => Promise.resolve(null) };
    const cache = new TenantStatusCache(source('ACTIVE'), new PlatformCache(store, config));
    expect(await cache.findStatus(A)).toBe('ACTIVE');
  });
});

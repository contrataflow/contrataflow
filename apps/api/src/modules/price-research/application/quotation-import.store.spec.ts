import { describe, expect, it } from 'vitest';

import { loadConfig } from '#config/env.js';
import { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';

import { QuotationImportStore } from './quotation-import.store.js';

/*
 * US-028 — token da prévia (DoD "Token de prévia expira corretamente aos 15 minutos"): TTL de 15
 * minutos no Redis, vencido = `EXPIRED` (410) e desconhecido = `UNKNOWN` (404), chave do tenant do
 * contexto (token de outro tenant não existe) e Redis fora → 503.
 */

const A = '0192d028-0000-7000-8000-00000000000a';
const B = '0192d028-0000-7000-8000-00000000000b';
const RESEARCH = '0192d028-0000-7000-8000-000000000101';
const USER = '0192d028-0000-7000-8000-000000000201';
const TOKEN = '0192d028-0000-7000-8000-000000000301';
const ITEM = '0192d028-0000-7000-8000-000000000401';
const SOURCE = '0192d028-0000-7000-8000-000000000501';
const START = Date.parse('2026-10-06T15:00:00.000Z');

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://cf_app:x@127.0.0.1:1/contrataflow',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1',
  OIDC_ISSUER_URL: 'https://issuer.contrataflow.test/',
});

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-import', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId });
    return fn();
  });
}

function setup(store?: CacheStore) {
  let now = START;
  const memory = new InMemoryCacheStore(() => now);
  const importStore = new QuotationImportStore(
    new TenantCache(store ?? memory, config),
    () => new Date(now),
  );
  return {
    memory,
    store: importStore,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const PREVIEW = {
  researchId: RESEARCH,
  userId: USER,
  fileName: 'cotacoes.xlsx',
  skipped: 2,
  cells: [
    { priceItemId: ITEM, priceSourceId: SOURCE, unitPrice: '150.0000' },
    { priceItemId: ITEM, priceSourceId: RESEARCH, unitPrice: '10.0000' },
  ],
};

describe('QuotationImportStore', () => {
  it('grava as células com TTL de 15 minutos e as devolve enquanto vigente', async () => {
    const { store, memory } = setup();
    const expiresAt = await inTenant(A, () => store.save(TOKEN, PREVIEW));
    expect(expiresAt.toISOString()).toBe('2026-10-06T15:15:00.000Z');
    const entry = memory.entries.get(`cf:test:t:${A}:price-import:preview:${TOKEN}`);
    expect(entry?.expiresAt).toBe(START + 15 * 60 * 1000);
    expect(await inTenant(A, () => store.find(TOKEN))).toEqual({
      state: 'ACTIVE',
      preview: {
        ...PREVIEW,
        issuedAt: new Date(START),
        expiresAt: new Date(START + 15 * 60 * 1000),
      },
    });
  });

  it('expira aos 15 minutos: 14:59 vigente; 15:00 e 20:00 vencida (EXPIRED, não UNKNOWN)', async () => {
    const { store, advance } = setup();
    await inTenant(A, () => store.save(TOKEN, PREVIEW));
    advance(14 * 60 * 1000 + 59 * 1000);
    expect((await inTenant(A, () => store.find(TOKEN))).state).toBe('ACTIVE');
    advance(1000);
    expect(await inTenant(A, () => store.find(TOKEN))).toEqual({
      state: 'EXPIRED',
      researchId: RESEARCH,
      userId: USER,
    });
    advance(5 * 60 * 1000);
    expect((await inTenant(A, () => store.find(TOKEN))).state).toBe('EXPIRED');
  });

  it('token desconhecido, de outro tenant ou passado o marcador (24 h) = UNKNOWN', async () => {
    const { store, advance } = setup();
    await inTenant(A, () => store.save(TOKEN, PREVIEW));
    expect(await inTenant(B, () => store.find(TOKEN))).toEqual({ state: 'UNKNOWN' });
    expect(await inTenant(A, () => store.find(RESEARCH))).toEqual({ state: 'UNKNOWN' });
    advance(24 * 3600 * 1000);
    expect(await inTenant(A, () => store.find(TOKEN))).toEqual({ state: 'UNKNOWN' });
  });

  it('consumido: a prévia some e o marcador responde EXPIRED', async () => {
    const { store } = setup();
    await inTenant(A, () => store.save(TOKEN, PREVIEW));
    await inTenant(A, () => store.consume(TOKEN));
    expect((await inTenant(A, () => store.find(TOKEN))).state).toBe('EXPIRED');
  });

  it('Redis fora → 503 DEPENDENCY_UNAVAILABLE', async () => {
    const failing: CacheStore = {
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      set: () => Promise.reject(new Error('ECONNREFUSED')),
      delete: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const { store } = setup(failing);
    await expect(inTenant(A, () => store.save(TOKEN, PREVIEW))).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
    });
    await expect(inTenant(A, () => store.find(TOKEN))).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
});

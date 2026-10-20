import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import { TenantMfaSettings } from '#shared/auth/tenant-mfa-settings.js';
import { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import {
  currentRequestContext,
  runWithRequestContext,
  TenantContextImmutableError,
  updateRequestContext,
} from '#shared/context/request-context.js';

import {
  InMemoryTenantMfaPolicy,
  MFA_POLICY_CACHE_TTL_SECONDS,
  SettingsTenantMfaPolicy,
} from './tenant-mfa-policy.js';

/* `security.mfaPolicy` por instituição (US-093 · RN-IAM-42): leitura das configurações com cache. */

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';
const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://cf_app:x@127.0.0.1:1/contrataflow',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1',
  OIDC_ISSUER_URL: 'https://issuer.contrataflow.test/',
});

function inTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-mfa', ip: '', userAgent: '' }, () => {
    if (tenantId !== null) updateRequestContext({ tenantId });
    return fn();
  });
}

/** Configurações por tenant, lidas pelo tenant do contexto (como a fonte do `tenancy`). */
function settingsOf(policies: Map<string, MfaPolicy>) {
  const settings = new TenantMfaSettings();
  const reads: (string | null)[] = [];
  settings.register({
    mfaPolicy: () => {
      const tenantId = currentRequestContext()?.tenantId ?? null;
      reads.push(tenantId);
      return Promise.resolve(policies.get(tenantId ?? '') ?? 'ADMINS');
    },
  });
  return { settings, reads };
}

const setup = (
  initial: Record<string, MfaPolicy> = {},
  store: CacheStore = new InMemoryCacheStore(),
) => {
  const policies = new Map(Object.entries(initial));
  const { settings, reads } = settingsOf(policies);
  const adapter = new SettingsTenantMfaPolicy(settings, new TenantCache(store, config));
  return { adapter, policies, reads, store };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsTenantMfaPolicy (RN-IAM-42)', () => {
  it('sem a chave gravada (ou sem fonte registrada), vale o padrão do registro (ADMINS)', async () => {
    const { adapter } = setup();
    await expect(inTenant(A, () => adapter.mfaPolicyOf(A))).resolves.toBe('ADMINS');

    const unregistered = new SettingsTenantMfaPolicy(
      new TenantMfaSettings(),
      new TenantCache(new InMemoryCacheStore(), config),
    );
    await expect(inTenant(A, () => unregistered.mfaPolicyOf(A))).resolves.toBe('ADMINS');
  });

  it.each(['NONE', 'ADMINS', 'ALL'] as const)('devolve a política gravada: %s', async (policy) => {
    const { adapter } = setup({ [A]: policy });
    await expect(inTenant(A, () => adapter.mfaPolicyOf(A))).resolves.toBe(policy);
  });

  it('cache por tenant: a segunda leitura não vai à fonte, e A não vê o valor de B', async () => {
    const { adapter, reads, store } = setup({ [A]: 'NONE', [B]: 'ALL' });
    await inTenant(A, () => adapter.mfaPolicyOf(A));
    await expect(inTenant(A, () => adapter.mfaPolicyOf(A))).resolves.toBe('NONE');
    await expect(inTenant(B, () => adapter.mfaPolicyOf(B))).resolves.toBe('ALL');

    expect(reads).toEqual([A, B]);
    expect([...(store as InMemoryCacheStore).entries.keys()].sort()).toEqual([
      `cf:test:t:${A}:identity:mfa-policy`,
      `cf:test:t:${B}:identity:mfa-policy`,
    ]);
    expect(MFA_POLICY_CACHE_TTL_SECONDS).toBe(60);
  });

  it('invalidar o cache do tenant reflete a configuração alterada na leitura seguinte', async () => {
    const { adapter, policies } = setup({ [A]: 'ADMINS', [B]: 'ADMINS' });
    await inTenant(A, () => adapter.mfaPolicyOf(A));
    await inTenant(B, () => adapter.mfaPolicyOf(B));

    policies.set(A, 'NONE');
    policies.set(B, 'NONE');
    await expect(inTenant(A, () => adapter.mfaPolicyOf(A))).resolves.toBe('ADMINS');
    await inTenant(A, () => adapter.invalidate());

    await expect(inTenant(A, () => adapter.mfaPolicyOf(A))).resolves.toBe('NONE');
    // Só o cache do tenant do contexto cai.
    await expect(inTenant(B, () => adapter.mfaPolicyOf(B))).resolves.toBe('ADMINS');
  });

  it('troca de instituição (sem tenant no contexto): lê a configuração do tenant de destino', async () => {
    const { adapter, reads } = setup({ [B]: 'ALL' });
    await expect(inTenant(null, () => adapter.mfaPolicyOf(B))).resolves.toBe('ALL');
    expect(reads).toEqual([B]);
  });

  it('dentro do contexto de um tenant, nunca lê a configuração de outro (RN-TEN-21)', async () => {
    const { adapter, reads } = setup({ [B]: 'NONE' });
    await expect(inTenant(A, () => adapter.mfaPolicyOf(B))).rejects.toBeInstanceOf(
      TenantContextImmutableError,
    );
    expect(reads).toEqual([]);
  });

  it('Redis fora do ar: lê da fonte a cada vez e a invalidação só registra warn', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const down: CacheStore = {
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      set: () => Promise.reject(new Error('ECONNREFUSED')),
      delete: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const { adapter, reads } = setup({ [A]: 'NONE' }, down);

    await expect(inTenant(A, () => adapter.mfaPolicyOf(A))).resolves.toBe('NONE');
    await expect(inTenant(A, () => adapter.mfaPolicyOf(A))).resolves.toBe('NONE');
    await expect(inTenant(A, () => adapter.invalidate())).resolves.toBeUndefined();
    expect(reads).toEqual([A, A]);
  });
});

describe('InMemoryTenantMfaPolicy (modo de identidade fake e testes)', () => {
  it('por instituição, com o padrão para as demais', async () => {
    const policies = new InMemoryTenantMfaPolicy({ [A]: 'ALL' });
    await expect(policies.mfaPolicyOf(A)).resolves.toBe('ALL');
    await expect(policies.mfaPolicyOf(B)).resolves.toBe('ADMINS');
    policies.set(A, 'NONE');
    await expect(policies.mfaPolicyOf(A)).resolves.toBe('NONE');
    await expect(policies.invalidate()).resolves.toBeUndefined();
  });
});

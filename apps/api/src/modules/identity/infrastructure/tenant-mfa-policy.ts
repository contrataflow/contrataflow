import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DEFAULT_MFA_POLICY, MFA_POLICIES } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import type { TenantMfaSettings } from '#shared/auth/tenant-mfa-settings.js';
import type { TenantCache } from '#shared/cache/tenant-cache.js';
import {
  currentRequestContext,
  runAsSystem,
  TenantContextImmutableError,
} from '#shared/context/request-context.js';

import type { TenantMfaPolicyPort } from '../application/ports.js';

/** Chave `cf:{env}:t:{tenantId}:identity:mfa-policy` (o `ConfigCacheInvalidator` do worker a apaga). */
export const MFA_POLICY_CACHE_MODULE = 'identity';
export const MFA_POLICY_CACHE_KEY = 'mfa-policy';
/**
 * Curto de propósito: a invalidação no commit (SET-02) e a do evento cobrem o caso normal; o TTL
 * limita a janela de uma leitura feita antes do commit e gravada depois do `DEL`.
 */
export const MFA_POLICY_CACHE_TTL_SECONDS = 60;

/** Ator da leitura da instituição de destino na troca (US-093), fora de contexto de tenant. */
const LOOKUP_ACTOR = 'Leitura da política de MFA';

const cachedPolicySchema = z.strictObject({ policy: z.enum(MFA_POLICIES) });

/**
 * `security.mfaPolicy` lida das configurações do tenant (DEC-133 · POL-14 · RN-IAM-42), pela fonte
 * que o `tenancy` registra em `TenantMfaSettings`, com cache por tenant (60 s) invalidado no commit
 * do `PATCH /settings` e pelo `TenantSettingsChanged` no worker. Redis fora do ar: lê da fonte.
 * Na troca de instituição (rota `CROSS_TENANT_LOOKUP`, sem tenant no contexto) a leitura roda num
 * contexto filho do tenant de destino; dentro de uma rota de tenant, só o próprio tenant.
 */
export class SettingsTenantMfaPolicy implements TenantMfaPolicyPort {
  private readonly logger = new Logger('SettingsTenantMfaPolicy');

  constructor(
    private readonly settings: TenantMfaSettings,
    private readonly cache: TenantCache,
  ) {}

  mfaPolicyOf(tenantId: string): Promise<MfaPolicy> {
    return inTenant(tenantId, async () => {
      const cached = await this.cache.getOrSet(
        MFA_POLICY_CACHE_MODULE,
        MFA_POLICY_CACHE_KEY,
        async () => ({ policy: await this.settings.mfaPolicy() }),
        { ttlSeconds: MFA_POLICY_CACHE_TTL_SECONDS, schema: cachedPolicySchema },
      );
      return cached.policy;
    });
  }

  /** Redis fora não desfaz nada: o evento e o TTL de 60 s cobrem (`warn`). */
  async invalidate(): Promise<void> {
    try {
      await this.cache.delete(MFA_POLICY_CACHE_MODULE, MFA_POLICY_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        {
          event: 'cache.invalidation_unavailable',
          cause: error instanceof Error ? error.name : 'unknown',
          correlationId: currentRequestContext()?.correlationId ?? null,
        },
        'cache.invalidation_unavailable',
      );
    }
  }
}

function inTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const context = currentRequestContext();
  const current = context?.tenantId ?? null;
  if (current === tenantId) return work();
  // RN-TEN-21: um contexto que já tem tenant nunca lê a configuração de outro.
  if (current !== null) return Promise.reject(new TenantContextImmutableError());
  return runAsSystem(
    {
      name: LOOKUP_ACTOR,
      tenantId,
      ...(context ? { correlationId: context.correlationId } : {}),
    },
    work,
  );
}

/** Política por instituição em memória (testes e modo de identidade fake); padrão do registro. */
export class InMemoryTenantMfaPolicy implements TenantMfaPolicyPort {
  private readonly policies: Map<string, MfaPolicy>;

  constructor(policies: Readonly<Record<string, MfaPolicy>> = {}) {
    this.policies = new Map(Object.entries(policies));
  }

  mfaPolicyOf(tenantId: string): Promise<MfaPolicy> {
    return Promise.resolve(this.policies.get(tenantId) ?? DEFAULT_MFA_POLICY);
  }

  invalidate(): Promise<void> {
    return Promise.resolve();
  }

  set(tenantId: string, policy: MfaPolicy): void {
    this.policies.set(tenantId, policy);
  }
}

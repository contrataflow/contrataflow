import { DEFAULT_MFA_POLICY } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';

import type { TenantMfaPolicyPort } from '../application/ports.js';

/**
 * `security.mfaPolicy` antes das configurações do tenant existirem: o padrão do registro
 * (`ADMINS` — entities.md §6) vale para toda instituição. A US-103 grava a chave em
 * `tenant_settings` e troca este adaptador pela leitura real (com o cache invalidado por
 * `TenantSettingsChanged` — RN-IAM-42).
 */
export class RegistryDefaultMfaPolicy implements TenantMfaPolicyPort {
  mfaPolicyOf(): Promise<MfaPolicy> {
    return Promise.resolve(DEFAULT_MFA_POLICY);
  }
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

  set(tenantId: string, policy: MfaPolicy): void {
    this.policies.set(tenantId, policy);
  }
}

import { Injectable, Module } from '@nestjs/common';

import { DEFAULT_MFA_POLICY } from './mfa-policy.js';
import type { MfaPolicy } from './mfa-policy.js';

/*
 * `security.mfaPolicy` gravada pelo `tenancy` (US-103 · `tenant_settings`) e lida pelo `identity`
 * (POL-14 · RN-IAM-42). O `tenancy` já importa a fachada de `identity` (exceção da US-101), então a
 * leitura no sentido contrário vira esta porta do shared kernel: o `tenancy` registra a fonte no
 * `onModuleInit` (mesmo arranjo do `MembershipReferences`). Sem fonte registrada vale o padrão do
 * registro (`ADMINS` — entities.md §6).
 */

export interface TenantMfaSettingSource {
  /** Valor efetivo da chave no tenant do contexto, numa transação de leitura própria. */
  mfaPolicy(): Promise<MfaPolicy>;
}

@Injectable()
export class TenantMfaSettings {
  private source: TenantMfaSettingSource | null = null;

  register(source: TenantMfaSettingSource): void {
    this.source = source;
  }

  mfaPolicy(): Promise<MfaPolicy> {
    return this.source ? this.source.mfaPolicy() : Promise.resolve(DEFAULT_MFA_POLICY);
  }
}

/** Importado por `identity` (consumidor) e `tenancy` (implementador). */
@Module({ providers: [TenantMfaSettings], exports: [TenantMfaSettings] })
export class TenantMfaSettingsModule {}

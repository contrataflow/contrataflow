import { Inject, Injectable } from '@nestjs/common';

import { DEFAULT_MFA_POLICY, MFA_POLICIES } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import type { TenantMfaSettingSource } from '#shared/auth/tenant-mfa-settings.js';

import { SETTINGS_TRANSACTIONS } from './settings-ports.js';
import type { SettingsTransactions } from './settings-ports.js';
import { TenancyFacade } from './tenancy.facade.js';

export const MFA_POLICY_KEY = 'security.mfaPolicy';

function isMfaPolicy(value: unknown): value is MfaPolicy {
  return MFA_POLICIES.includes(value as MfaPolicy);
}

/**
 * Lado `tenancy` da porta `TenantMfaSettings` (RN-IAM-42): o valor efetivo de `security.mfaPolicy`
 * no tenant do contexto (`TenancyFacade.settingValues` — o gravado ou o padrão do registro), numa
 * transação de leitura própria. Valor fora do enum (linha corrompida) vale o padrão `ADMINS`.
 */
@Injectable()
export class TenancyMfaPolicySource implements TenantMfaSettingSource {
  constructor(
    private readonly facade: TenancyFacade,
    @Inject(SETTINGS_TRANSACTIONS) private readonly transactions: SettingsTransactions,
  ) {}

  async mfaPolicy(): Promise<MfaPolicy> {
    const values = await this.transactions.read((tx) =>
      this.facade.settingValues(tx, [MFA_POLICY_KEY]),
    );
    const value = values.get(MFA_POLICY_KEY);
    return isMfaPolicy(value) ? value : DEFAULT_MFA_POLICY;
  }
}

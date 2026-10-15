import { Inject, Injectable } from '@nestjs/common';

import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { SETTINGS_TRANSACTIONS, TENANT_SETTINGS_REPOSITORY } from './settings-ports.js';
import type { SettingsTransactions, TenantSettingsRepository } from './settings-ports.js';
import { SettingsRegistry } from '../domain/settings-registry.js';

/**
 * Seeder `tenancy.settings` (US-103 · US-099 · RN-TEN-57 · entities.md §7): grava toda chave do
 * registro AINDA sem linha com o valor padrão (versão 1), na `TenantTransaction` do tenant. Nunca
 * toca em valor já gravado, então é idempotente e serve a tenants existentes quando uma chave nova
 * entra no registro (`tenant:seed`, FA-08). As flags `features.<nome>` seguem o padrão desligado e
 * não são semeadas (a leitura trata a ausência como o padrão).
 */
@Injectable()
export class TenantSettingsSeeder implements TenantSeeder {
  readonly key = 'tenancy.settings';
  readonly module = 'tenancy';
  readonly version = '2026.10.1';
  readonly dependsOn: readonly string[] = [];
  readonly applyToExistingTenants = true;

  constructor(
    private readonly registry: SettingsRegistry,
    @Inject(TENANT_SETTINGS_REPOSITORY) private readonly settings: TenantSettingsRepository,
    @Inject(SETTINGS_TRANSACTIONS) private readonly transactions: SettingsTransactions,
  ) {}

  async seed(ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const definitions = this.registry.definitions();
    const created = await this.transactions.run(async (tx) => {
      const present = new Set((await this.settings.list(tx)).map((row) => row.key));
      const missing = definitions.filter((definition) => !present.has(definition.key));
      return this.settings.insertMissing(
        tx,
        missing.map((definition) => ({
          tenantId: ctx.tenantId,
          key: definition.key,
          value: definition.defaultValue,
          userId: null,
          now: ctx.now,
        })),
      );
    });
    return { created, skipped: definitions.length - created };
  }

  async verify(_ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const definitions = this.registry.definitions();
    const rows = await this.transactions.read((tx) => this.settings.list(tx));
    const present = new Set(rows.map((row) => row.key));
    const found = definitions.filter((definition) => present.has(definition.key)).length;
    return {
      status: found === definitions.length ? 'DONE' : 'PENDING',
      details: { settings: found },
    };
  }
}

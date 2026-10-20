import type { SettingsMapDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { SETTINGS_TRANSACTIONS, TENANT_SETTINGS_REPOSITORY } from './settings-ports.js';
import type { SettingsTransactions, TenantSettingsRepository } from './settings-ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { SettingsRegistry } from '../domain/settings-registry.js';

/**
 * `GetSettingsQuery` — SET-01 (US-103): todas as chaves do registro com valor e versão; chave sem
 * linha devolve o padrão com `version = 0` (RN-TEN-57). `features.<flag>` entra quando gravada.
 * Exige `SETTINGS_MANAGE` (+ MFA conforme `security.mfaPolicy` — POL-14).
 */
@Injectable()
export class GetSettingsQuery {
  constructor(
    private readonly registry: SettingsRegistry,
    @Inject(TENANT_SETTINGS_REPOSITORY) private readonly settings: TenantSettingsRepository,
    @Inject(SETTINGS_TRANSACTIONS) private readonly transactions: SettingsTransactions,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(): Promise<SettingsMapDto> {
    this.access.assertCan('SETTINGS_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const rows = await this.transactions.read((tx) => this.settings.list(tx));
    const stored = new Map(rows.map((row) => [row.key, row]));

    const result: SettingsMapDto = {};
    for (const definition of this.registry.definitions()) {
      const row = stored.get(definition.key);
      result[definition.key] = row
        ? { value: row.value, version: row.version }
        : { value: definition.defaultValue, version: 0 };
    }
    for (const row of rows) {
      if (!(row.key in result) && this.registry.definition(row.key) !== null) {
        result[row.key] = { value: row.value, version: row.version };
      }
    }
    return result;
  }
}

/**
 * `GetPublicSettingsQuery` — SET-03 (US-103 · RN-TEN-56): só as chaves públicas (`labels.*`,
 * `branding.*`), a qualquer vínculo ativo — capacidade implícita, sem `SETTINGS_MANAGE`.
 */
@Injectable()
export class GetPublicSettingsQuery {
  constructor(
    private readonly registry: SettingsRegistry,
    @Inject(TENANT_SETTINGS_REPOSITORY) private readonly settings: TenantSettingsRepository,
    @Inject(SETTINGS_TRANSACTIONS) private readonly transactions: SettingsTransactions,
  ) {}

  async execute(): Promise<Record<string, unknown>> {
    const rows = await this.transactions.read((tx) => this.settings.list(tx));
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const result: Record<string, unknown> = {};
    for (const definition of this.registry.publicDefinitions()) {
      result[definition.key] = stored.has(definition.key)
        ? stored.get(definition.key)
        : definition.defaultValue;
    }
    return result;
  }
}

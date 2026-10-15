import { Inject, Injectable } from '@nestjs/common';

import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { ACCESS_TRANSACTIONS, ROLE_REPOSITORY } from './ports.js';
import type { AccessTransactions, RoleRepository } from './ports.js';
import { SeedDefaultRolesHandler } from './seed-default-roles.handler.js';
import { DEFAULT_ROLES } from '../domain/default-roles.js';

/**
 * Seeder `access.defaultRoles` (US-094 · US-099 · DEC-035): os 15 perfis padrão com a matriz de
 * permissions.md §3.2, numa `TenantTransaction` do tenant novo. Idempotente por `(tenant, key)`;
 * aplicável a tenants existentes (perfil padrão novo numa versão futura — RM-07).
 */
@Injectable()
export class DefaultRolesSeeder implements TenantSeeder {
  readonly key = 'access.defaultRoles';
  readonly module = 'access';
  readonly version = '2026.10.1';
  readonly dependsOn: readonly string[] = [];
  readonly applyToExistingTenants = true;

  constructor(
    private readonly handler: SeedDefaultRolesHandler,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ACCESS_TRANSACTIONS) private readonly transactions: AccessTransactions,
  ) {}

  async seed(_ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const result = await this.transactions.run((tx) => this.handler.execute(tx));
    return { created: result.rolesCreated, skipped: DEFAULT_ROLES.length - result.rolesCreated };
  }

  async verify(_ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const found = await this.transactions.read((tx) =>
      this.roles.findByKeys(
        tx,
        DEFAULT_ROLES.map((role) => role.key),
      ),
    );
    return {
      status: found.length === DEFAULT_ROLES.length ? 'DONE' : 'PENDING',
      details: { roles: found.length },
    };
  }
}

import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';

import { TenancyFacade } from './application/tenancy.facade.js';
import { InMemoryTenantRepository } from './infrastructure/in-memory-tenant.repository.js';
import { PrismaTenantRepository } from './infrastructure/prisma-tenant.repository.js';

/**
 * Módulo `tenancy` (DEC-040): outros módulos usam somente a fachada exportada. Implementa a porta
 * `TenantStatusPort` do guard de tenant sobre `tenants` (US-087); em memória no modo de identidade
 * fake (local/dev/test).
 */
@Module({
  providers: [
    TenancyFacade,
    PrismaTenantRepository,
    {
      provide: TENANT_STATUS_PORT,
      inject: [APP_CONFIG, PrismaTenantRepository],
      useFactory: (config: AppConfig, prisma: PrismaTenantRepository) =>
        config.oidc.fakeSigningKey ? new InMemoryTenantRepository() : prisma,
    },
  ],
  exports: [TenancyFacade, TENANT_STATUS_PORT],
})
export class TenancyModule {}

import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import { PlatformCache } from '#shared/cache/tenant-cache.js';

import { TENANT_STATUS_CACHE } from './application/ports.js';
import { TenancyFacade } from './application/tenancy.facade.js';
import { InMemoryTenantRepository } from './infrastructure/in-memory-tenant.repository.js';
import { PrismaTenantRepository } from './infrastructure/prisma-tenant.repository.js';
import { TenantStatusCache } from './infrastructure/tenant-status.cache.js';

/**
 * Módulo `tenancy` (DEC-040): outros módulos usam somente a fachada exportada. Implementa a porta
 * `TenantStatusPort` do guard de tenant sobre `tenants` (US-087) com o `TenantStatusCache` de 30 s
 * (US-100); a fonte é em memória no modo de identidade fake (local/dev/test).
 */
@Module({
  providers: [
    TenancyFacade,
    PrismaTenantRepository,
    {
      provide: TenantStatusCache,
      inject: [APP_CONFIG, PrismaTenantRepository, PlatformCache],
      useFactory: (config: AppConfig, prisma: PrismaTenantRepository, cache: PlatformCache) =>
        new TenantStatusCache(
          config.oidc.fakeSigningKey ? new InMemoryTenantRepository() : prisma,
          cache,
        ),
    },
    { provide: TENANT_STATUS_PORT, useExisting: TenantStatusCache },
    { provide: TENANT_STATUS_CACHE, useExisting: TenantStatusCache },
  ],
  exports: [TenancyFacade, TENANT_STATUS_PORT],
})
export class TenancyModule {}

import { Module } from '@nestjs/common';

import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';

import { TenancyFacade } from './application/tenancy.facade.js';
import { InMemoryTenantRepository } from './infrastructure/in-memory-tenant.repository.js';

/**
 * Módulo `tenancy` (DEC-040): outros módulos usam somente a fachada exportada. Implementa a porta
 * `TenantStatusPort` do guard de tenant (em memória até a US-081).
 */
@Module({
  providers: [
    TenancyFacade,
    { provide: TENANT_STATUS_PORT, useFactory: () => new InMemoryTenantRepository() },
  ],
  exports: [TenancyFacade, TENANT_STATUS_PORT],
})
export class TenancyModule {}

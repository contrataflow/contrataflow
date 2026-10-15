import { Inject, Injectable } from '@nestjs/common';

import { TENANT_STATUS_CACHE } from './ports.js';
import type { TenantStatusCachePort } from './ports.js';

/**
 * API pública do módulo `tenancy` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class TenancyFacade {
  constructor(@Inject(TENANT_STATUS_CACHE) private readonly statusCache: TenantStatusCachePort) {}

  /**
   * Descarta o status em cache depois de uma mudança de status do tenant (US-099:
   * `TenantActivated`/`TenantSuspended`) — o guard relê do banco na próxima requisição.
   */
  invalidateTenantStatus(tenantId: string): Promise<void> {
    return this.statusCache.invalidate(tenantId);
  }
}

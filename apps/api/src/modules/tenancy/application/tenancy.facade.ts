import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ORGANIZATION_REPOSITORY } from './organization-ports.js';
import type { OrganizationRepository } from './organization-ports.js';
import { TENANT_STATUS_CACHE } from './ports.js';
import type { TenantStatusCachePort } from './ports.js';

/** Situação de um órgão do tenant da transação (`null` = inexistente nele). */
export type OrganizationStatus = 'ACTIVE' | 'INACTIVE';

/**
 * API pública do módulo `tenancy` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class TenancyFacade {
  constructor(
    @Inject(TENANT_STATUS_CACHE) private readonly statusCache: TenantStatusCachePort,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
  ) {}

  /**
   * `Organization.assertActive` para quem cadastra sob o órgão (US-102: unidades): a situação do
   * órgão lido no `tx` do chamador, ou `null` se não existir no tenant (outro tenant = inexistente).
   */
  async organizationStatus(
    tx: TenantTx,
    organizationId: string,
  ): Promise<OrganizationStatus | null> {
    const organization = await this.organizations.findById(tx, organizationId);
    if (!organization) return null;
    return organization.isActive ? 'ACTIVE' : 'INACTIVE';
  }

  /**
   * Descarta o status em cache depois de uma mudança de status do tenant (US-099:
   * `TenantActivated`/`TenantSuspended`) — o guard relê do banco na próxima requisição.
   */
  invalidateTenantStatus(tenantId: string): Promise<void> {
    return this.statusCache.invalidate(tenantId);
  }
}

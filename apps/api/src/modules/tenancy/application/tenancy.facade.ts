import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ORGANIZATION_REPOSITORY } from './organization-ports.js';
import type { OrganizationRepository } from './organization-ports.js';
import { TENANT_STATUS_CACHE } from './ports.js';
import type { TenantStatusCachePort } from './ports.js';
import { TENANT_SETTINGS_REPOSITORY } from './settings-ports.js';
import type { TenantSettingsRepository } from './settings-ports.js';
import { SettingsRegistry } from '../domain/settings-registry.js';

/** Situação de um órgão do tenant da transação (`null` = inexistente nele). */
export type OrganizationStatus = 'ACTIVE' | 'INACTIVE';

/** Órgão visto por quem o referencia (US-001: órgão do processo). */
export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly isActive: boolean;
}

/**
 * API pública do módulo `tenancy` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class TenancyFacade {
  constructor(
    @Inject(TENANT_STATUS_CACHE) private readonly statusCache: TenantStatusCachePort,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
    @Inject(TENANT_SETTINGS_REPOSITORY) private readonly settings: TenantSettingsRepository,
    private readonly registry: SettingsRegistry,
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
   * Órgão do tenant da transação com nome e situação (US-096: escopo `ORGANIZATION` da atribuição
   * de perfil), ou `null` se não existir nele (outro tenant = inexistente).
   */
  async organizationReference(
    tx: TenantTx,
    organizationId: string,
  ): Promise<{ readonly name: string; readonly isActive: boolean } | null> {
    const organization = await this.organizations.findById(tx, organizationId);
    return organization ? { name: organization.name, isActive: organization.isActive } : null;
  }

  /** Órgão com sigla (US-001: órgão do processo), ou `null` se não existir no tenant. */
  async organizationSummary(
    tx: TenantTx,
    organizationId: string,
  ): Promise<OrganizationSummary | null> {
    const organization = await this.organizations.findById(tx, organizationId);
    return organization
      ? {
          id: organization.id,
          name: organization.name,
          shortName: organization.shortName,
          isActive: organization.isActive,
        }
      : null;
  }

  /** Órgão principal do tenant da transação (`null` até o provisionamento — RN-PROC-01). */
  primaryOrganizationId(tx: TenantTx): Promise<string | null> {
    return this.organizations.primaryOrganizationId(tx);
  }

  /**
   * Valores efetivos das chaves de configuração no tenant da transação (US-103 · RN-TEN-57): o
   * gravado, ou o padrão do registro quando a chave não tem linha. Lido no `tx` do chamador (sem
   * cache): a regra vale já na próxima transação depois de um `PATCH /settings`.
   */
  async settingValues(
    tx: TenantTx,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, unknown>> {
    const stored = new Map((await this.settings.list(tx)).map((row) => [row.key, row.value]));
    return new Map(
      keys.map((key) => [
        key,
        stored.has(key) ? stored.get(key) : (this.registry.definition(key)?.defaultValue ?? null),
      ]),
    );
  }

  /**
   * Descarta o status em cache depois de uma mudança de status do tenant (US-099:
   * `TenantActivated`/`TenantSuspended`) — o guard relê do banco na próxima requisição.
   */
  invalidateTenantStatus(tenantId: string): Promise<void> {
    return this.statusCache.invalidate(tenantId);
  }
}

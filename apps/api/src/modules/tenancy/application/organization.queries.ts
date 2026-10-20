import type { OrganizationDto, OrganizationListQuery } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ORGANIZATION_REPOSITORY, ORGANIZATION_TRANSACTIONS } from './organization-ports.js';
import type { OrganizationRepository, OrganizationTransactions } from './organization-ports.js';
import { organizationNotFound } from './organization.errors.js';
import { toOrganizationDto } from './organization.view.js';

export interface OrganizationListResult {
  readonly items: readonly OrganizationDto[];
  readonly totalItems: number;
}

/**
 * `ListOrganizationsQuery` — ORG-01 (US-101): capacidade implícita do vínculo ativo (seletores de
 * órgão em formulários); filtros `isActive` e `q`, ordenada por nome.
 */
@Injectable()
export class ListOrganizationsQuery {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
    @Inject(ORGANIZATION_TRANSACTIONS) private readonly transactions: OrganizationTransactions,
  ) {}

  execute(query: OrganizationListQuery): Promise<OrganizationListResult> {
    return this.transactions.read(async (tx) => {
      const page = await this.organizations.list(tx, {
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
        ...(query.q === undefined ? {} : { q: query.q }),
        page: query.page,
        pageSize: query.pageSize,
      });
      const primaryId = await this.organizations.primaryOrganizationId(tx);
      return {
        items: page.items.map((organization) => toOrganizationDto(organization, primaryId)),
        totalItems: page.totalItems,
      };
    });
  }
}

/** `GetOrganizationQuery` — ORG-03: outro tenant e inexistente são indistinguíveis (404). */
@Injectable()
export class GetOrganizationQuery {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
    @Inject(ORGANIZATION_TRANSACTIONS) private readonly transactions: OrganizationTransactions,
  ) {}

  execute(id: string): Promise<OrganizationDto> {
    return this.transactions.read(async (tx) => {
      const organization = await this.organizations.findById(tx, id);
      if (!organization) throw organizationNotFound();
      return toOrganizationDto(organization, await this.organizations.primaryOrganizationId(tx));
    });
  }
}

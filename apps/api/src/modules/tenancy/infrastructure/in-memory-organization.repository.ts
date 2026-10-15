import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { InMemoryTenantRepository } from './in-memory-tenant.repository.js';
import {
  OrganizationCnpjTakenError,
  OrganizationShortNameTakenError,
} from '../application/organization-ports.js';
import type {
  OrganizationListFilter,
  OrganizationLogoPort,
  OrganizationPage,
  OrganizationRepository,
  OrganizationTransactions,
  LogoCheck,
} from '../application/organization-ports.js';
import type { Organization } from '../domain/organization.js';

/** Minúsculas e sem acentos: a busca do SCR-032 ignora ambos. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Órgãos em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento por tenant (o do contexto, como o `app.tenant_id`), unicidade de
 * sigla e CNPJ por tenant e concorrência otimista por versão. O órgão principal de cada tenant é
 * informado por `setPrimary` (no banco, `tenants.primary_organization_id`).
 */
export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly rows = new Map<string, Organization>();
  private readonly primaries = new Map<string, string>();

  /** `tenants` em memória, de onde sai o órgão principal quando o seeder o define. */
  constructor(private readonly tenants: InMemoryTenantRepository | null = null) {}

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private inTenant(): Organization[] {
    const tenantId = this.tenantId();
    return [...this.rows.values()].filter((organization) => organization.tenantId === tenantId);
  }

  list(_tx: TenantTx, filter: OrganizationListFilter): Promise<OrganizationPage> {
    const needle = filter.q === undefined ? null : fold(filter.q.trim());
    const cnpjNeedle = filter.q === undefined ? '' : filter.q.replace(/[./\s-]/g, '').toUpperCase();
    const matching = this.inTenant()
      .filter((org) => filter.isActive === undefined || org.isActive === filter.isActive)
      .filter(
        (org) =>
          needle === null ||
          [org.name, org.shortName].some((text) => fold(text).includes(needle)) ||
          (cnpjNeedle !== '' && org.cnpj.includes(cnpjNeedle)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id));
    const start = (filter.page - 1) * filter.pageSize;
    return Promise.resolve({
      items: matching.slice(start, start + filter.pageSize),
      totalItems: matching.length,
    });
  }

  findById(_tx: TenantTx, id: string): Promise<Organization | null> {
    return Promise.resolve(this.inTenant().find((org) => org.id === id) ?? null);
  }

  findByShortName(_tx: TenantTx, shortName: string): Promise<Organization | null> {
    return Promise.resolve(this.inTenant().find((org) => org.shortName === shortName) ?? null);
  }

  findByCnpj(_tx: TenantTx, cnpj: string): Promise<Organization | null> {
    return Promise.resolve(this.inTenant().find((org) => org.cnpj === cnpj) ?? null);
  }

  insert(_tx: TenantTx, organization: Organization): Promise<void> {
    const taken = this.takenBy(organization);
    if (taken) return Promise.reject(taken);
    this.rows.set(organization.id, organization);
    return Promise.resolve();
  }

  update(_tx: TenantTx, organization: Organization, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((existing) => existing.id === organization.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'Organization',
          aggregateId: organization.id,
          expectedVersion,
        }),
      );
    }
    const taken = this.takenBy(organization);
    if (taken) return Promise.reject(taken);
    this.rows.set(organization.id, { ...organization, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  countActive(_tx: TenantTx, excludingId: string): Promise<number> {
    return Promise.resolve(
      this.inTenant().filter((org) => org.isActive && org.id !== excludingId).length,
    );
  }

  primaryOrganizationId(_tx: TenantTx): Promise<string | null> {
    const tenantId = this.tenantId();
    if (tenantId === null) return Promise.resolve(null);
    return Promise.resolve(
      this.primaries.get(tenantId) ?? this.tenants?.primaryOrganizationOf(tenantId) ?? null,
    );
  }

  private takenBy(organization: Organization): Error | null {
    const others = this.inTenant().filter((existing) => existing.id !== organization.id);
    if (others.some((existing) => existing.shortName === organization.shortName)) {
      return new OrganizationShortNameTakenError(organization.shortName);
    }
    if (others.some((existing) => existing.cnpj === organization.cnpj)) {
      return new OrganizationCnpjTakenError();
    }
    return null;
  }

  /** Inspeção e carga de testes: todos os órgãos de todos os tenants. */
  snapshot(): readonly Organization[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (órgão de outro tenant, órgãos já existentes…). */
  seed(...organizations: readonly Organization[]): void {
    for (const organization of organizations) this.rows.set(organization.id, organization);
  }

  /** `tenants.primary_organization_id` do tenant (testes e seeder em memória). */
  setPrimary(tenantId: string, organizationId: string): void {
    this.primaries.set(tenantId, organizationId);
  }
}

/** Transações simuladas: um `tx` sentinela ativo só durante o trabalho. */
@Injectable()
export class InMemoryOrganizationTransactions implements OrganizationTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

/**
 * Logotipo antes do módulo `files` (US-068): a tabela `attachments` não existe, logo nenhum id é um
 * anexo `AVAILABLE` do tenant — todo `logoAttachmentId` é recusado (`REFERENCE_NOT_FOUND`).
 */
export class RejectingLogoPort implements OrganizationLogoPort {
  check(): Promise<LogoCheck> {
    return Promise.resolve('NOT_FOUND');
  }
}

/** Testes: respostas configuráveis por id do anexo. */
export class StubLogoPort implements OrganizationLogoPort {
  constructor(private readonly results: Readonly<Record<string, LogoCheck>> = {}) {}

  check(_tx: TenantTx, attachmentId: string): Promise<LogoCheck> {
    return Promise.resolve(this.results[attachmentId] ?? 'NOT_FOUND');
  }
}

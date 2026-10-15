import type { TenantStatus, TenantStatusPort } from '#shared/auth/ports.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { TenantSlugTakenError } from '../application/ports.js';
import type {
  PlatformTransactions,
  TenantAdminRepository,
  TenantListFilter,
  TenantPage,
} from '../application/ports.js';
import type { Tenant, TenantLifecyclePatch } from '../domain/tenant.js';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/** Tenants fixos do diretório fake como agregados completos. */
function fakeTenants(): Tenant[] {
  return Object.entries(FAKE_TENANTS).map(([key, tenant]) => ({
    id: tenant.id,
    slug: key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    name: tenant.name,
    legalName: null,
    type: 'MUNICIPALITY',
    status: tenant.status,
    stateCode: 'SC',
    ibgeCityCode: null,
    timezone: tenant.timezone,
    locale: 'pt-BR',
    plan: 'STANDARD',
    primaryOrganizationId: null,
    activatedAt: tenant.status === 'ACTIVE' ? CREATED_AT : null,
    suspendedAt: tenant.status === 'SUSPENDED' ? CREATED_AT : null,
    suspensionReason: tenant.status === 'SUSPENDED' ? 'Suspensa no diretório fake.' : null,
    deactivatedAt: null,
    offboardingStartedAt: tenant.status === 'OFFBOARDING' ? CREATED_AT : null,
    offboardingEndsAt: null,
    provisioningFingerprint: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    version: 1,
  }));
}

/**
 * `tenants` em memória — testes e modo de identidade fake (local/dev/test): a mesma instância
 * serve o guard de tenant (`TenantStatusPort`) e o provisionamento, para que suspender um tenant
 * recuse as requisições seguintes. `tx` é ignorado (transação simulada).
 */
export class InMemoryTenantRepository implements TenantStatusPort, TenantAdminRepository {
  private readonly tenants = new Map<string, Tenant>();
  private readonly provisioned = new Set<string>();

  constructor(tenants: readonly Tenant[] = fakeTenants()) {
    for (const tenant of tenants) this.tenants.set(tenant.id, tenant);
  }

  findStatus(tenantId: string): Promise<TenantStatus | null> {
    return Promise.resolve(this.tenants.get(tenantId)?.status ?? null);
  }

  findById(_tx: TenantTx, id: string): Promise<Tenant | null> {
    return Promise.resolve(this.tenants.get(id) ?? null);
  }

  findBySlug(_tx: TenantTx, slug: string): Promise<Tenant | null> {
    return Promise.resolve([...this.tenants.values()].find((t) => t.slug === slug) ?? null);
  }

  list(_tx: TenantTx, filter: TenantListFilter): Promise<TenantPage> {
    const q = filter.q?.toLowerCase();
    const matching = [...this.tenants.values()]
      .filter((tenant) => !filter.status || tenant.status === filter.status)
      .filter((tenant) => !filter.stateCode || tenant.stateCode === filter.stateCode)
      .filter((tenant) => !q || tenant.name.toLowerCase().includes(q) || tenant.slug.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const start = (filter.page - 1) * filter.pageSize;
    return Promise.resolve({
      items: matching.slice(start, start + filter.pageSize),
      totalItems: matching.length,
    });
  }

  insert(_tx: TenantTx, tenant: Tenant): Promise<Tenant> {
    if ([...this.tenants.values()].some((existing) => existing.slug === tenant.slug)) {
      return Promise.reject(new TenantSlugTakenError(tenant.slug));
    }
    this.tenants.set(tenant.id, tenant);
    return Promise.resolve(tenant);
  }

  updateLifecycle(
    _tx: TenantTx,
    id: string,
    expectedVersion: number,
    patch: TenantLifecyclePatch,
    now: Date,
  ): Promise<Tenant> {
    const current = this.tenants.get(id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({ aggregateType: 'Tenant', aggregateId: id, expectedVersion }),
      );
    }
    const updated: Tenant = { ...current, ...patch, updatedAt: now, version: current.version + 1 };
    this.tenants.set(id, updated);
    return Promise.resolve(updated);
  }

  setPrimaryOrganization(_tx: TenantTx, tenantId: string, organizationId: string): Promise<void> {
    const current = this.tenants.get(tenantId);
    if (current) this.tenants.set(tenantId, { ...current, primaryOrganizationId: organizationId });
    return Promise.resolve();
  }

  /** `primaryOrganizationId` do tenant (o `OrganizationRepository` em memória lê daqui). */
  primaryOrganizationOf(tenantId: string): string | null {
    return this.tenants.get(tenantId)?.primaryOrganizationId ?? null;
  }

  provisionRecorded(_tx: TenantTx, tenantId: string): Promise<boolean> {
    return Promise.resolve(this.provisioned.has(tenantId));
  }

  markProvisioned(_tx: TenantTx, tenantId: string): Promise<void> {
    this.provisioned.add(tenantId);
    return Promise.resolve();
  }

  /** Testes: muda a versão como faria outro operador. */
  bumpVersion(id: string): void {
    const current = this.tenants.get(id);
    if (current) this.tenants.set(id, { ...current, version: current.version + 1 });
  }
}

export class InMemoryPlatformTransactions implements PlatformTransactions {
  run<T>(_reason: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(_reason: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

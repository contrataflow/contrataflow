import type { TenantStatus, TenantStatusPort } from '#shared/auth/ports.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

/** `TenantStatusPort` em memória (FA-03) — substituído pelo repositório Prisma na US-081. */
export class InMemoryTenantRepository implements TenantStatusPort {
  constructor(
    private readonly tenants: readonly { id: string; status: TenantStatus }[] = Object.values(
      FAKE_TENANTS,
    ),
  ) {}

  findStatus(tenantId: string): Promise<TenantStatus | null> {
    return Promise.resolve(this.tenants.find((tenant) => tenant.id === tenantId)?.status ?? null);
  }
}

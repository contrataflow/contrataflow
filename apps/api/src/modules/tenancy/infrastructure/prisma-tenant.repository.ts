import { Injectable } from '@nestjs/common';

import type { TenantStatus, TenantStatusPort } from '#shared/auth/ports.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';

/**
 * Status do tenant para o guard de tenant (DEC-132): `tenants` é tabela de plataforma (sem RLS),
 * lida pelo `PlatformTransaction` (US-087). O cache de status e o `TenantContextService` completo
 * chegam com a US-100.
 */
@Injectable()
export class PrismaTenantRepository implements TenantStatusPort {
  constructor(private readonly platform: PlatformTransaction) {}

  async findStatus(tenantId: string): Promise<TenantStatus | null> {
    const tenant = await this.platform.read((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
    );
    return tenant?.status ?? null;
  }
}

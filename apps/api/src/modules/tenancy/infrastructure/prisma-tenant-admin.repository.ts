import { Injectable } from '@nestjs/common';

import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';
import { SystemDbService } from '#shared/database/system-db.service.js';

import { TenantSlugTakenError } from '../application/ports.js';
import type {
  PlatformAccessReason,
  PlatformTransactions,
  TenantAdminRepository,
  TenantListFilter,
  TenantPage,
} from '../application/ports.js';
import type { Tenant, TenantLifecyclePatch } from '../domain/tenant.js';

type Row = Prisma.TenantGetPayload<object>;

function toDomain(row: Row): Tenant {
  return { ...row };
}

/**
 * `tenants` pelo `SystemDbService` (papel `cf_platform` — US-100 · RN-TEN-28): o `tx` recebido é
 * sempre o da transação de plataforma, com `app.tenant_id` nulo.
 */
@Injectable()
export class PrismaTenantAdminRepository implements TenantAdminRepository {
  async findById(tx: TenantTx, id: string): Promise<Tenant | null> {
    const row = await tx.tenant.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findBySlug(tx: TenantTx, slug: string): Promise<Tenant | null> {
    const row = await tx.tenant.findUnique({ where: { slug } });
    return row ? toDomain(row) : null;
  }

  async list(tx: TenantTx, filter: TenantListFilter): Promise<TenantPage> {
    const where: Prisma.TenantWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.stateCode ? { stateCode: filter.stateCode } : {}),
      ...(filter.q
        ? {
            OR: [
              { name: { contains: filter.q, mode: 'insensitive' } },
              { slug: { contains: filter.q.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [rows, totalItems] = await Promise.all([
      tx.tenant.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      tx.tenant.count({ where }),
    ]);
    return { items: rows.map(toDomain), totalItems };
  }

  async insert(tx: TenantTx, tenant: Tenant): Promise<Tenant> {
    try {
      // `ON CONFLICT` não serve aqui: o slug em corrida precisa virar 409 para um dos dois.
      const row = await tx.tenant.create({
        data: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          legalName: tenant.legalName,
          type: tenant.type,
          status: tenant.status,
          stateCode: tenant.stateCode,
          ibgeCityCode: tenant.ibgeCityCode,
          timezone: tenant.timezone,
          locale: tenant.locale,
          plan: tenant.plan,
          provisioningFingerprint: tenant.provisioningFingerprint,
          createdAt: tenant.createdAt,
          updatedAt: tenant.updatedAt,
        },
      });
      return toDomain(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new TenantSlugTakenError(tenant.slug);
      throw error;
    }
  }

  async updateLifecycle(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    patch: TenantLifecyclePatch,
    now: Date,
  ): Promise<Tenant> {
    await updateVersioned({ aggregateType: 'Tenant', aggregateId: id, expectedVersion }, () =>
      tx.tenant.updateMany({
        where: { id, version: expectedVersion },
        data: { ...patch, updatedAt: now, version: { increment: 1 } },
      }),
    );
    const row = await tx.tenant.findUniqueOrThrow({ where: { id } });
    return toDomain(row);
  }

  async setPrimaryOrganization(
    tx: TenantTx,
    tenantId: string,
    organizationId: string,
  ): Promise<void> {
    await tx.tenant.update({
      where: { id: tenantId },
      data: { primaryOrganizationId: organizationId },
    });
  }

  async provisionRecorded(tx: TenantTx, tenantId: string): Promise<boolean> {
    // Política `platform_role_select` (US-100): o cf_platform lê as ações de operadores.
    const found = await tx.auditLog.findFirst({
      where: { tenantId, action: 'tenant.provision', result: 'SUCCESS' },
      select: { id: true },
    });
    return found !== null;
  }

  markProvisioned(): Promise<void> {
    return Promise.resolve();
  }
}

/** Transações do `SystemDbService` com o motivo declarado (RN-TEN-28). */
@Injectable()
export class SystemDbPlatformTransactions implements PlatformTransactions {
  constructor(private readonly systemDb: SystemDbService) {}

  run<T>(reason: PlatformAccessReason, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.systemDb.run(reason, work, { caller: 'tenancy' });
  }

  read<T>(reason: PlatformAccessReason, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.systemDb.run(reason, work, { caller: 'tenancy', readOnly: true });
  }
}

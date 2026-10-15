import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { AuditPartitionsPort, AuditTransactions } from '../application/ports.js';

/**
 * Transações das gravações avulsas da auditoria (US-073 · DEC-071): no tenant do contexto
 * (`TenantTransaction`) ou, sem tenant, de plataforma — onde a RLS só aceita `tenant_id` nulo
 * (`platform_insert`) e não deixa ler nada.
 */
@Injectable()
export class PrismaAuditTransactions implements AuditTransactions {
  constructor(
    private readonly tenant: TenantTransaction,
    private readonly platform: PlatformTransaction,
  ) {}

  inTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.tenant.run(work);
  }

  inPlatform<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.platform.run(work);
  }
}

/**
 * Partições mensais pela função `cf_audit_ensure_partitions` (SECURITY DEFINER da dona da tabela,
 * idempotente e sob trava consultiva — migração `20261014210000_audit_logs`).
 */
@Injectable()
export class PrismaAuditPartitions implements AuditPartitionsPort {
  constructor(private readonly platform: PlatformTransaction) {}

  async ensure(monthsAhead: number): Promise<number> {
    const [row] = await this.platform.run(
      (tx) => tx.$queryRaw<{ created: number }[]>`
        SELECT cf_audit_ensure_partitions(${monthsAhead}::int) AS created`,
    );
    return row?.created ?? 0;
  }
}

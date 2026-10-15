import { Inject, Injectable } from '@nestjs/common';

import { DATABASE_CLIENT } from './database-client.js';
import type { TenantPrismaClient } from './prisma-client.js';
import type { PlatformTransactionOptions, TenantTx } from './tenant-transaction.js';

/**
 * Transação de plataforma (multi-tenancy.md §6 · US-087): `users`, `tenants` e as funções de
 * leitura entre tenants (`cf_user_memberships`), sem `app.tenant_id` — tabelas com RLS falham
 * fechadas. Uso restrito aos adaptadores de `identity` e `tenancy` que servem o pipeline de
 * autenticação e o início de sessão (regra `platform-transaction-allowlist` do dependency-cruiser).
 */
@Injectable()
export class PlatformTransaction {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: TenantPrismaClient) {}

  run<T>(
    work: (tx: TenantTx) => Promise<T>,
    options: Pick<PlatformTransactionOptions, 'userId'> = {},
  ): Promise<T> {
    return this.prisma.$platformTransaction(work, options);
  }

  read<T>(
    work: (tx: TenantTx) => Promise<T>,
    options: Pick<PlatformTransactionOptions, 'userId'> = {},
  ): Promise<T> {
    return this.prisma.$platformTransaction(work, { ...options, readOnly: true });
  }
}

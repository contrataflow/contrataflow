import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';
import { tenantIsolationExtension } from './tenant-isolation.extension.js';
import { tenantTransactionExtension } from './tenant-transaction.js';
import type { TenantTransactionSettings } from './tenant-transaction.js';

export interface DatabaseSettings extends TenantTransactionSettings {
  readonly url: string;
  readonly poolSize: number;
}

/**
 * Único ponto que instancia o `PrismaClient` da aplicação (RN-FND-43 — o outro é o do
 * `SystemDbService`, papel `cf_platform`): Prisma 7 com
 * `@prisma/adapter-pg` (DEC-064), a extensão de isolamento por tenant (US-100 · RN-TEN-23) e, sobre
 * ela, a `TenantTransaction` — não existe cliente de dados de tenant sem a extensão. O pool conecta
 * sob demanda, na primeira transação: a API sobe com o banco fora do ar e responde 503 até ele
 * voltar.
 */
export function createTenantPrismaClient(settings: DatabaseSettings) {
  const base = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: settings.url,
      max: settings.poolSize,
      connectionTimeoutMillis: settings.maxWaitMs,
    }),
  });
  // A extensão só intercepta consultas (não muda a API do cliente): o `tx` continua um
  // `Prisma.TransactionClient` para os repositórios.
  const isolated = base.$extends(tenantIsolationExtension) as unknown as PrismaClient;
  return isolated.$extends(tenantTransactionExtension(isolated, settings));
}

export type TenantPrismaClient = ReturnType<typeof createTenantPrismaClient>;

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';
import { tenantTransactionExtension } from './tenant-transaction.js';
import type { TenantTransactionSettings } from './tenant-transaction.js';

export interface DatabaseSettings extends TenantTransactionSettings {
  readonly url: string;
  readonly poolSize: number;
}

/**
 * Único ponto que instancia o `PrismaClient` (RN-FND-43): Prisma 7 com `@prisma/adapter-pg`
 * (DEC-064) e a extensão `TenantTransaction` já aplicada. O pool conecta sob demanda, na primeira
 * transação — a API sobe com o banco fora do ar e responde 503 até ele voltar.
 */
export function createTenantPrismaClient(settings: DatabaseSettings) {
  const base = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: settings.url,
      max: settings.poolSize,
      connectionTimeoutMillis: settings.maxWaitMs,
    }),
  });
  return base.$extends(tenantTransactionExtension(base, settings));
}

export type TenantPrismaClient = ReturnType<typeof createTenantPrismaClient>;

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

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
export function createTenantPrismaClient(settings: DatabaseSettings, pool?: pg.Pool) {
  const base = new PrismaClient({
    // Com `pool` (o do `DatabaseModule`), o mesmo pool atende o Prisma, o `SELECT 1` do
    // `/health/ready` e as métricas de conexões (US-085); quem o criou o encerra.
    adapter: new PrismaPg(pool ?? databasePoolConfig(settings)),
  });
  // A extensão só intercepta consultas (não muda a API do cliente): o `tx` continua um
  // `Prisma.TransactionClient` para os repositórios.
  const isolated = base.$extends(tenantIsolationExtension) as unknown as PrismaClient;
  return isolated.$extends(tenantTransactionExtension(isolated, settings));
}

function databasePoolConfig(settings: DatabaseSettings): pg.PoolConfig {
  return {
    connectionString: settings.url,
    max: settings.poolSize,
    connectionTimeoutMillis: settings.maxWaitMs,
  };
}

/** Pool `pg` da aplicação (sob demanda: nenhuma conexão até a primeira consulta). */
export function createDatabasePool(settings: DatabaseSettings): pg.Pool {
  const pool = new pg.Pool(databasePoolConfig(settings));
  // Erro de conexão ociosa (banco reiniciado): o pool descarta o cliente; sem handler, derruba o
  // processo.
  pool.on('error', () => undefined);
  return pool;
}

export type TenantPrismaClient = ReturnType<typeof createTenantPrismaClient>;

/**
 * Superfície do Prisma para os repositórios (`modules/<m>/infrastructure/**`): tipos dos modelos,
 * `Prisma.sql`/`Prisma.join` para SQL bruto parametrizado e `Prisma.Decimal`. O `PrismaClient`
 * fica de fora de propósito — o acesso é só pelo `TenantTransaction` (RN-FND-43).
 */
export { OutboxStatus, Prisma } from './generated/prisma/client.js';
export type { OutboxEvent } from './generated/prisma/client.js';
export type { TenantTx } from './tenant-transaction.js';

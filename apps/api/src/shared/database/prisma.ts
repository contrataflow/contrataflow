/**
 * Superfície do Prisma para os repositórios (`modules/<m>/infrastructure/**`): tipos dos modelos,
 * `Prisma.sql`/`Prisma.join` para SQL bruto parametrizado e `Prisma.Decimal`. O `PrismaClient`
 * fica de fora de propósito — o acesso é só pelo `TenantTransaction` (RN-FND-43) ou, para as
 * tabelas de plataforma, pelo `PlatformTransaction` (US-087).
 */
export {
  MembershipStatus,
  MembershipType,
  OutboxStatus,
  Prisma,
  TenantStatus,
  TenantType,
  UserStatus,
} from './generated/prisma/client.js';
export type {
  MembershipDepartment,
  OutboxEvent,
  Tenant,
  TenantMembership,
  User,
} from './generated/prisma/client.js';
export type { TenantTx } from './tenant-transaction.js';

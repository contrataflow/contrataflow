// Violação: contrataflow/no-prisma-client-outside-database (PrismaClient fora da TenantTransaction).
import { PrismaClient } from '#shared/database/generated/prisma/client.js';

export const client = new PrismaClient();

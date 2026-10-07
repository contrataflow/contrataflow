// Violação: contrataflow/no-prisma-outside-infrastructure (Prisma no domínio).
import { PrismaClient } from '@prisma/client';

export const client = new PrismaClient();

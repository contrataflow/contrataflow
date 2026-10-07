import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export function findByNumber(processNumber: string): Promise<unknown> {
  return prisma.$queryRaw`SELECT * FROM processes WHERE number = ${processNumber}`;
}

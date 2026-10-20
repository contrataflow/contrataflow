import type { TenantTx } from '#shared/database/prisma.js';

/** Repositório recebe o `tx` da TenantTransaction (RN-FND-43); nunca o PrismaClient. */
export function findByNumber(tx: TenantTx, processNumber: string): Promise<unknown> {
  return tx.$queryRaw`SELECT * FROM processes WHERE number = ${processNumber}`;
}

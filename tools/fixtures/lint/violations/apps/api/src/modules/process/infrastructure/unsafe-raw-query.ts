// Violação: contrataflow/no-unsafe-raw-query (SQL concatenado, sem parâmetros).
declare const prisma: { $queryRawUnsafe(sql: string): Promise<unknown> };

export function findByNumber(processNumber: string): Promise<unknown> {
  return prisma.$queryRawUnsafe(`SELECT * FROM processes WHERE number = '${processNumber}'`);
}

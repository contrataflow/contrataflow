declare const prisma: { $queryRawUnsafe(sql: string): Promise<unknown> };

export function searchProcesses(term: string): Promise<unknown> {
  return prisma.$queryRawUnsafe(`SELECT * FROM processes WHERE title ILIKE '%${term}%'`);
}

// Casos de teste da regra (semgrep --test .semgrep/rules).
declare const prisma: {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
};
declare const name: string;

export async function search() {
  // ruleid: cf-no-unsafe-raw-query
  await prisma.$queryRawUnsafe(`SELECT * FROM processes WHERE title = '${name}'`);
  // ruleid: cf-no-unsafe-raw-query
  await prisma.$executeRawUnsafe('DELETE FROM processes');
  // ok: cf-no-unsafe-raw-query
  await prisma.$queryRaw`SELECT * FROM processes WHERE title = ${name}`;
}

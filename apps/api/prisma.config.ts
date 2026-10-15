import { defineConfig } from 'prisma/config';

// Prisma 7 (DEC-064): a URL do datasource fica aqui, não no schema. As migrações rodam com o papel
// migrador (`cf_migrator` em produção; o superusuário local no ambiente de desenvolvimento), nunca
// com o papel da aplicação (RN-FND-46). `prisma generate` não abre conexão e dispensa a variável.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_MIGRATION_URL ?? '' },
});

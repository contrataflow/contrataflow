// pnpm db:migrate — aplica as migrações do Prisma no PostgreSQL local (US-081 — fluxo principal 1).
import { createContext, runMain } from './lib/cli.js';
import { dbMigrate } from './lib/db-migrate.js';

await runMain(async () => {
  await dbMigrate(createContext());
});

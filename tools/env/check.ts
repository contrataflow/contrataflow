// pnpm env:check — executado por `pnpm dev` antes de subir web/api/worker (US-078).
import { envCheck } from './lib/check.js';
import { createContext, runMain } from './lib/cli.js';

await runMain(async () => {
  const context = createContext();
  await envCheck(context.compose, context.logger);
});

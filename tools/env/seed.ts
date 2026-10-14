// pnpm env:seed — povoa os tenants "Prefeitura A" e "Prefeitura B" (US-078 · RN-FND-18).
import { createContext, runMain } from './lib/cli.js';
import { envSeed } from './lib/seed.js';

await runMain(async () => {
  await envSeed(createContext());
});

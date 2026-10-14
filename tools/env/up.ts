// pnpm env:up [--profile observability|full] — sobe a infraestrutura local (US-078).
// pnpm env:up:full — idem com api/web/worker em contêiner (FA-01).
import { createContext, profilesFrom, runMain, upTimeoutMs, withEnvLock } from './lib/cli.js';
import { envUp } from './lib/up.js';

await runMain(async () => {
  const context = createContext();
  const timeoutMs = upTimeoutMs(context.env);
  await withEnvLock(context, () =>
    envUp({
      ...context,
      profiles: profilesFrom(process.argv.slice(2), context.env),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  );
  context.logger.step('Próximo passo: pnpm env:seed && pnpm dev');
});

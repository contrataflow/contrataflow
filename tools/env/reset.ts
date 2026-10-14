// pnpm env:reset — recomeça do zero: `down -v` + `env:up` + `env:seed` (US-078 — fluxo 7).
import { createContext, profilesFrom, runMain, upTimeoutMs, withEnvLock } from './lib/cli.js';
import { PROFILES } from './lib/env-file.js';
import { EnvError } from './lib/log.js';
import { envSeed } from './lib/seed.js';
import { envUp } from './lib/up.js';

await runMain(async () => {
  const context = createContext();
  const profiles = profilesFrom(process.argv.slice(2), context.env);
  const timeoutMs = upTimeoutMs(context.env);
  await withEnvLock(context, async () => {
    context.logger.step('▶ docker compose down -v (remove contêineres e volumes do ContrataFlow)');
    const down = await context.compose.run(['down', '-v', '--remove-orphans'], {
      stream: true,
      profiles: PROFILES,
    });
    if (down.status !== 0) {
      throw new EnvError('COMPOSE_FAILED', 'docker compose down -v falhou (veja a saída acima).');
    }
    await envUp({ ...context, profiles, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    await envSeed(context);
  });
});

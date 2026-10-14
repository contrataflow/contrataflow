// `pnpm env:check` — guarda do `pnpm dev` (Gherkin "[Falha de banco]"): sem a infraestrutura padrão
// saudável, api e worker não são iniciados contra um ambiente quebrado.
import { composeStatus, DEFAULT_SERVICES, readinessOf } from './compose.js';
import type { Compose } from './compose.js';
import { EnvError } from './log.js';
import type { Logger } from './log.js';
import { ENV_NOT_READY_MESSAGE } from './seed.js';

export async function envCheck(compose: Compose, logger: Logger): Promise<void> {
  const version = await compose.run(['version', '--short']);
  if (version.status !== 0) {
    throw new EnvError('ENV_NOT_READY', `${ENV_NOT_READY_MESSAGE} (Docker indisponível)`);
  }
  const pending = readinessOf(DEFAULT_SERVICES, await composeStatus(compose)).filter(
    (item) => item.readiness !== 'ready',
  );
  if (pending.length > 0) {
    throw new EnvError(
      'ENV_NOT_READY',
      `${ENV_NOT_READY_MESSAGE} (fora do ar: ${pending.map((item) => `${item.service} — ${item.detail}`).join(', ')})`,
    );
  }
  logger.info('env.check.ok', 'Infraestrutura local saudável.');
}

import { uuidv7 } from '@contrataflow/observability';

import {
  DatabaseOperatorDirectory,
  JwksOperatorTokenVerifier,
  OperatorAccessError,
  OperatorAuthenticator,
} from './admin/operator-authenticator.js';
import { PlatformAuditWriter } from './admin/platform-audit.js';
import { CLI_USAGE, runQueueCli } from './admin/queue-cli.js';
import { QueueOperations } from './admin/queue-operations.js';
import { QueuesConfigError, loadQueueCliConfigFromProcess } from './config/queues.js';
import { BullQueues } from './queues/bull-queues.js';
import { createOutboxDatabase } from './shared/database/outbox-database.js';
import { createWorkerDatabase } from './shared/database/worker-database.js';

/*
 * CLI de operação das filas (FA-04 · queues.md §5.6/§11.2): `node dist/cli.js <comando>`, com o
 * access token do operador em `CF_OPS_TOKEN`. Exige `PLATFORM_QUEUE_ADMIN` + MFA; negação e
 * mutações ficam na auditoria de plataforma.
 */

const output = {
  out: (text: string) => process.stdout.write(`${text}\n`),
  err: (text: string) => process.stderr.write(`${text}\n`),
};

async function main(argv: readonly string[]): Promise<number> {
  let config;
  try {
    config = loadQueueCliConfigFromProcess();
  } catch (error) {
    if (!(error instanceof QueuesConfigError)) throw error;
    output.err(`Configuração ausente: ${error.keys.join(', ')}\n${CLI_USAGE}`);
    return 2;
  }
  const database = createWorkerDatabase({
    url: config.queues.workerDatabaseUrl ?? '',
    poolSize: 2,
    applicationName: 'contrataflow-worker-cli',
  });
  const outbox = config.relayDatabaseUrl
    ? createOutboxDatabase({
        url: config.relayDatabaseUrl,
        applicationName: 'contrataflow-worker-cli',
      })
    : null;
  const bull = new BullQueues({ redisUrl: config.queues.redisUrl, appEnv: config.queues.appEnv });
  const audit = new PlatformAuditWriter(database);
  try {
    const authenticator = new OperatorAuthenticator(
      new JwksOperatorTokenVerifier({ issuer: config.issuer, audience: config.audience }),
      new DatabaseOperatorDirectory(database),
    );
    let operator;
    try {
      operator = await authenticator.authenticate(config.token);
    } catch (error) {
      if (!(error instanceof OperatorAccessError)) throw error;
      if (error.code !== 'UNAUTHENTICATED') {
        await audit.record({
          action: 'queue_dashboard.access',
          result: 'DENIED',
          reasonCode: error.code,
          actorUserId: error.operator?.userId ?? null,
          actorName: error.operator?.name ?? null,
          tenantId: null,
          metadata: { actorType: 'PLATFORM_OPERATOR', channel: 'cli' },
          correlationId: uuidv7(),
        });
      }
      output.err(`${error.code}: acesso negado à CLI de filas.`);
      return 1;
    }
    const operations = new QueueOperations({
      queue: (name) => bull.queue(name),
      audit,
      operator,
      ...(outbox ? { outboxTransaction: outbox.transaction.bind(outbox) } : {}),
    });
    return await runQueueCli(argv, operations, output);
  } finally {
    await bull.close();
    await outbox?.close();
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));

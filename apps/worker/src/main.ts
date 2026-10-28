import 'reflect-metadata';

import { TelemetryConfigError, createLogger } from '@contrataflow/observability';

import { startWorker } from './bootstrap.js';
import { ApiJobsConfigError, loadApiJobsConfigFromProcess } from './config/api-jobs.js';
import { EmailConfigError, loadEmailConfigFromProcess } from './config/email.js';
import { HealthConfigError, loadHealthConfigFromProcess } from './config/health.js';
import { OutboxConfigError, loadOutboxConfigFromProcess } from './config/outbox.js';
import { QueuesConfigError, loadQueuesConfigFromProcess } from './config/queues.js';
import type { QueueRuntimeConfig } from './config/queues.js';
import { SessionsConfigError, loadSessionsConfigFromProcess } from './config/sessions.js';
import { loadTelemetryConfigFromProcess } from './config/telemetry.js';
import { createWorkerLogger } from './observability/worker-logger.js';

/** O e-mail transacional (US-112) só existe com as filas; obrigatório fora de local/dev/test. */
function withEmail(queues: QueueRuntimeConfig | null): QueueRuntimeConfig | null {
  return queues && { ...queues, email: loadEmailConfigFromProcess(queues.appEnv) };
}

try {
  const telemetry = loadTelemetryConfigFromProcess();
  const outbox = loadOutboxConfigFromProcess();
  const queues = withEmail(loadQueuesConfigFromProcess());
  await startWorker({
    rootLogger: createWorkerLogger(telemetry),
    outbox,
    sessions: loadSessionsConfigFromProcess(),
    queues,
    // DEC-052: PDF, varredura de anexos e IA — os jobs dos módulos da API (só com as filas).
    apiJobs: queues ? loadApiJobsConfigFromProcess() : null,
    // `/health/*` e `/metrics` na porta interna (US-085): dependências da matriz de §6.2.
    ops: {
      health: loadHealthConfigFromProcess(),
      appVersion: telemetry.version,
      environment: telemetry.environment,
      databaseUrl: queues?.workerDatabaseUrl ?? outbox?.relayDatabaseUrl ?? null,
      redisUrl: queues?.redisUrl ?? outbox?.redisUrl ?? null,
      smtpUrl: queues?.email?.smtpUrl ?? null,
    },
  });
} catch (error) {
  // V-03: configuração inválida (observabilidade, outbox, filas, e-mail, Redis de sessões,
  // health/métricas ou jobs da API) impede o processo de subir (só as chaves).
  if (
    !(error instanceof TelemetryConfigError) &&
    !(error instanceof OutboxConfigError) &&
    !(error instanceof QueuesConfigError) &&
    !(error instanceof SessionsConfigError) &&
    !(error instanceof EmailConfigError) &&
    !(error instanceof HealthConfigError) &&
    !(error instanceof ApiJobsConfigError)
  )
    throw error;
  createLogger({ service: 'worker', env: 'unknown', version: 'unknown', level: 'info' }).fatal(
    { event: 'worker.config_invalid', keys: error.keys },
    'invalid configuration',
  );
  process.exitCode = 1;
}

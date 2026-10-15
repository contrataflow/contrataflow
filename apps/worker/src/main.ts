import 'reflect-metadata';

import { TelemetryConfigError, createLogger } from '@contrataflow/observability';

import { startWorker } from './bootstrap.js';
import { OutboxConfigError, loadOutboxConfigFromProcess } from './config/outbox.js';
import { SessionsConfigError, loadSessionsConfigFromProcess } from './config/sessions.js';
import { loadTelemetryConfigFromProcess } from './config/telemetry.js';
import { createWorkerLogger } from './observability/worker-logger.js';

try {
  await startWorker({
    rootLogger: createWorkerLogger(loadTelemetryConfigFromProcess()),
    outbox: loadOutboxConfigFromProcess(),
    sessions: loadSessionsConfigFromProcess(),
  });
} catch (error) {
  // V-03: configuração inválida (observabilidade, outbox ou Redis de sessões) impede o processo
  // de subir (só as chaves).
  if (
    !(error instanceof TelemetryConfigError) &&
    !(error instanceof OutboxConfigError) &&
    !(error instanceof SessionsConfigError)
  )
    throw error;
  createLogger({ service: 'worker', env: 'unknown', version: 'unknown', level: 'info' }).fatal(
    { event: 'worker.config_invalid', keys: error.keys },
    'invalid configuration',
  );
  process.exitCode = 1;
}

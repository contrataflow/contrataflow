import 'reflect-metadata';

import { TelemetryConfigError, createLogger } from '@contrataflow/observability';

import { startWorker } from './bootstrap.js';
import { loadTelemetryConfigFromProcess } from './config/telemetry.js';
import { createWorkerLogger } from './observability/worker-logger.js';

try {
  await startWorker({ rootLogger: createWorkerLogger(loadTelemetryConfigFromProcess()) });
} catch (error) {
  // V-03: configuração de observabilidade inválida impede o processo de subir (só as chaves).
  if (!(error instanceof TelemetryConfigError)) throw error;
  createLogger({ service: 'worker', env: 'unknown', version: 'unknown', level: 'info' }).fatal(
    { event: 'worker.config_invalid', keys: error.keys },
    'invalid configuration',
  );
  process.exitCode = 1;
}

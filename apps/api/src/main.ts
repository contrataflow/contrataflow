import 'reflect-metadata';

import { createLogger } from '@contrataflow/observability';

import { ConfigValidationError, loadConfigFromProcess } from '#config/env.js';
import { createApiLogger } from '#shared/observability/observability.module.js';

import { startApi } from './bootstrap.js';

try {
  const config = loadConfigFromProcess();
  await startApi({ config, rootLogger: createApiLogger(config) });
} catch (error) {
  // V-01/V-03: configuração inválida impede o processo de subir, apontando as chaves (sem valores).
  if (!(error instanceof ConfigValidationError)) throw error;
  createLogger({ service: 'api', env: 'unknown', version: 'unknown', level: 'info' }).fatal(
    { event: 'api.config_invalid', keys: error.keys },
    'invalid configuration',
  );
  process.exitCode = 1;
}

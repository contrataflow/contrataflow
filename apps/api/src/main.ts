import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { ConfigValidationError, loadConfigFromProcess } from '#config/env.js';

import { startApi } from './bootstrap.js';

try {
  await startApi({ config: loadConfigFromProcess() });
} catch (error) {
  // V-01: configuração inválida impede o processo de subir, apontando as chaves (sem valores).
  if (!(error instanceof ConfigValidationError)) throw error;
  new Logger('Bootstrap').error(`api.config_invalid keys=${error.keys.join(',')}`);
  process.exitCode = 1;
}

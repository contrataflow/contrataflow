import { describe, expect, it } from 'vitest';

import { loadTelemetryConfigFromProcess } from './telemetry.js';
import { createWorkerLogger } from '../observability/worker-logger.js';

describe('configuração de observabilidade do worker', () => {
  it('lê a telemetria do worker do ambiente do processo', () => {
    const config = loadTelemetryConfigFromProcess();
    expect(config.serviceName).toBe('contrataflow-worker');
    expect(createWorkerLogger(config).level).toBe(config.logLevel);
  });
});

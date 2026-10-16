import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

import { captureLogs } from '@contrataflow/observability/testing';
import { __resetOutOfContextForTests } from 'nestjs-pino/PinoLogger.js';
import { describe, expect, it, vi } from 'vitest';

import { loadTelemetryConfigFromProcess } from '#config/telemetry.js';
import { createApiLogger } from '#shared/observability/observability.module.js';

import { startApi } from './bootstrap.js';
import type { ShutdownProcess } from './graceful-shutdown.js';
import { testConfig } from '../test/support/api-test-app.js';

class FakeProcess extends EventEmitter implements ShutdownProcess {
  exitCode: number | string | null | undefined = undefined;
  readonly exit = vi.fn<(code: number) => void>();
}

// Sobe a aplicação inteira: sob a carga paralela do turbo, o padrão de 5 s do Vitest não basta.
describe('startApi', { timeout: 30_000 }, () => {
  it('sobe com todos os módulos e encerra com código 0 ao receber SIGTERM', async () => {
    const proc = new FakeProcess();
    const { app, stopped } = await startApi({
      config: testConfig(),
      port: 0,
      metricsPort: 0,
      proc,
      logger: false,
    });
    const server = app.getHttpServer() as Server;

    expect(server.listening).toBe(true);

    proc.emit('SIGTERM');

    await expect(stopped).resolves.toBe('SIGTERM');
    expect(server.listening).toBe(false);
    expect(proc.exitCode).toBe(0);
  });

  it('com logger, todo log do Nest sai em JSON pelo pino (RN-FND-71)', async () => {
    const proc = new FakeProcess();
    const logs = captureLogs();
    const config = testConfig();
    __resetOutOfContextForTests();
    const { stopped } = await startApi({
      config,
      port: 0,
      metricsPort: 0,
      proc,
      rootLogger: createApiLogger(config, logs.destination),
    });
    proc.emit('SIGTERM');
    await stopped;

    const events = logs.lines().map((line) => line.event);
    expect(events).toEqual(expect.arrayContaining(['api.started', 'api.stopping', 'api.stopped']));
    expect(logs.lines().find((line) => line.event === 'api.started')).toMatchObject({
      service: 'api',
      env: 'test',
      context: 'Bootstrap',
      msg: 'api started',
    });
    expect(logs.lines().find((line) => line.event === 'api.stopping')?.signal).toBe('SIGTERM');
  });
});

describe('loadTelemetryConfigFromProcess', () => {
  it('lê a telemetria da API do ambiente do processo', () => {
    expect(loadTelemetryConfigFromProcess().serviceName).toBe('contrataflow-api');
  });
});

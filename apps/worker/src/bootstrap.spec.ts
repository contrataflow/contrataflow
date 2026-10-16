import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { startWorker } from './bootstrap.js';
import type { ShutdownProcess } from './graceful-shutdown.js';
import { WorkerModule } from './worker.module.js';

class FakeProcess extends EventEmitter implements ShutdownProcess {
  exitCode: number | string | null | undefined = undefined;
  readonly exit = vi.fn<(code: number) => void>();
}

describe('worker em estado hello', () => {
  it('inicializa o contexto standalone e encerra com código 0 ao receber SIGTERM', async () => {
    const proc = new FakeProcess();
    const { context, stopped } = await startWorker({ proc, logger: false });

    expect(context.get(WorkerModule)).toBeInstanceOf(WorkerModule);

    proc.emit('SIGTERM');

    await expect(stopped).resolves.toBe('SIGTERM');
    expect(proc.exitCode).toBe(0);
  });

  it('com ops, sobe /health/* e /metrics na porta interna e os fecha no encerramento', async () => {
    const proc = new FakeProcess();
    const { ops, stopped } = await startWorker({
      proc,
      logger: false,
      ops: {
        health: { metricsPort: 0, cacheTtlMs: 5_000, checkTimeoutMs: null },
        appVersion: '0.0.0+local',
        environment: 'test',
        databaseUrl: null,
        redisUrl: null,
        smtpUrl: null,
        host: '127.0.0.1',
      },
    });
    expect(ops).not.toBeNull();
    const live = await fetch(`http://127.0.0.1:${String(ops?.port)}/health/live`);
    expect(live.status).toBe(200);

    proc.emit('SIGTERM');
    await expect(stopped).resolves.toBe('SIGTERM');
    await expect(fetch(`http://127.0.0.1:${String(ops?.port)}/health/live`)).rejects.toThrow();
  });
});

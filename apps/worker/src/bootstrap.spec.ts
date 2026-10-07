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
});

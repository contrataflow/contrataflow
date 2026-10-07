import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { startApi } from './bootstrap.js';
import type { ShutdownProcess } from './graceful-shutdown.js';

class FakeProcess extends EventEmitter implements ShutdownProcess {
  exitCode: number | string | null | undefined = undefined;
  readonly exit = vi.fn<(code: number) => void>();
}

describe('api em estado hello', () => {
  it('inicializa sem erros e encerra com código 0 ao receber SIGTERM', async () => {
    const proc = new FakeProcess();
    const { app, stopped } = await startApi({ port: 0, proc, logger: false });
    const server = app.getHttpServer() as Server;

    expect(server.listening).toBe(true);

    proc.emit('SIGTERM');

    await expect(stopped).resolves.toBe('SIGTERM');
    expect(server.listening).toBe(false);
    expect(proc.exitCode).toBe(0);
  });
});

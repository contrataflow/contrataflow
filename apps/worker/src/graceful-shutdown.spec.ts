import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGracefulShutdown } from './graceful-shutdown.js';
import type { ShutdownProcess } from './graceful-shutdown.js';

class FakeProcess extends EventEmitter implements ShutdownProcess {
  exitCode: number | string | null | undefined = undefined;
  readonly exit = vi.fn<(code: number) => void>();
}

const logger = { log: vi.fn(), error: vi.fn() };

describe('registerGracefulShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('fecha a aplicação no SIGTERM e define o código de saída 0', async () => {
    const proc = new FakeProcess();
    const close = vi.fn(() => Promise.resolve());
    const stopped = registerGracefulShutdown({ close }, { name: 'api', logger, proc });

    proc.emit('SIGTERM');

    await expect(stopped).resolves.toBe('SIGTERM');
    expect(close).toHaveBeenCalledOnce();
    expect(proc.exitCode).toBe(0);
    expect(proc.exit).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith('api.stopping signal=SIGTERM');
    expect(logger.log).toHaveBeenCalledWith('api.stopped');
  });

  it('também atende SIGINT e ignora sinais repetidos', async () => {
    const proc = new FakeProcess();
    const close = vi.fn(() => Promise.resolve());
    const stopped = registerGracefulShutdown({ close }, { name: 'worker', logger, proc });

    proc.emit('SIGINT');
    proc.emit('SIGTERM');

    await expect(stopped).resolves.toBe('SIGINT');
    expect(close).toHaveBeenCalledOnce();
  });

  it('define o código 1 quando o encerramento falha', async () => {
    const proc = new FakeProcess();
    const failure = new Error('conexão presa');
    const stopped = registerGracefulShutdown(
      { close: () => Promise.reject(failure) },
      { name: 'api', logger, proc },
    );

    proc.emit('SIGTERM');

    await stopped;
    expect(proc.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith('api.shutdown_failed', failure.stack);
  });

  it('registra falhas que não são Error', async () => {
    const proc = new FakeProcess();
    const stopped = registerGracefulShutdown(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- cobre rejeição com valor que não é Error
      { close: () => Promise.reject('texto') },
      { name: 'api', logger, proc },
    );

    proc.emit('SIGTERM');

    await stopped;
    expect(logger.error).toHaveBeenCalledWith('api.shutdown_failed', 'texto');
  });

  it('força a saída com código 1 quando o prazo de encerramento esgota', () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    void registerGracefulShutdown(
      { close: () => new Promise<void>(() => undefined) },
      { name: 'api', logger, proc, timeoutMs: 1_000 },
    );

    proc.emit('SIGTERM');
    vi.advanceTimersByTime(1_000);

    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith('api.shutdown_timeout timeoutMs=1000');
  });
});

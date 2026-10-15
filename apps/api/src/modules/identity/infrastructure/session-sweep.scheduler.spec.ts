import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemorySessionRegistry } from '#shared/sessions/in-memory-session-registry.js';
import { DisabledSessionRegistry } from '#shared/sessions/session-registry.js';
import type { SessionRegistryPort } from '#shared/sessions/session-registry.js';

import { SESSION_SWEEP_INTERVAL_MS, SessionSweepScheduler } from './session-sweep.scheduler.js';
import type { RecordSessionEndingsCommand } from '../application/record-session-endings.command.js';

/* US-088 — agendamento da varredura no processo da API (DEC-071). */

function schedulerWith(
  run: () => Promise<unknown>,
  registry: SessionRegistryPort = new InMemorySessionRegistry(),
) {
  const command = { run: vi.fn(run) };
  const scheduler = new SessionSweepScheduler(
    command as unknown as RecordSessionEndingsCommand,
    registry,
  );
  return { scheduler, command };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionSweepScheduler', () => {
  it('liga com o Redis de sessões e roda a cada 60 s, não antes', async () => {
    const { scheduler, command } = schedulerWith(() => Promise.resolve({}));
    scheduler.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS - 1);
    expect(command.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(command.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS * 2);
    expect(command.run).toHaveBeenCalledTimes(3);
    expect(SESSION_SWEEP_INTERVAL_MS).toBe(60_000);

    scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS * 2);
    expect(command.run).toHaveBeenCalledTimes(3);
  });

  it('sem Redis de sessões configurado não agenda nada', async () => {
    const { scheduler, command } = schedulerWith(
      () => Promise.resolve({}),
      new DisabledSessionRegistry(),
    );
    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS * 3);
    expect(command.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    scheduler.onModuleDestroy();
  });

  it('não sobrepõe execuções: ciclo lento faz o tique seguinte ser ignorado', async () => {
    let finish: () => void = () => undefined;
    const { scheduler, command } = schedulerWith(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    scheduler.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS * 3);
    expect(command.run).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
    expect(command.run).toHaveBeenCalledTimes(2);
    finish();
    scheduler.onModuleDestroy();
  });

  it('erro inesperado do comando é registrado e não derruba o processo nem o agendamento', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new TypeError('inesperado'))
      .mockResolvedValue({});
    const { scheduler, command } = schedulerWith(run);
    scheduler.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      { event: 'auth.session_sweep_failed', reason: 'TypeError' },
      'auth.session_sweep_failed',
    );
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
    expect(command.run).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });

  it('o timer não segura o processo aberto (unref)', () => {
    const { scheduler } = schedulerWith(() => Promise.resolve({}));
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    scheduler.onApplicationBootstrap();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    scheduler.onModuleDestroy();
  });
});

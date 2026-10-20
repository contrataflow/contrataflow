import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withLockTiming } from './row-lock.js';

const target = { lockType: 'FOR UPDATE', tableName: 'processes' };

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('withLockTiming (DEC-055 · log db.lock_wait)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('trava rápida: devolve o resultado sem log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(withLockTiming(target, () => Promise.resolve('linha'))).resolves.toBe('linha');
    expect(warn).not.toHaveBeenCalled();
  });

  it('espera acima de 200 ms: warn com tipo, tabela e duração', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await withLockTiming(target, () => wait(230));
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /^db\.lock_wait lockType=FOR UPDATE tableName=processes durationMs=\d+\.\d correlationId=-$/,
    );
  });

  it('falha ao obter a trava: propaga o erro e ainda mede a espera', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const attempt = withLockTiming(target, async () => {
      await wait(230);
      throw new Error('lock timeout');
    });
    await expect(attempt).rejects.toThrow('lock timeout');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

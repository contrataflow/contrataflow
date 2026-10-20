import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutosaveError, AutosaveQueue } from './autosave-queue.js';
import type { AutosaveFailure, AutosaveQueueOptions } from './autosave-queue.js';

type Save = AutosaveQueueOptions<string>['save'];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(save: Save, overrides: Partial<AutosaveQueueOptions<string>> = {}) {
  const local = {
    persist: vi.fn((_target: string, _value: string) => Promise.resolve()),
    remove: vi.fn((_target: string) => Promise.resolve()),
  };
  const onConflict = vi.fn();
  const onBlocked = vi.fn();
  const queue = new AutosaveQueue<string>({
    save,
    local,
    onConflict,
    onBlocked,
    now: () => Date.now(),
    ...overrides,
  });
  return { queue, local, onConflict, onBlocked };
}

const failWith = (failure: AutosaveFailure) => () => Promise.reject(new AutosaveError(failure));

describe('AutosaveQueue (US-015 · RN-DFD-23 · DEC-182)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T17:32:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grava 1,5 s depois da última alteração, com o último valor (debounce)', async () => {
    const save = vi.fn<Save>(() => Promise.resolve());
    const { queue, local } = setup(save);
    queue.change('S', 'a');
    expect(queue.getSnapshot().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    queue.change('S', 'ab');
    await vi.advanceTimersByTimeAsync(1499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('S', 'ab', { resolution: null });
    expect(local.persist).toHaveBeenCalledWith('S', 'ab');
    expect(local.remove).toHaveBeenCalledWith('S');
    expect(queue.getSnapshot()).toMatchObject({
      status: 'saved',
      savedAt: Date.parse('2026-10-17T17:32:02.500Z'),
      hasPending: false,
    });
  });

  it('no máximo uma gravação em voo por alvo; o que mudou durante o voo segue em seguida', async () => {
    const first = deferred();
    const save = vi
      .fn<Save>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve());
    const { queue } = setup(save);
    queue.change('S', 'v1');
    void queue.flush('S');
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getSnapshot().status).toBe('saving');
    queue.change('S', 'v2');
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('S', 'v2', { resolution: null });
  });

  it('alvos diferentes gravam em paralelo e de forma independente', async () => {
    const save = vi.fn<Save>(() => Promise.resolve());
    const { queue } = setup(save);
    queue.change('A', '1');
    queue.change('B', '2');
    await queue.flush();
    expect(save.mock.calls.map(([target, value]) => [target, value])).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('FA-01: conflito pausa só o alvo; "Manter a minha" reenvia com keepMine e "Descartar" esquece', async () => {
    const save = vi
      .fn<Save>()
      .mockImplementationOnce(failWith({ kind: 'conflict', current: { revision: 6 } }))
      .mockImplementation(() => Promise.resolve());
    const { queue, onConflict, local } = setup(save);
    queue.change('S', 'minha');
    queue.change('T', 'outra');
    await queue.flush();
    expect(onConflict).toHaveBeenCalledWith('S', { kind: 'conflict', current: { revision: 6 } });
    expect(queue.getSnapshot().targets.S?.phase).toBe('conflict');
    expect(queue.getSnapshot().targets.T?.phase).toBe('saved');
    expect(queue.getSnapshot().status).toBe('conflict');
    // Pausado: novas alterações não disparam gravação.
    queue.change('S', 'minha 2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    await queue.keepMine('S');
    expect(save).toHaveBeenLastCalledWith('S', 'minha 2', { resolution: 'keepMine' });
    expect(queue.getSnapshot().targets.S?.phase).toBe('saved');

    save.mockImplementationOnce(failWith({ kind: 'conflict' }));
    queue.change('S', 'terceira');
    await queue.flush('S');
    await queue.discard('S');
    expect(local.remove).toHaveBeenLastCalledWith('S');
    expect(queue.getSnapshot().targets.S).toMatchObject({ phase: 'saved', hasPending: false });
  });

  it('FA-03: sem conexão guarda e retenta com backoff 2, 4, 8, 16, 30, 30 s; a volta da rede reenvia já', async () => {
    const save = vi.fn<Save>(failWith({ kind: 'offline' }));
    const { queue, local } = setup(save);
    queue.change('S', 'texto');
    await queue.flush('S');
    expect(queue.getSnapshot().status).toBe('offline');
    expect(local.persist).toHaveBeenCalledWith('S', 'texto');
    expect(local.remove).not.toHaveBeenCalled();
    for (const delay of [2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const calls = save.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(save).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledTimes(calls + 1);
    }
    save.mockImplementation(() => Promise.resolve());
    queue.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getSnapshot().status).toBe('saved');
    expect(local.remove).toHaveBeenCalledWith('S');
  });

  it('FA-04: 429 respeita o Retry-After, mantém "Salvando…" e coalesce o acumulado', async () => {
    const save = vi
      .fn<Save>()
      .mockImplementationOnce(failWith({ kind: 'rateLimited', retryAfterMs: 5000 }))
      .mockImplementation(() => Promise.resolve());
    const { queue } = setup(save);
    queue.change('S', 'v1');
    await queue.flush('S');
    expect(queue.getSnapshot().status).toBe('saving');
    queue.change('S', 'v2');
    queue.change('S', 'v3');
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('S', 'v3', { resolution: null });
  });

  it('FA-09: conteúdo inválido mostra "Erro ao salvar" com a explicação e só volta a gravar na próxima alteração', async () => {
    const save = vi
      .fn<Save>()
      .mockImplementationOnce(
        failWith({ kind: 'invalid', message: 'O texto excede 50.000 caracteres.' }),
      )
      .mockImplementation(() => Promise.resolve());
    const { queue, local } = setup(save);
    queue.change('S', 'longo');
    await queue.flush('S');
    expect(queue.getSnapshot()).toMatchObject({
      status: 'error',
      message: 'O texto excede 50.000 caracteres.',
      hasPending: true,
    });
    expect(local.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    queue.change('S', 'corrigido');
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenLastCalledWith('S', 'corrigido', { resolution: null });
    expect(queue.getSnapshot().status).toBe('saved');
  });

  it('FA-05/06/07: documento bloqueado ou sessão expirada param TODO o autosave e mantêm a pendência', async () => {
    const save = vi.fn<Save>(
      failWith({
        kind: 'blocked',
        reason: 'DOCUMENT_NOT_EDITABLE',
        detail: { status: 'IN_REVIEW' },
      }),
    );
    const { queue, onBlocked, local } = setup(save);
    queue.change('S', 'pendente');
    await queue.flush('S');
    expect(onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'blocked', reason: 'DOCUMENT_NOT_EDITABLE' }),
    );
    expect(queue.getSnapshot()).toMatchObject({ status: 'blocked', hasPending: true });
    queue.change('T', 'outra');
    await vi.advanceTimersByTimeAsync(5000);
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(local.remove).not.toHaveBeenCalled();
    expect(queue.hasPending()).toBe(true);
  });

  it('erro desconhecido usa o classify (padrão: offline)', async () => {
    const { queue } = setup(() => Promise.reject(new Error('rede')), {
      classify: () => ({ kind: 'sessionExpired' }),
    });
    queue.change('S', 'x');
    await queue.flush('S');
    expect(queue.getSnapshot().blocked).toEqual({ kind: 'sessionExpired' });

    const fallback = setup(() => Promise.reject(new Error('rede')));
    fallback.queue.change('S', 'x');
    await fallback.queue.flush('S');
    expect(fallback.queue.getSnapshot().status).toBe('offline');
  });

  it('dispose cancela os temporizadores e ignora alterações', async () => {
    const save = vi.fn<Save>(() => Promise.resolve());
    const { queue } = setup(save);
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    queue.change('S', 'x');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    queue.dispose();
    queue.change('S', 'y');
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
  });
});

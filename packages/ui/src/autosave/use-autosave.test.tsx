import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAutosave } from './use-autosave.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useAutosave (US-015 · ciclo de vida da fila)', () => {
  it('grava depois da montagem dupla do StrictMode (monta → desmonta → monta)', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutosave<string>({ save, debounceMs: 10 }), {
      wrapper: StrictMode,
    });

    act(() => {
      result.current.change('SECTION:JUSTIFICATION', 'texto');
    });
    expect(result.current.snapshot.status).toBe('dirty');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.slice(0, 2)).toEqual(['SECTION:JUSTIFICATION', 'texto']);
    expect(result.current.snapshot.status).toBe('saved');

    // Desmontagem real: a fila é descartada e não grava mais.
    unmount();
    act(() => {
      result.current.change('SECTION:JUSTIFICATION', 'depois');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-error';
import { useIdempotentMutation } from './use-idempotent-mutation';
import type { IdempotentContext } from './use-idempotent-mutation';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('useIdempotentMutation — correlationId da ação (US-084)', () => {
  it('reaproveita chave e correlationId nas retentativas; nova ação ganha novos', async () => {
    const seen: IdempotentContext[] = [];
    const mutationFn = vi.fn((_variables: string, context: IdempotentContext) => {
      seen.push(context);
      return seen.length === 1
        ? Promise.reject(new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' }))
        : Promise.resolve('ok');
    });
    const { result } = renderHook(
      () => useIdempotentMutation({ mutationFn, retry: { sleep: () => Promise.resolve() } }),
      { wrapper },
    );

    await act(async () => {
      await result.current.submit('a');
    });
    await act(async () => {
      await result.current.submit('b');
    });

    expect(seen).toHaveLength(3);
    const [first, retry, next] = seen;
    expect(retry).toEqual(first);
    expect(first?.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(next?.correlationId).not.toBe(first?.correlationId);
    expect(next?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });
});

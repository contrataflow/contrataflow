'use client';

import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { newIdempotencyKey, retryIdempotent } from './client';
import type { RetryOptions } from './client';

/*
 * Mutação com `Idempotency-Key` por intenção do usuário (DEC-105 · RN-FND-90): a chave nasce no
 * primeiro disparo e é reutilizada por cliques repetidos enquanto a intenção estiver em curso e
 * pelas retentativas automáticas; só depois que tudo termina uma nova intenção ganha nova chave.
 */

export interface IdempotentContext {
  readonly idempotencyKey: string;
}

export interface UseIdempotentMutationOptions<TVariables, TData> {
  readonly mutationFn: (variables: TVariables, context: IdempotentContext) => Promise<TData>;
  readonly onSuccess?: ((data: TData, variables: TVariables) => void) | undefined;
  readonly retry?: RetryOptions | undefined;
}

export function useIdempotentMutation<TVariables, TData>(
  options: UseIdempotentMutationOptions<TVariables, TData>,
) {
  const intentKey = useRef<string | null>(null);
  const inFlight = useRef(0);
  const { mutationFn, onSuccess, retry } = options;

  const mutation = useMutation({
    mutationFn: ({ variables, key }: { variables: TVariables; key: string }) =>
      retryIdempotent(() => mutationFn(variables, { idempotencyKey: key }), retry),
    onSuccess: (data, { variables }) => onSuccess?.(data, variables),
  });
  const { mutateAsync } = mutation;

  const submit = useCallback(
    async (variables: TVariables): Promise<TData> => {
      intentKey.current ??= newIdempotencyKey();
      const key = intentKey.current;
      inFlight.current += 1;
      try {
        return await mutateAsync({ variables, key });
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) intentKey.current = null;
      }
    },
    [mutateAsync],
  );

  return {
    submit,
    isPending: mutation.isPending,
    error: mutation.error,
    data: mutation.data,
    reset: mutation.reset,
  };
}

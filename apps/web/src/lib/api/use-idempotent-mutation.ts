'use client';

import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { newCorrelationId, newIdempotencyKey, retryIdempotent } from './client';
import type { RetryOptions } from './client';

/*
 * Mutação com `Idempotency-Key` por intenção do usuário (DEC-105 · RN-FND-90): a chave nasce no
 * primeiro disparo e é reutilizada por cliques repetidos enquanto a intenção estiver em curso e
 * pelas retentativas automáticas; só depois que tudo termina uma nova intenção ganha nova chave.
 * O `correlationId` da ação segue o mesmo ciclo: as retentativas aparecem na mesma busca de logs.
 */

export interface IdempotentContext {
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface UseIdempotentMutationOptions<TVariables, TData> {
  readonly mutationFn: (variables: TVariables, context: IdempotentContext) => Promise<TData>;
  readonly onSuccess?: ((data: TData, variables: TVariables) => void) | undefined;
  readonly retry?: RetryOptions | undefined;
}

export function useIdempotentMutation<TVariables, TData>(
  options: UseIdempotentMutationOptions<TVariables, TData>,
) {
  const intent = useRef<IdempotentContext | null>(null);
  const inFlight = useRef(0);
  const { mutationFn, onSuccess, retry } = options;

  const mutation = useMutation({
    mutationFn: ({ variables, context }: { variables: TVariables; context: IdempotentContext }) =>
      retryIdempotent(() => mutationFn(variables, context), retry),
    onSuccess: (data, { variables }) => onSuccess?.(data, variables),
  });
  const { mutateAsync } = mutation;

  const submit = useCallback(
    async (variables: TVariables): Promise<TData> => {
      intent.current ??= {
        idempotencyKey: newIdempotencyKey(),
        correlationId: newCorrelationId(),
      };
      const context = intent.current;
      inFlight.current += 1;
      try {
        return await mutateAsync({ variables, context });
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) intent.current = null;
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

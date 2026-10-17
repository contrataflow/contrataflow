'use client';

import type { AiGenerationDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { aiKeys, fetchAiGeneration, isGenerating } from './ai.api';

/*
 * Acompanhamento da geração por AI-02 (api/16-ai.md · screens.md SCR-117): a cada 2 s, recuando
 * 1 s por consulta até 5 s; depois de 3 min o painel para de consultar e passa a depender da
 * notificação `AI_GENERATION_READY`/`AI_GENERATION_FAILED`.
 */

export const POLL_FIRST_MS = 2_000;
export const POLL_MAX_MS = 5_000;
export const POLL_GIVE_UP_MS = 3 * 60_000;

/** Intervalo da próxima consulta, ou `false` para parar (estado final ou 3 min de espera). */
export function nextPollInterval(
  status: AiGenerationDto['status'] | undefined,
  polls: number,
  elapsedMs: number,
): number | false {
  if (status !== undefined && !isGenerating(status)) return false;
  if (elapsedMs >= POLL_GIVE_UP_MS) return false;
  return Math.min(POLL_MAX_MS, POLL_FIRST_MS + polls * 1_000);
}

export interface AiGenerationWatch {
  readonly generation: AiGenerationDto | undefined;
  readonly error: unknown;
  /** Passou de 3 min gerando: o painel avisa que a notificação chegará. */
  readonly stalled: boolean;
}

/** AI-02 com recuo; `generationId` nulo desliga a consulta. */
export function useAiGeneration(generationId: string | null): AiGenerationWatch {
  const tenantId = useTenantId();
  const startedAt = useRef<{ id: string | null; at: number; polls: number }>({
    id: null,
    at: 0,
    polls: 0,
  });
  if (startedAt.current.id !== generationId) {
    startedAt.current = { id: generationId, at: Date.now(), polls: 0 };
  }
  const query = useQuery({
    queryKey: aiKeys.generation(tenantId, generationId ?? 'none'),
    queryFn: ({ signal }) => fetchAiGeneration(generationId ?? '', signal),
    enabled: generationId !== null,
    refetchInterval: (current) => {
      const tracker = startedAt.current;
      const interval = nextPollInterval(
        current.state.data?.status,
        tracker.polls,
        Date.now() - tracker.at,
      );
      if (interval !== false) tracker.polls += 1;
      return interval;
    },
    refetchIntervalInBackground: false,
    throwOnError: false,
  });
  const generation = query.data;
  return {
    generation,
    error: query.error,
    stalled:
      generation !== undefined &&
      isGenerating(generation.status) &&
      Date.now() - startedAt.current.at >= POLL_GIVE_UP_MS,
  };
}

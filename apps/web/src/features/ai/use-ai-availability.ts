'use client';

import type { AiAvailabilityReason } from '@contrataflow/types';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { useTenantId } from '@/lib/session/session-context';

import { AI_AVAILABILITY_STALE_MS, aiKeys, fetchAiAvailability } from './ai.api';

/*
 * `useAiAvailability` (US-116 · AI-05): se o usuário pode gerar com IA no contexto e, quando não
 * pode, a explicação do primeiro motivo (`reasons[]` → mensagem). Indicativo: o botão fica
 * desabilitado com o motivo; AI-01 continua sendo a decisão final.
 */

export interface AiAvailabilityState {
  readonly loading: boolean;
  /** `true` enquanto carrega ou se a consulta falhar (a API decide no AI-01). */
  readonly canGenerate: boolean;
  readonly reasons: readonly AiAvailabilityReason[];
  /** Mensagem do primeiro motivo, ou `null`. */
  readonly message: string | null;
}

export function useAiAvailability(
  processId: string | null,
  documentId: string | null,
  enabled = true,
): AiAvailabilityState {
  const t = useTranslations('ai.availability');
  const tenantId = useTenantId();
  const query = useQuery({
    queryKey: aiKeys.availability(tenantId, processId, documentId),
    queryFn: ({ signal }) => fetchAiAvailability({ processId, documentId }, signal),
    staleTime: AI_AVAILABILITY_STALE_MS,
    enabled,
  });
  const reasons = query.data?.reasons ?? [];
  const [first] = reasons;
  return {
    loading: query.isPending && enabled,
    canGenerate: query.data?.canGenerate ?? true,
    reasons,
    message: first === undefined ? null : t(first),
  };
}

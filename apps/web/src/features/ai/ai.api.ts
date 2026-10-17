import type {
  AiGenerationDto,
  AiGenerationListItemDto,
  RequestAiGeneration,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';

/*
 * Geração com IA (US-115 · SCR-117 · api/16-ai.md AI-01..04). Chaves de screens.md SCR-117:
 * `['t', tenantId, 'ai', 'generations', generationId]` e
 * `['t', tenantId, 'processes', processId, 'ai-generations']`.
 */

export const aiKeys = {
  generation: (tenantId: string, generationId: string) =>
    tenantKey(tenantId, 'ai', 'generations', generationId),
  history: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'ai-generations'),
};

/** `QUEUED`/`RUNNING`: ainda gerando (o painel acompanha por AI-02). */
export function isGenerating(status: AiGenerationDto['status']): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

/** AI-01: `202` com a geração `QUEUED` (`Idempotency-Key` por intenção). */
export async function requestAiGeneration(
  processId: string,
  body: RequestAiGeneration,
  context: IdempotentContext,
): Promise<AiGenerationDto> {
  return (
    await apiRequest<AiGenerationDto>(`/processes/${processId}/ai-generations`, {
      method: 'POST',
      body,
      idempotencyKey: context.idempotencyKey,
      correlationId: context.correlationId,
    })
  ).data;
}

/** AI-02 (polling). */
export async function fetchAiGeneration(
  generationId: string,
  signal?: AbortSignal,
): Promise<AiGenerationDto> {
  return (await apiRequest<AiGenerationDto>(`/ai-generations/${generationId}`, { signal })).data;
}

/** AI-03 (histórico do processo, primeira página — sem `output`). */
export async function fetchAiHistory(
  processId: string,
  signal?: AbortSignal,
): Promise<readonly AiGenerationListItemDto[]> {
  return (
    await apiRequest<AiGenerationListItemDto[]>(`/processes/${processId}/ai-generations?limit=50`, {
      signal,
    })
  ).data;
}

/** AI-04: descarta a proposta (`SUCCEEDED`) ou cancela a geração (`QUEUED`/`RUNNING`). */
export async function discardAiGeneration(generationId: string): Promise<AiGenerationDto> {
  return (
    await apiRequest<AiGenerationDto>(`/ai-generations/${generationId}/discard`, {
      method: 'POST',
      body: {},
    })
  ).data;
}

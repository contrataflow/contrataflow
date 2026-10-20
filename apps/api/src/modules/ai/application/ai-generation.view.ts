import type { AiGenerationDto, AiGenerationListItemDto } from '@contrataflow/validation';

import type { AiGeneration } from '../domain/ai-generation.js';

/*
 * Representação `AiGeneration` de AI-01/02/03/04 (api/16-ai.md): sem custo (só AI-06 — US-116),
 * sem resumo nem instrução. `output` só em `SUCCEEDED`/`APPLIED` (AI-02); a lista (AI-03) nunca o
 * traz.
 */

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

export function toAiGenerationListItem(
  generation: AiGeneration,
  requesterName: string,
): AiGenerationListItemDto {
  return {
    id: generation.id,
    processId: generation.processId,
    documentId: generation.documentId,
    targetModule: generation.targetModule,
    kind: generation.kind,
    action: generation.action,
    sectionKey: generation.sectionKey,
    baseRevision: generation.baseRevision,
    status: generation.status,
    requestedBy: { id: generation.createdById, name: requesterName },
    createdAt: generation.createdAt.toISOString(),
    startedAt: iso(generation.startedAt),
    completedAt: iso(generation.completedAt),
    expiresAt: iso(generation.expiresAt),
    provider: generation.provider,
    model: generation.model,
    promptKey: generation.promptKey,
    promptVersion: generation.promptVersion,
    usage: {
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      totalTokens: generation.totalTokens,
    },
    placeholdersCount: generation.placeholdersCount,
    groundingReplacements: generation.groundingReplacements,
    inputRefs: [...generation.inputRefs],
    errorCode: generation.errorCode,
    appliedAt: iso(generation.appliedAt),
    appliedTargets:
      generation.appliedTargets === null
        ? null
        : {
            sectionKeys: [...generation.appliedTargets.sectionKeys],
            riskIds: [...generation.appliedTargets.riskIds],
          },
  };
}

export function toAiGenerationDto(
  generation: AiGeneration,
  requesterName: string,
): AiGenerationDto {
  const visible = generation.status === 'SUCCEEDED' || generation.status === 'APPLIED';
  return {
    ...toAiGenerationListItem(generation, requesterName),
    output: visible ? generation.output : null,
  };
}

import type { AiTargetModule } from '@contrataflow/types';
import { Inject, Injectable } from '@nestjs/common';

import type {
  AiAppliedTargets,
  AiSuggestion,
  AiSuggestionSource,
} from '#shared/ai/ai-suggestion-source.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { generationNotApplicable, generationNotFound, generationNotOwned } from './ai.errors.js';
import { AI_CLOCK, AI_GENERATION_REPOSITORY } from './ports.js';
import type { AiClock, AiGenerationRepository } from './ports.js';
import { canApply, markApplied } from '../domain/ai-generation.js';
import type { AiGeneration } from '../domain/ai-generation.js';

/*
 * Implementação da porta `AiSuggestionSource` (DEC-079 · RN-AI-04/13): lida pelos donos do
 * conteúdo (`document` — DOC-26; `risk` — RSK-11) NA TRANSAÇÃO DELES. Só o solicitante aplica;
 * proposta fora de `SUCCEEDED`, vencida (RN-AI-11) ou de outro documento/tipo → 409. A gravação é
 * condicional ao status lido: de duas aplicações simultâneas, uma vence e a outra recebe 409.
 */

const EXPIRED_DETAIL = 'A proposta venceu e não pode mais ser aplicada.';
const NOT_APPLICABLE_DETAIL = 'Esta geração não pode ser aplicada.';

@Injectable()
export class AiSuggestionSourceAdapter implements AiSuggestionSource {
  constructor(
    @Inject(AI_GENERATION_REPOSITORY) private readonly generations: AiGenerationRepository,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
  ) {}

  async loadForApply(
    tx: TenantTx,
    input: {
      readonly generationId: string;
      readonly targetModule: AiTargetModule;
      readonly documentId: string | null;
    },
  ): Promise<AiSuggestion> {
    const generation = await this.owned(tx, input.generationId);
    const sameTarget =
      generation.targetModule === input.targetModule &&
      (generation.documentId === null || generation.documentId === input.documentId);
    if (!sameTarget) throw generationNotApplicable(NOT_APPLICABLE_DETAIL);
    const now = this.clock();
    if (generation.expiresAt !== null && generation.expiresAt.getTime() <= now.getTime()) {
      throw generationNotApplicable(EXPIRED_DETAIL);
    }
    const { output } = generation;
    const applicable =
      (generation.status === 'SUCCEEDED' || generation.status === 'APPLIED') &&
      canApply(generation, { sectionKeys: [], riskIds: [] }, now);
    if (!applicable || output === null) throw generationNotApplicable(NOT_APPLICABLE_DETAIL);
    return {
      generationId: generation.id,
      processId: generation.processId,
      documentId: generation.documentId,
      targetModule: generation.targetModule,
      kind: generation.kind,
      action: generation.action,
      sectionKey: generation.sectionKey,
      baseRevision: generation.baseRevision,
      status: generation.status === 'APPLIED' ? 'APPLIED' : 'SUCCEEDED',
      output,
      appliedTargets: generation.appliedTargets,
      requestedById: generation.createdById,
    };
  }

  async markApplied(
    tx: TenantTx,
    input: { readonly generationId: string; readonly targets: AiAppliedTargets },
  ): Promise<void> {
    const generation = await this.owned(tx, input.generationId);
    const next = markApplied(
      generation,
      { userId: generation.createdById, targets: input.targets },
      this.clock(),
    );
    if (next === null) throw generationNotApplicable(NOT_APPLICABLE_DETAIL);
    const won = await this.generations.update(tx, next, {
      status: generation.status,
      updatedAt: generation.updatedAt,
    });
    if (!won) throw generationNotApplicable(NOT_APPLICABLE_DETAIL);
  }

  private async owned(tx: TenantTx, generationId: string): Promise<AiGeneration> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const generation = await this.generations.findById(tx, generationId);
    if (generation === null) throw generationNotFound();
    if (generation.createdById !== userId) throw generationNotOwned();
    return generation;
  }
}

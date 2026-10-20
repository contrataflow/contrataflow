import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { countGeneration } from './ai-telemetry.js';
import { generationNotApplicable, generationNotFound, generationNotOwned } from './ai.errors.js';
import { AI_CLOCK, AI_GENERATION_REPOSITORY, AI_TRANSACTIONS } from './ports.js';
import type { AiClock, AiGenerationRepository, AiTransactions } from './ports.js';
import { cancelGeneration, discardGeneration } from '../domain/ai-generation.js';
import type { AiGeneration } from '../domain/ai-generation.js';

/*
 * AI-04 — Descartar proposta ou cancelar geração (US-115 · RN-AI-13 · FA-02 · V-09): só o
 * solicitante; não depende de `AI_GENERATE` nem da IA ligada. `SUCCEEDED → DISCARDED`;
 * `QUEUED`/`RUNNING → CANCELED` (o job descarta a resposta e registra os tokens). Repetir em
 * `DISCARDED`/`CANCELED` devolve a geração sem novo efeito; `APPLIED`, `FAILED` e `EXPIRED` → 409.
 * Auditoria `ai.generation_discard`; sem evento (story "Eventos gerados").
 */

export interface DiscardAiGenerationResult {
  readonly generation: AiGeneration;
  readonly changed: boolean;
}

const UNCHANGED = new Set(['DISCARDED', 'CANCELED']);
/** Corridas com o job (ex.: concluiu entre a leitura e a gravação): relê e decide de novo. */
const MAX_RACES = 3;

@Injectable()
export class DiscardAiGenerationCommand extends TransactionalCommandHandler<
  { readonly generationId: string },
  undefined,
  DiscardAiGenerationResult
> {
  constructor(
    @Inject(AI_TRANSACTIONS) transactions: AiTransactions,
    @Inject(AI_GENERATION_REPOSITORY) private readonly generations: AiGenerationRepository,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {
    super('ai.generation_discard', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(
    tx: TenantTx,
    input: { readonly generationId: string },
  ): Promise<DiscardAiGenerationResult> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    for (let race = 0; race < MAX_RACES; race += 1) {
      const current = await this.generations.findById(tx, input.generationId);
      if (current === null) throw generationNotFound();
      if (current.createdById !== userId) throw generationNotOwned();
      if (UNCHANGED.has(current.status)) return { generation: current, changed: false };
      const now = this.clock();
      let next: AiGeneration;
      if (current.status === 'SUCCEEDED') {
        next = discardGeneration(current, userId, now);
      } else if (current.status === 'QUEUED' || current.status === 'RUNNING') {
        next = cancelGeneration(current, { byPolicy: false, userId }, now);
      } else {
        throw generationNotApplicable();
      }
      if (!(await this.generations.update(tx, next, { status: current.status }))) continue;
      await this.audit.record(tx, {
        action: 'ai.generation_discard',
        entityType: 'AiGeneration',
        entityId: current.id,
        processId: current.processId,
        metadata: {
          generationId: current.id,
          statusBefore: current.status,
          statusAfter: next.status,
        },
      });
      return { generation: next, changed: true };
    }
    throw new ApiError('CONFLICT');
  }

  protected override committed(result: DiscardAiGenerationResult): void {
    if (!result.changed) return;
    const { generation } = result;
    countGeneration(generation.targetModule, generation.kind, generation.status);
    this.logger.log(
      {
        event: 'ai.generation_discarded',
        generationId: generation.id,
        status: generation.status,
        correlationId: requireRequestContext().correlationId,
      },
      'ai.generation_discarded',
    );
  }
}

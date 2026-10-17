import { AiGenerationFailed } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { countGeneration } from './ai-telemetry.js';
import { AI_CLOCK, AI_GENERATION_REPOSITORY, AI_TRANSACTIONS } from './ports.js';
import type { AiClock, AiGenerationRepository, AiTransactions } from './ports.js';
import { failGeneration } from '../domain/ai-generation.js';

/*
 * Tarefas de manutenção da IA por tenant (queues.md §4.8 · fila `maintenance`), no tenant do job:
 *
 * - `ai-proposals-expire` (RN-AI-11): `SUCCEEDED` com `expiresAt` vencido → `EXPIRED`; o conteúdo
 *   fica para rastreabilidade, mas não pode mais ser aplicado.
 * - `ai-generations-timeout` (RN-AI-08): `RUNNING` há mais de 10 min → `FAILED`/`TIMEOUT`, com
 *   auditoria `ai.generation_fail` e `AiGenerationFailed` (notificação ao solicitante).
 *
 * Idempotentes: as gravações são condicionadas ao status lido.
 */

/** `RUNNING` por mais tempo que isto é tratado como travado (RN-AI-08). */
export const AI_RUNNING_TIMEOUT_MS = 10 * 60_000;
const BATCH = 200;

@Injectable()
export class AiMaintenanceService {
  private readonly logger = new Logger('AiMaintenance');

  constructor(
    @Inject(AI_TRANSACTIONS) private readonly transactions: AiTransactions,
    @Inject(AI_GENERATION_REPOSITORY) private readonly generations: AiGenerationRepository,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  /** `ai-proposals-expire`: devolve quantas propostas venceram. */
  async expireProposals(): Promise<number> {
    const expired = await this.transactions.run((tx) =>
      this.generations.expireDue(tx, this.clock()),
    );
    this.logger.log({ event: 'ai.proposals_expired', count: expired });
    return expired;
  }

  /** `ai-generations-timeout`: devolve quantas gerações travadas viraram `FAILED`. */
  async failStaleRunning(): Promise<number> {
    const now = this.clock();
    const failed = await this.transactions.run(async (tx) => {
      const stale = await this.generations.findStaleRunning(
        tx,
        new Date(now.getTime() - AI_RUNNING_TIMEOUT_MS),
        BATCH,
      );
      let count = 0;
      for (const generation of stale) {
        const next = failGeneration(
          generation,
          {
            errorCode: 'TIMEOUT',
            usage: { inputTokens: 0, outputTokens: 0 },
            model: null,
            costUsd: generation.costUsd,
            pricingVersion: generation.pricingVersion,
            latencyMs: generation.latencyMs,
          },
          now,
        );
        const won = await this.generations.update(tx, next, {
          status: 'RUNNING',
          attempts: generation.attempts,
        });
        if (!won) continue;
        count += 1;
        await this.audit.record(tx, {
          action: 'ai.generation_fail',
          entityType: 'AiGeneration',
          entityId: next.id,
          processId: next.processId,
          metadata: {
            generationId: next.id,
            errorCode: 'TIMEOUT',
            attempts: next.attempts,
            totalTokens: next.totalTokens,
            reason: 'RUNNING_TIMEOUT',
          },
        });
        await this.outbox.record(
          tx,
          AiGenerationFailed.of({
            aggregateId: next.id,
            processId: next.processId,
            payload: {
              generationId: next.id,
              processId: next.processId,
              documentId: next.documentId,
              targetModule: next.targetModule,
              kind: next.kind,
              requestedById: next.createdById,
              errorCode: 'TIMEOUT',
              attempts: next.attempts,
            },
          }),
        );
        countGeneration(next.targetModule, next.kind, 'FAILED');
      }
      return count;
    });
    this.logger.log({ event: 'ai.generations_timed_out', count: failed });
    return failed;
  }
}

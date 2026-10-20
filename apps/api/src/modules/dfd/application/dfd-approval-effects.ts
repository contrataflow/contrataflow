import { withSpan } from '@contrataflow/observability';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { failureCodeOf } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { isTransientDatabaseError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { DFD_REPOSITORY } from './ports.js';
import type { DfdRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  DocumentApprovalDecidedFacts,
  DocumentReopenedFacts,
  DocumentValidationSubject,
} from '../../document/application/document.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { dfdApprovalPropagation, returnDfdToReview } from '../domain/dfd.js';
import type { Dfd } from '../domain/dfd.js';

/*
 * `ApplyDfdApprovalEffectsHandler` (US-017 · RN-DFD-62..71): o efeito ESPECÍFICO do DFD na decisão
 * de `APROVACAO_DFD` (US-052), chamado pelo gancho `approvalDecided` do `DocumentValidator` no `tx`
 * da decisão e depois da mudança de etapa — qualquer falha desfaz a decisão inteira (sem consumo
 * assíncrono de evento). `APPROVED` propaga valor (DEC-032), PCA, prioridade e quantidades ao
 * processo (`ProcessFacade.applyDfdApprovalIn`); `RETURNED` volta o wizard à revisão; `REJECTED` não
 * muda o DFD (a reabertura — DOC-12 — volta à revisão). A idempotência é a do APV-03 (RN-DFD-70).
 * Logs sem valor estimado, justificativa do PCA nem motivo da decisão.
 */

let effectsCounter: Counter | undefined;

/** `dfd_decision_effects_total{outcome}` (DoD da US-017: métricas do efeito de decisão). */
function countEffects(outcome: string): void {
  effectsCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('dfd_decision_effects_total', {
      description: 'Efeitos da decisão de aprovação aplicados ao DFD (US-017).',
    });
  effectsCounter.add(1, { outcome });
}

@Injectable()
export class ApplyDfdApprovalEffectsHandler {
  private readonly logger = new Logger('Dfd');

  constructor(
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    private readonly documents: DocumentFacade,
    private readonly processes: ProcessFacade,
  ) {}

  /** RN-DFD-62: os efeitos da decisão, no `tx` da decisão. */
  async approvalDecided(
    tx: TenantTx,
    subject: DocumentValidationSubject,
    facts: DocumentApprovalDecidedFacts,
  ): Promise<void> {
    const startedAt = performance.now();
    const { document } = subject;
    try {
      await withSpan('dfd.approval_effects', { 'dfd.decision': facts.outcome }, async () => {
        // Documento do tipo sem o cabeçalho tipado (carga legada/de teste): nada a propagar.
        const dfd = await this.dfds.findById(tx, document.id);
        if (dfd === null) return;
        if (facts.outcome === 'APPROVED') {
          await this.propagate(tx, dfd, facts, startedAt);
        } else if (facts.outcome === 'RETURNED') {
          // RN-DFD-67: nada vai ao processo; o DFD volta editável já na revisão do wizard.
          await this.backToReview(tx, dfd, { actorId: facts.decidedById, now: facts.now });
        }
      });
      countEffects(facts.outcome);
    } catch (error) {
      this.logger.error(
        {
          event: 'dfd.approval_effects_failed',
          documentId: document.id,
          processId: document.processId,
          decision: facts.outcome,
          errorCode: isTransientDatabaseError(error)
            ? 'DEPENDENCY_UNAVAILABLE'
            : failureCodeOf(error),
          correlationId: requireRequestContext().correlationId,
        },
        'dfd.approval_effects_failed',
      );
      throw error;
    }
  }

  /** RN-DFD-69: reaberto (DOC-12), o wizard volta à revisão com os passos concluídos preservados. */
  async reopened(
    tx: TenantTx,
    subject: DocumentValidationSubject,
    facts: DocumentReopenedFacts,
  ): Promise<void> {
    const dfd = await this.dfds.findById(tx, subject.document.id);
    if (dfd === null) return;
    await this.backToReview(tx, dfd, { actorId: facts.actorId, now: facts.now });
  }

  /** RN-DFD-63..66 (DEC-019/029/032), com a auditoria e os eventos do `process`. */
  private async propagate(
    tx: TenantTx,
    dfd: Dfd,
    facts: DocumentApprovalDecidedFacts,
    startedAt: number,
  ): Promise<void> {
    const items = await this.documents.documentItemsIn(tx, dfd.documentId);
    const result = await this.processes.applyDfdApprovalIn(tx, {
      processId: dfd.processId,
      sourceDocumentId: dfd.documentId,
      approvalId: facts.approvalId,
      dfd: dfdApprovalPropagation(dfd),
      items: items.map((item) => ({ processItemId: item.processItemId, quantity: item.quantity })),
      at: facts.now,
      userId: facts.decidedById,
    });
    const correlationId = requireRequestContext().correlationId;
    if (result.estimatedValueSkipped) {
      this.logger.log(
        {
          event: 'dfd.approval_effects_skipped_precedence',
          documentId: dfd.documentId,
          processId: dfd.processId,
          correlationId,
        },
        'dfd.approval_effects_skipped_precedence',
      );
    }
    this.logger.log(
      {
        event: 'dfd.approval_effects_applied',
        documentId: dfd.documentId,
        processId: dfd.processId,
        decision: facts.outcome,
        changedFields: result.changedFields,
        itemsUpdated: result.itemsUpdated,
        durationMs: Math.round(performance.now() - startedAt),
        correlationId,
      },
      'dfd.approval_effects_applied',
    );
  }

  private async backToReview(
    tx: TenantTx,
    dfd: Dfd,
    stamp: { readonly actorId: string; readonly now: Date },
  ): Promise<void> {
    const next = returnDfdToReview(dfd, stamp);
    if (next !== null) await this.dfds.update(tx, next, dfd.version);
  }
}

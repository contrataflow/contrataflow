import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { recordProcessLifecycle } from './process.errors.js';
import type { ProcessCompletion } from '../domain/process-completion.js';
import type { Process } from '../domain/process.js';

/*
 * O resultado comum das duas conclusões (US-010 · RN-PROC-112/115): a auditoria `process.complete`
 * (`metadata.cause` = `MANUAL`|`APPROVAL`) no `tx` da conclusão e, depois do commit, o log
 * `info process.completed` e a métrica — chamados pelo PRC-26 (`CompleteProcessCommand`) e pela
 * decisão de aprovação que leva à etapa `END` (`ProcessApprovalSubjectHandler`). Os eventos
 * (`ProcessStageChanged` · `ProcessStatusChanged`/`ProcessCompleted`) e a timeline vêm do
 * `StageTransitionService` (ou, na etapa `END` já ativa, do próprio comando). Nunca registra o
 * comentário livre nem valores do processo (story · Logs).
 */

export interface CompletionRecord {
  /** O processo travado, antes da conclusão. */
  readonly before: Process;
  /** O processo concluído. */
  readonly after: Process;
  readonly completion: ProcessCompletion;
  readonly movementId: string;
  readonly warningsAcknowledged: readonly unknown[];
  /** `Idempotency-Key` do PRC-26 (`null` no caminho automático). */
  readonly idempotencyKey: string | null;
}

@Injectable()
export class ProcessCompletionRecorder {
  private readonly logger = new Logger('ProcessCompletion');

  constructor(@Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort) {}

  /** `process.complete` no `tx` da conclusão (DATA_CHANGE: `status`, `completedAt`). */
  async recordIn(tx: TenantTx, record: CompletionRecord): Promise<void> {
    const { before, after, completion } = record;
    await this.audit.record(tx, {
      action: 'process.complete',
      entityType: 'Process',
      entityId: after.id,
      processId: after.id,
      changes: [
        { path: 'status', old: before.status, new: after.status },
        { path: 'completedAt', old: null, new: completion.completedAt.toISOString() },
      ],
      metadata: {
        cause: completion.cause,
        processCode: after.code,
        movementId: record.movementId,
        fromStatus: before.status,
        toStatus: after.status,
        warningsAcknowledged: record.warningsAcknowledged,
        idempotencyKey: record.idempotencyKey,
      },
    });
  }

  /** `info process.completed` e `cf_process_lifecycle_total{action=COMPLETE}` — depois do commit. */
  committed(processId: string, completion: ProcessCompletion, durationMs: number): void {
    recordProcessLifecycle('COMPLETE', durationMs);
    this.logger.log(
      {
        event: 'process.completed',
        processId,
        cause: completion.cause,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'process.completed',
    );
  }
}

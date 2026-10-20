import { ApprovalCanceled } from '@contrataflow/validation';
import type { ApprovalCancelReason } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { APPROVAL_REPOSITORY } from './ports.js';
import type { ApprovalRepository } from './ports.js';

/** Aprovação cancelada e os documentos que ela cobria (para a retirada automática — DEC-018). */
export interface CanceledApproval {
  readonly approvalId: string;
  readonly documentIds: readonly string[];
}

/**
 * Cancelamento das aprovações pendentes do processo (US-009 · RN-PROC-106 · POL-06), sem comando nem
 * transação própria: roda no `tx` do cancelamento do processo e qualquer falha o desfaz inteiro.
 * Cada aprovação `PENDING` vira `CANCELED` (data, autor e motivo), com `approval.cancel` e
 * `ApprovalCanceled` (timeline `APPROVAL_CANCELED` no mesmo `tx`). Os documentos cobertos voltam a
 * `DRAFT` por quem chama (`DocumentFacade` — `document` está no mesmo nível).
 */
@Injectable()
export class ApprovalCancellationService {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  async cancelPendingForProcess(
    tx: TenantTx,
    input: {
      readonly processId: string;
      readonly reason: ApprovalCancelReason;
      readonly at: Date;
      readonly userId: string;
    },
  ): Promise<CanceledApproval[]> {
    const canceled = await this.approvals.cancelPendingByProcess(
      tx,
      input.processId,
      input.reason,
      input.at,
      input.userId,
    );
    for (const approval of canceled) {
      await this.audit.record(tx, {
        action: 'approval.cancel',
        entityType: 'Approval',
        entityId: approval.approvalId,
        processId: input.processId,
        changes: [{ path: 'status', old: 'PENDING', new: 'CANCELED' }],
        metadata: { reason: input.reason, documentIds: [...approval.documentIds] },
      });
      await this.outbox.record(
        tx,
        ApprovalCanceled.of({
          aggregateId: approval.approvalId,
          processId: input.processId,
          payload: { approvalId: approval.approvalId, reason: input.reason },
        }),
      );
    }
    return canceled;
  }
}

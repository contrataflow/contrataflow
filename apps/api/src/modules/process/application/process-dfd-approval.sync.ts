import { ProcessUpdated } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { sha256Hex } from '#shared/integrity/canonical-json.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { PROCESS_ITEM_REPOSITORY, PROCESS_REPOSITORY } from './ports.js';
import type { ProcessItemRepository, ProcessRepository } from './ports.js';
import { auditedValue } from './process-audit.js';
import { ProcessItemsChangeRecorder } from './process-items.support.js';
import { referenceQuantityUpdates, syncFromDfd } from '../domain/process-dfd-sync.js';
import type { DfdQuantityLine, DfdSyncField, DfdSyncSource } from '../domain/process-dfd-sync.js';

/** O DFD aprovado na decisão de `APROVACAO_DFD` (US-017 · RN-DFD-63..66). */
export interface DfdApprovalPropagationInput {
  readonly processId: string;
  /** Documento do DFD (`referenceQuantitySourceDocumentId`). */
  readonly sourceDocumentId: string;
  /** A aprovação decidida (`metadata.decisionApprovalId`). */
  readonly approvalId: string;
  readonly dfd: DfdSyncSource;
  readonly items: readonly DfdQuantityLine[];
  readonly at: Date;
  readonly userId: string;
}

export interface DfdApprovalPropagationResult {
  /** Campos do processo alterados (ordem de `DfdSyncField`); vazio = nada mudou no processo. */
  readonly changedFields: readonly DfdSyncField[];
  readonly itemsUpdated: number;
  /** RN-DFD-63: o valor do DFD ficou de fora pela precedência (DEC-032). */
  readonly estimatedValueSkipped: boolean;
}

const METADATA_SOURCE = 'DFD_APPROVAL';

/** Valor sigiloso na auditoria: hash + marca de mascarado (POL-09 — como na US-032). */
function auditValue(field: DfdSyncField, value: unknown, confidential: boolean): unknown {
  if (field === 'estimatedValue' && confidential && typeof value === 'string') {
    return { masked: true, sha256: sha256Hex(value) };
  }
  return auditedValue(field, value);
}

/**
 * Propagação da aprovação do DFD ao processo (US-017 · RN-DFD-62..66/71), no `tx` da decisão
 * (US-052), DEPOIS da mudança de etapa: grava os campos com `version + 1` sobre a versão que a
 * transição deixou, audita `process.update` e `process.items_update` (`metadata.source =
 * DFD_APPROVAL`) e publica `ProcessUpdated`/`ProcessItemsChanged` (timeline no mesmo `tx`). Sem
 * mudança, nada é gravado. Processo ausente no tenant = erro interno (a decisão é desfeita).
 */
@Injectable()
export class ProcessDfdApprovalSync {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly itemChanges: ProcessItemsChangeRecorder,
  ) {}

  async apply(
    tx: TenantTx,
    input: DfdApprovalPropagationInput,
  ): Promise<DfdApprovalPropagationResult> {
    if (!(await this.processes.lockForUpdate(tx, input.processId))) {
      throw new Error('Processo do DFD ausente ao propagar a aprovação.');
    }
    const rows = await this.processes.loadAggregate(tx, input.processId);
    if (rows === null) throw new Error('Processo do DFD ausente.');
    const { process } = rows;
    const synced = syncFromDfd(process, input.dfd);
    const active = await this.items.listActive(tx, input.processId);
    const updates = referenceQuantityUpdates(active, input.items, input.sourceDocumentId);

    let version = process.version;
    if (synced.changes.length > 0) {
      const next = {
        ...synced.next,
        updatedAt: input.at,
        updatedById: input.userId,
        version: process.version + 1,
      };
      if (!(await this.processes.updateProcess(tx, next, process.version))) {
        // A trava garante a versão; divergir aqui é escrita fora da trava.
        throw new Error('Versão do processo divergente ao propagar a aprovação do DFD.');
      }
      version = next.version;
      const changedFields = synced.changes.map((change) => change.field);
      await this.audit.record(tx, {
        action: 'process.update',
        entityType: 'Process',
        entityId: process.id,
        processId: process.id,
        changes: synced.changes.map((change) => ({
          path: change.field,
          old: auditValue(change.field, change.old, process.isBudgetConfidential),
          new: auditValue(change.field, change.new, process.isBudgetConfidential),
        })),
        metadata: {
          processCode: process.code,
          version,
          source: METADATA_SOURCE,
          decisionApprovalId: input.approvalId,
          sourceDocumentId: input.sourceDocumentId,
          estimatedValueSkipped: synced.estimatedValueSkipped,
        },
      });
      await this.outbox.record(
        tx,
        ProcessUpdated.of({
          aggregateId: process.id,
          processId: process.id,
          payload: { changedFields: [...changedFields], version },
        }),
      );
    }

    if (updates.length > 0) {
      await this.items.updateReferenceQuantities(tx, input.processId, {
        lines: updates.map((update) => ({ itemId: update.itemId, quantity: update.quantity })),
        sourceDocumentId: input.sourceDocumentId,
        at: input.at,
        userId: input.userId,
      });
      // Itens são do agregado (RN-PROC-81): sem mudança no processo, a versão sobe aqui.
      if (version === process.version) {
        version = await this.processes.touchProcess(tx, process.id, input.at, input.userId);
      }
      await this.itemChanges.record(tx, {
        processId: process.id,
        processCode: process.code,
        operation: 'UPDATE',
        changes: updates.flatMap((update) => [
          {
            itemId: update.itemId,
            field: 'referenceQuantity',
            old: update.oldQuantity,
            new: update.quantity,
          },
          ...(update.oldSourceDocumentId === input.sourceDocumentId
            ? []
            : [
                {
                  itemId: update.itemId,
                  field: 'referenceQuantitySourceDocumentId',
                  old: update.oldSourceDocumentId,
                  new: input.sourceDocumentId,
                },
              ]),
        ]),
        added: [],
        updated: updates.map((update) => update.itemId),
        removed: [],
        itemsCount: active.length,
        processVersion: version,
        metadata: {
          source: METADATA_SOURCE,
          sourceDocumentId: input.sourceDocumentId,
          decisionApprovalId: input.approvalId,
        },
      });
    }
    return {
      changedFields: synced.changes.map((change) => change.field),
      itemsUpdated: updates.length,
      estimatedValueSkipped: synced.estimatedValueSkipped,
    };
  }
}

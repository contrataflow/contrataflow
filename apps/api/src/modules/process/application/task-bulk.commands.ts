import { TASK_BULK_MESSAGES } from '@contrataflow/validation';
import type { BulkAssign, BulkClaim } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AssignProcessCommand } from './assign-process.command.js';
import { ClaimProcessCommand } from './claim-process.command.js';
import { PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessTransactions } from './ports.js';
import {
  bulkProcessRefOf,
  reportBulk,
  reportBulkFailed,
  runBulkItems,
  toBulkOutcome,
} from './task-bulk.support.js';
import type { BulkOutcome } from './task-bulk.support.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';

export interface BulkClaimInput {
  readonly body: BulkClaim;
  readonly idempotencyKey: string | null;
}

export interface BulkAssignInput {
  readonly body: BulkAssign;
  readonly idempotencyKey: string | null;
}

/**
 * `BulkClaimProcessesCommand` — TSK-03 (US-058 · RN-INBOX-20): "Assumir selecionados". A permissão
 * base (`PROCESS_CLAIM` em algum escopo) é do guard da rota; cada item é o PRC-21 inteiro
 * (`ClaimProcessCommand`, POL-04 por item, na sua transação), sem `If-Match` por item — a trava do
 * processo decide a corrida entre dois lotes (o perdedor recebe `PROCESS_ALREADY_ASSIGNED`).
 */
@Injectable()
export class BulkClaimProcessesCommand {
  private readonly logger = new Logger('tasks.bulk_claim');

  constructor(private readonly claims: ClaimProcessCommand) {}

  async execute({ body, idempotencyKey }: BulkClaimInput): Promise<BulkOutcome> {
    const startedAt = performance.now();
    const batch = { batchId: newId(), idempotencyKey };
    try {
      const results = await runBulkItems(body.processIds, async (processId) => {
        const claimed = await this.claims.execute({ processId, expectedVersion: null, batch });
        return bulkProcessRefOf(claimed.dto);
      });
      const outcome = toBulkOutcome(results);
      reportBulk(
        this.logger,
        'claim',
        batch.batchId,
        outcome,
        Math.round(performance.now() - startedAt),
      );
      return outcome;
    } catch (error) {
      reportBulkFailed(this.logger, 'claim', error, body.processIds.length);
      throw error;
    }
  }
}

/**
 * `BulkAssignProcessesCommand` — TSK-04 (US-058 · RN-INBOX-21): "Atribuir selecionados" ao MESMO
 * responsável, com o motivo do lote. Permissão base antes de qualquer item: `PROCESS_ASSIGN` em
 * algum escopo OU titular/substituto de alguma unidade — sem nenhum dos dois, 403
 * `PERMISSION_DENIED` do lote inteiro, auditado como `access.denied` (`reasonCode = PROCESS_ASSIGN`).
 * Depois, cada item é o PRC-22 inteiro (`AssignProcessCommand`, POL-05 por item, na sua transação):
 * escopo de unidade ou chefia de outra unidade não bastam para um item e ele sai com o erro do
 * PRC-22, sem 403 global.
 */
@Injectable()
export class BulkAssignProcessesCommand {
  private readonly logger = new Logger('tasks.bulk_assign');

  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    private readonly assignments: AssignProcessCommand,
    private readonly access: AccessFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  async execute({ body, idempotencyKey }: BulkAssignInput): Promise<BulkOutcome> {
    const startedAt = performance.now();
    const batch = { batchId: newId(), idempotencyKey };
    try {
      await this.assertBasePermission();
      const results = await runBulkItems(body.processIds, async (processId) => {
        const assigned = await this.assignments.execute({
          processId,
          body: { assigneeId: body.assigneeId, reason: body.reason },
          expectedVersion: null,
          batch,
        });
        return bulkProcessRefOf(assigned.dto);
      });
      const outcome = toBulkOutcome(results);
      reportBulk(
        this.logger,
        'assign',
        batch.batchId,
        outcome,
        Math.round(performance.now() - startedAt),
      );
      return outcome;
    } catch (error) {
      reportBulkFailed(this.logger, 'assign', error, body.processIds.length);
      throw error;
    }
  }

  /** POL-05 agregada só como porta de entrada: a decisão continua sendo por item. */
  private async assertBasePermission(): Promise<void> {
    if (this.access.can('PROCESS_ASSIGN')) return;
    const userId = requireRequestContext().actor.userId ?? '';
    const leadership = await this.transactions.read((tx) =>
      this.organization.departmentLeadership(tx, userId),
    );
    if (leadership.headOf.length > 0 || leadership.deputyOf.length > 0) return;
    throw new ApiError('PERMISSION_DENIED', {
      detail: TASK_BULK_MESSAGES.permissionDenied,
      auditReasonCode: 'PROCESS_ASSIGN',
    });
  }
}

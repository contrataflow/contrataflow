import { WorkflowDefaultChanged } from '@contrataflow/validation';
import type { WorkflowDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { WORKFLOW_CLOCK, WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './ports.js';
import type { WorkflowClock, WorkflowRepository, WorkflowTransactions } from './ports.js';
import {
  defaultVersionConflict,
  workflowNotEligibleForDefault,
  workflowNotFound,
} from './workflow.errors.js';
import { toWorkflowDto } from './workflow.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  defaultIneligibility,
  markAsDefault,
  unmarkAsDefault,
} from '../domain/workflow-definition.js';

/**
 * `SetDefaultWorkflowCommand` — WF-05 (US-042 · fluxo principal, passos 6–8 · RN-WF-40..42): numa
 * transação curta, autoriza `WORKFLOW_PUBLISH` (+ MFA — POL-14), trava TODOS os workflows do tenant
 * (serializa trocas concorrentes), confere o `If-Match` com a `version` do alvo (412), exige alvo
 * ativo e publicado (422) e troca o padrão — o anterior perde `isDefault`, o alvo ganha, e a
 * `version` de todos sobe (a outra troca feita sobre a mesma leitura recebe 412). Grava
 * `workflow.set_default` e `WorkflowDefaultChanged`. Alvo que já é o padrão: 200 sem efeito.
 */
@Injectable()
export class SetDefaultWorkflowCommand {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: { id: string; expectedVersion: number }): Promise<WorkflowDto> {
    this.access.assertCan('WORKFLOW_PUBLISH', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const userId = context.actor.userId;

    const outcome = await this.transactions.run(async (tx) => {
      const all = await this.workflows.lockAllWorkflows(tx);
      const target = all.find((workflow) => workflow.id === input.id);
      if (!target) throw workflowNotFound();
      if (target.version !== input.expectedVersion) throw defaultVersionConflict(target.version);
      const reason = defaultIneligibility(target);
      if (reason !== null) throw workflowNotEligibleForDefault(reason);
      const previous = all.find((workflow) => workflow.isDefault) ?? null;

      let result = target;
      if (previous?.id !== target.id) {
        const change = { now, userId };
        result = { ...markAsDefault(target, change), version: target.version + 1 };
        const unmarked = previous ? unmarkAsDefault(previous, change) : null;
        await this.workflows.switchDefault(tx, { workflowId: target.id, now, userId });
        await this.audit.record(tx, {
          action: 'workflow.set_default',
          entityType: 'Workflow',
          entityId: target.id,
          changes: [
            ...(previous && unmarked
              ? [{ path: 'previousWorkflow.isDefault', old: true, new: unmarked.isDefault }]
              : []),
            { path: 'isDefault', old: false, new: result.isDefault },
          ],
          metadata: { previousWorkflowId: previous?.id ?? null, key: target.key },
        });
        await this.outbox.record(
          tx,
          WorkflowDefaultChanged.of({
            aggregateId: target.id,
            payload: { workflowId: target.id },
          }),
        );
      }
      const published = result.currentPublishedVersionId
        ? await this.workflows.findVersion(tx, result.currentPublishedVersionId)
        : null;
      const draft = await this.workflows.findDraft(tx, result.id);
      return {
        dto: toWorkflowDto(result, published, draft),
        changed: previous?.id !== target.id,
        previousWorkflowId: previous?.id ?? null,
      };
    });

    if (outcome.changed) {
      this.logger.log(
        {
          event: 'workflow.default_changed',
          previousWorkflowId: outcome.previousWorkflowId,
          newWorkflowId: input.id,
          tenantId: context.tenantId,
          userId,
          correlationId: context.correlationId,
        },
        'workflow.default_changed',
      );
    }
    return outcome.dto;
  }
}

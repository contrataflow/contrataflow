import { WorkflowVersionPublished, WorkflowVersionRetired } from '@contrataflow/validation';
import type { WorkflowValidationIssue } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { WORKFLOW_CLOCK, WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './ports.js';
import type { WorkflowClock, WorkflowRepository, WorkflowTransactions } from './ports.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import { recordPublication } from './workflow-telemetry.js';
import {
  workflowInvalid,
  workflowNotFound,
  workflowVersionNotDraft,
  workflowVersionNotFound,
} from './workflow.errors.js';
import type { WorkflowVersion } from '../domain/workflow-definition.js';
import { buildWorkflowSnapshot, workflowSnapshotHash } from '../domain/workflow-snapshot.js';

export interface PublishWorkflowVersionInput {
  readonly versionId: string;
  /** Notas da mudança (US-045 exige a partir da v2; o seeder publica a v1 sem notas). */
  readonly changeNotes?: string | null;
}

export interface PublishWorkflowVersionResult {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly versionNumber: number;
  readonly definitionHash: string;
  /** Versão publicada anterior, agora `RETIRED` (supersedida). */
  readonly retiredVersionId: string | null;
  readonly warnings: readonly WorkflowValidationIssue[];
}

/**
 * `WorkflowVersionPublisher` (US-040 · RN-WF-20 · fluxo principal, passo 8): serviço interno de
 * publicação, exportado pela fachada para o seeder (US-042) e o WF-21 (US-045) — quem chama faz a
 * autorização. Numa transação, com a versão e o workflow travados (`FOR UPDATE`): revalida (erros →
 * 422 `WORKFLOW_INVALID`), monta o snapshot canônico e o `definitionHash`, publica, aponta
 * `currentPublishedVersionId`, aposenta a publicada anterior e grava auditoria e eventos. Tudo ou
 * nada.
 */
@Injectable()
export class WorkflowVersionPublisher {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly definitions: WorkflowDefinitionService,
  ) {}

  /** Publica numa transação própria. */
  publish(input: PublishWorkflowVersionInput): Promise<PublishWorkflowVersionResult> {
    return this.transactions.run((tx) => this.publishIn(tx, input));
  }

  /** Publica no `tx` do chamador (ex.: checklist de provisionamento — US-042). */
  async publishIn(
    tx: TenantTx,
    input: PublishWorkflowVersionInput,
  ): Promise<PublishWorkflowVersionResult> {
    const startedAt = performance.now();
    const context = requireRequestContext();
    const userId = context.actor.userId;
    const now = this.clock();

    const version = await this.workflows.lockVersion(tx, input.versionId);
    if (!version) throw workflowVersionNotFound();
    const workflow = await this.workflows.lockWorkflow(tx, version.workflowId);
    if (!workflow) throw workflowNotFound();
    if (version.status !== 'DRAFT') throw workflowVersionNotDraft(version.id);

    const { definition, result } = await this.definitions.validateIn(tx, version);
    if (!result.valid) {
      recordPublication('invalid');
      throw workflowInvalid(result);
    }
    const snapshot = buildWorkflowSnapshot(definition);
    const definitionHash = workflowSnapshotHash(snapshot);
    // O validador garante exatamente uma `START` (RN-WF-07).
    const initialStageId = snapshot.initialStageId ?? '';

    let previous: WorkflowVersion | null = null;
    if (workflow.currentPublishedVersionId) {
      previous = await this.workflows.lockVersion(tx, workflow.currentPublishedVersionId);
    }
    await this.workflows.publishVersion(tx, {
      id: version.id,
      initialStageId,
      changeNotes: input.changeNotes ?? version.changeNotes,
      snapshot,
      hash: definitionHash,
      publishedAt: now,
      publishedById: userId,
    });
    if (previous?.status === 'PUBLISHED') {
      await this.workflows.retireVersion(tx, previous.id, { now, userId });
    }
    await this.workflows.setCurrentPublished(tx, workflow.id, version.id, { now, userId });

    await this.audit.record(tx, {
      action: 'workflow.version_publish',
      entityType: 'WorkflowVersion',
      entityId: version.id,
      metadata: {
        workflowId: workflow.id,
        definitionHash,
        versionNumber: version.versionNumber,
        warningsCount: result.warnings.length,
      },
    });
    await this.outbox.record(
      tx,
      WorkflowVersionPublished.of({
        aggregateId: workflow.id,
        payload: {
          workflowId: workflow.id,
          workflowVersionId: version.id,
          versionNumber: version.versionNumber,
          definitionHash,
        },
      }),
    );
    if (previous?.status === 'PUBLISHED') {
      await this.audit.record(tx, {
        action: 'workflow.version_retire',
        entityType: 'WorkflowVersion',
        entityId: previous.id,
        metadata: {
          workflowId: workflow.id,
          definitionHash: previous.definitionHash,
          versionNumber: previous.versionNumber,
          reason: 'SUPERSEDED',
          supersededById: version.id,
        },
      });
      await this.outbox.record(
        tx,
        WorkflowVersionRetired.of({
          aggregateId: workflow.id,
          payload: { workflowId: workflow.id, workflowVersionId: previous.id },
        }),
      );
    }

    recordPublication('published');
    this.logger.log(
      {
        event: 'workflow.version_published',
        workflowVersionId: version.id,
        definitionHash,
        stagesCount: definition.stages.length,
        transitionsCount: definition.transitions.length,
        rulesCount: definition.rules.length,
        durationMs: Math.round(performance.now() - startedAt),
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      'workflow.version_published',
    );
    return {
      workflowId: workflow.id,
      workflowVersionId: version.id,
      versionNumber: version.versionNumber,
      definitionHash,
      retiredVersionId: previous?.status === 'PUBLISHED' ? previous.id : null,
      warnings: result.warnings,
    };
  }
}

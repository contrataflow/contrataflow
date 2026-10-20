import { WorkflowVersionRetired, workflowPublishIssues } from '@contrataflow/validation';
import type {
  WorkflowPublish,
  WorkflowValidationResult,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { WORKFLOW_CLOCK, WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './ports.js';
import type { WorkflowClock, WorkflowRepository, WorkflowTransactions } from './ports.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import { recordRetirement } from './workflow-telemetry.js';
import { WorkflowVersionPublisher } from './workflow-version.publisher.js';
import {
  workflowInUse,
  workflowNotFound,
  workflowVersionConflict,
  workflowVersionInvalidState,
  workflowVersionNotFound,
} from './workflow.errors.js';
import { toVersionSummaryDto } from './workflow.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { decideRetirement } from '../domain/workflow-version-lifecycle.js';

/*
 * Validar, publicar e aposentar versão de workflow (US-045 · WF-20/21/22). A validação é a MESMA
 * do `WorkflowDefinitionService.validateIn` nas duas pontas: o WF-20 lê, o WF-21 revalida dentro
 * da transação da publicação (`WorkflowVersionPublisher`) — "Publicar" nunca aceita o que
 * "Validar" não sinalizou. Processos já criados seguem na versão fixada (RN-WF-67 · DEC-014).
 */

function errorCodeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
}

/**
 * `ValidateWorkflowVersionQuery` — WF-20 (RN-WF-61): `WORKFLOW_VIEW`; `errors[]` (bloqueiam a
 * publicação) e `warnings[]` (`WF_*`, api.md §2.3) com `stageKey`/`transitionKey`/`ruleId`. Nada é
 * gravado. Versão já publicada/aposentada também é validada (é a mesma regra, sobre as tabelas).
 */
@Injectable()
export class ValidateWorkflowVersionQuery {
  constructor(
    private readonly definitions: WorkflowDefinitionService,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(versionId: string): Promise<WorkflowValidationResult> {
    this.access.assertCan('WORKFLOW_VIEW', { mfaPolicy: await this.identity.mfaPolicy() });
    return this.definitions.validate(versionId);
  }
}

export interface PublishWorkflowVersionCommandInput {
  readonly versionId: string;
  readonly body: WorkflowPublish;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `PublishWorkflowVersionCommand` — WF-21 (US-045 · RN-WF-61..64): `WORKFLOW_PUBLISH` (+ MFA —
 * POL-14). Numa transação, com a versão travada: `If-Match` (412 — a segunda publicação simultânea
 * cai aqui, pois a primeira subiu a `version`), status `DRAFT` (409 `INVALID_STATE`), notas a
 * partir da v2 (422 `VALIDATION_ERROR`) e então o `WorkflowVersionPublisher` — revalidação (422
 * `WORKFLOW_INVALID`), snapshot JCS + SHA-256, `currentPublishedVersionId`, supersessão da anterior,
 * `workflow.version_publish` e `WorkflowVersionPublished` no outbox. Tudo ou nada.
 */
@Injectable()
export class PublishWorkflowVersionCommand {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly publisher: WorkflowVersionPublisher,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: PublishWorkflowVersionCommandInput): Promise<WorkflowVersionSummaryDto> {
    this.access.assertCan('WORKFLOW_PUBLISH', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    try {
      return await this.transactions.run(async (tx) => {
        const version = await this.workflows.lockVersion(tx, input.versionId);
        if (!version) throw workflowVersionNotFound();
        if (version.version !== input.expectedVersion) {
          throw workflowVersionConflict(version.version);
        }
        if (version.status !== 'DRAFT') throw workflowVersionInvalidState('publish', version);
        const issues = workflowPublishIssues(version.versionNumber, input.body.changeNotes);
        if (issues.length > 0) throw validationError(issues);

        const changeNotes = input.body.changeNotes?.trim() ?? '';
        await this.publisher.publishIn(tx, {
          versionId: version.id,
          changeNotes: changeNotes === '' ? null : changeNotes,
        });
        const published = await this.workflows.findVersion(tx, version.id);
        if (!published) throw workflowVersionNotFound();
        return toVersionSummaryDto(published);
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WORKFLOW_INVALID') {
        const validation = error.extensions.validation as { errors?: unknown[] } | undefined;
        this.logger.warn(
          {
            event: 'workflow.publish_blocked',
            workflowVersionId: input.versionId,
            errorsCount: validation?.errors?.length ?? 0,
            tenantId: context.tenantId,
            correlationId: context.correlationId,
          },
          'workflow.publish_blocked',
        );
      } else if (!(error instanceof ApiError) || error.status >= 500) {
        this.logger.error(
          {
            event: 'workflow.publish_failed',
            workflowVersionId: input.versionId,
            errorCode: errorCodeOf(error),
            cause: error instanceof Error ? error.name : 'unknown',
            tenantId: context.tenantId,
            correlationId: context.correlationId,
          },
          'workflow.publish_failed',
        );
      }
      throw error;
    }
  }
}

export interface RetireWorkflowVersionCommandInput {
  readonly versionId: string;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `RetireWorkflowVersionCommand` — WF-22 (US-045 · RN-WF-66): `WORKFLOW_PUBLISH` (+ MFA). Numa
 * transação, com a versão e o workflow travados (mesma ordem do publicador): `If-Match` (412),
 * status `PUBLISHED` (409 `INVALID_STATE`) e a decisão de `decideRetirement` — corrente sem
 * sucessora num workflow em uso → 409 `WORKFLOW_IN_USE`. Grava `RETIRED` (`retiredAt`/
 * `retiredById`), ajusta `currentPublishedVersionId` quando era a corrente, `workflow.version_retire`
 * e `WorkflowVersionRetired`. Processos que fixaram a versão continuam nela (RN-WF-67).
 */
@Injectable()
export class RetireWorkflowVersionCommand {
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

  async execute(input: RetireWorkflowVersionCommandInput): Promise<WorkflowVersionSummaryDto> {
    this.access.assertCan('WORKFLOW_PUBLISH', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const userId = context.actor.userId;

    const outcome = await this.transactions.run(async (tx) => {
      const version = await this.workflows.lockVersion(tx, input.versionId);
      if (!version) throw workflowVersionNotFound();
      const workflow = await this.workflows.lockWorkflow(tx, version.workflowId);
      if (!workflow) throw workflowNotFound();
      if (version.version !== input.expectedVersion) {
        throw workflowVersionConflict(version.version);
      }
      const decision = decideRetirement(
        workflow,
        version,
        await this.workflows.listPublishedVersions(tx, workflow.id),
      );
      if (decision.kind === 'INVALID_STATE') throw workflowVersionInvalidState('retire', version);
      if (decision.kind === 'IN_USE') throw workflowInUse(version.id);

      await this.workflows.retireVersion(tx, version.id, { now, userId });
      if (decision.nextCurrentVersionId !== undefined) {
        await this.workflows.setCurrentPublished(tx, workflow.id, decision.nextCurrentVersionId, {
          now,
          userId,
        });
      }
      await this.audit.record(tx, {
        action: 'workflow.version_retire',
        entityType: 'WorkflowVersion',
        entityId: version.id,
        changes:
          decision.nextCurrentVersionId === undefined
            ? []
            : [
                {
                  path: 'workflow.currentPublishedVersionId',
                  old: workflow.currentPublishedVersionId,
                  new: decision.nextCurrentVersionId,
                },
              ],
        metadata: {
          workflowId: workflow.id,
          versionNumber: version.versionNumber,
          definitionHash: version.definitionHash,
          reason: 'MANUAL',
        },
      });
      await this.outbox.record(
        tx,
        WorkflowVersionRetired.of({
          aggregateId: workflow.id,
          payload: { workflowId: workflow.id, workflowVersionId: version.id },
        }),
      );
      const retired = await this.workflows.findVersion(tx, version.id);
      if (!retired) throw workflowVersionNotFound();
      return { workflowId: workflow.id, version: retired };
    });

    recordRetirement();
    this.logger.log(
      {
        event: 'workflow.version_retired',
        workflowId: outcome.workflowId,
        workflowVersionId: outcome.version.id,
        versionNumber: outcome.version.versionNumber,
        tenantId: context.tenantId,
        userId,
        correlationId: context.correlationId,
      },
      'workflow.version_retired',
    );
    return toVersionSummaryDto(outcome.version);
  }
}

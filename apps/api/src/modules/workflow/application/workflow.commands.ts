import { WorkflowCreated } from '@contrataflow/validation';
import type {
  WorkflowCreate,
  WorkflowDto,
  WorkflowUpdate,
  WorkflowVersionCreate,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  WORKFLOW_CLOCK,
  WORKFLOW_REPOSITORY,
  WORKFLOW_TRANSACTIONS,
  WorkflowDraftExistsError,
  WorkflowKeyTakenError,
} from './ports.js';
import type { WorkflowClock, WorkflowRepository, WorkflowTransactions } from './ports.js';
import { changedFields, WorkflowDraftEditor } from './workflow-draft-editor.js';
import {
  workflowDraftExists,
  workflowKeyTaken,
  workflowNothingToCopy,
  workflowNotFound,
  workflowVersionConflict,
} from './workflow.errors.js';
import { toVersionDetailDto, toWorkflowDto } from './workflow.view.js';
import { cloneDefinition } from '../domain/workflow-clone.js';
import type { ClonedDefinition } from '../domain/workflow-clone.js';
import { EMPTY_DEFINITION } from '../domain/workflow-definition.js';
import type { Workflow, WorkflowVersion } from '../domain/workflow-definition.js';

const COPYABLE = new Set(['PUBLISHED', 'RETIRED']);

/** Nova versão `DRAFT` (sem snapshot) com o conteúdo clonado (RN-WF-03/22). */
async function insertDraft(
  workflows: WorkflowRepository,
  tx: TenantTx,
  input: {
    readonly workflow: Workflow;
    readonly versionNumber: number;
    readonly source: WorkflowVersion | null;
    readonly now: Date;
    readonly userId: string | null;
  },
): Promise<{ version: WorkflowVersion; definition: ClonedDefinition }> {
  const id = newId();
  const definition = cloneDefinition(
    input.source ? await workflows.loadDefinition(tx, input.source.id) : EMPTY_DEFINITION,
    { workflowVersionId: id, now: input.now, userId: input.userId, newId },
  );
  const version: WorkflowVersion = {
    id,
    tenantId: input.workflow.tenantId,
    workflowId: input.workflow.id,
    versionNumber: input.versionNumber,
    status: 'DRAFT',
    initialStageId: definition.initialStageId,
    changeNotes: null,
    publishedAt: null,
    publishedById: null,
    retiredAt: null,
    retiredById: null,
    definitionSnapshot: null,
    definitionHash: null,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.userId,
    updatedById: input.userId,
    version: 1,
  };
  await workflows.insertVersion(tx, version);
  await workflows.insertDefinition(tx, definition);
  return { version, definition };
}

/**
 * `CreateWorkflowCommand` — WF-02 (US-040 · fluxo principal, passos 1–2 · FA-01): numa transação,
 * cria o workflow (`isActive`, não padrão, prioridade 100) e a versão nº 1 em `DRAFT` — vazia ou
 * cópia integral (ids novos) de `copyFromVersionId` (`PUBLISHED`/`RETIRED` do tenant; rascunho ou
 * outro tenant → 422 `REFERENCE_NOT_FOUND`) —, grava `workflow.create` e `WorkflowCreated`.
 */
@Injectable()
export class CreateWorkflowCommand {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  async execute(input: {
    body: WorkflowCreate;
    idempotencyKey: string | null;
  }): Promise<WorkflowDto> {
    await this.editor.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    const userId = context.actor.userId;
    const { body } = input;

    const created = await this.transactions.run(async (tx) => {
      if (await this.workflows.findWorkflowByKey(tx, body.key)) throw workflowKeyTaken(body.key);
      let source: WorkflowVersion | null = null;
      if (body.copyFromVersionId) {
        source = await this.workflows.findVersion(tx, body.copyFromVersionId);
        if (!source || !COPYABLE.has(source.status)) {
          throw validationError([
            {
              field: 'copyFromVersionId',
              code: 'REFERENCE_NOT_FOUND',
              message: 'Selecione uma versão publicada de um workflow deste órgão.',
            },
          ]);
        }
      }
      const workflow: Workflow = {
        id: newId(),
        tenantId: context.tenantId ?? '',
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        isActive: true,
        isDefault: false,
        applicabilityRule: null,
        applicabilityPriority: 100,
        currentPublishedVersionId: null,
        createdAt: now,
        updatedAt: now,
        createdById: userId,
        updatedById: userId,
        version: 1,
      };
      try {
        await this.workflows.insertWorkflow(tx, workflow);
      } catch (error) {
        if (error instanceof WorkflowKeyTakenError) throw workflowKeyTaken(body.key);
        throw error;
      }
      const { version } = await insertDraft(this.workflows, tx, {
        workflow,
        versionNumber: 1,
        source,
        now,
        userId,
      });
      await this.audit.record(tx, {
        action: 'workflow.create',
        entityType: 'Workflow',
        entityId: workflow.id,
        changes: changedFields(null, workflow, ['key', 'name']),
        metadata: {
          copyFromVersionId: source?.id ?? null,
          draftVersionId: version.id,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await this.outbox.record(
        tx,
        WorkflowCreated.of({
          aggregateId: workflow.id,
          payload: { workflowId: workflow.id, key: workflow.key },
        }),
      );
      return { workflow, version, sourceVersionId: source?.id ?? null };
    });

    this.logger.log(
      {
        event: 'workflow.created',
        workflowId: created.workflow.id,
        versionNumber: 1,
        sourceVersionId: created.sourceVersionId,
        tenantId: created.workflow.tenantId,
        userId,
        correlationId: context.correlationId,
      },
      'workflow.created',
    );
    return toWorkflowDto(created.workflow, null, created.version);
  }
}

/**
 * `UpdateWorkflowCommand` — WF-04: nome e descrição (a `key` é imutável — RN-WF-02); aplicabilidade
 * e ativação chegam com a US-042/US-045. Nada alterado → 200 sem nova versão nem auditoria.
 */
@Injectable()
export class UpdateWorkflowCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  async execute(input: {
    id: string;
    patch: WorkflowUpdate;
    expectedVersion: number;
  }): Promise<WorkflowDto> {
    await this.editor.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    return this.transactions.run(async (tx) => {
      const current = await this.workflows.findWorkflow(tx, input.id);
      if (!current) throw workflowNotFound();
      if (current.version !== input.expectedVersion) {
        throw workflowVersionConflict(current.version);
      }
      const merged: Workflow = {
        ...current,
        ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
        ...(input.patch.description === undefined ? {} : { description: input.patch.description }),
      };
      const changes = changedFields(current, merged, ['name', 'description']);
      let result = current;
      if (changes.length > 0) {
        result = {
          ...merged,
          updatedAt: now,
          updatedById: context.actor.userId,
          version: current.version + 1,
        };
        await this.workflows.updateWorkflow(tx, result, input.expectedVersion);
        await this.audit.record(tx, {
          action: 'workflow.update',
          entityType: 'Workflow',
          entityId: current.id,
          changes,
          metadata: { workflowId: current.id, operation: 'UPDATE' },
        });
      }
      const published = current.currentPublishedVersionId
        ? await this.workflows.findVersion(tx, current.currentPublishedVersionId)
        : null;
      return toWorkflowDto(result, published, await this.workflows.findDraft(tx, current.id));
    });
  }
}

/**
 * `CreateWorkflowVersionCommand` — WF-08 (US-040 · fluxo principal, passo 9 · FA-02 · RN-WF-22 ·
 * US-043 "Criar rascunho"): com o workflow travado, recusa um segundo rascunho (409
 * `WORKFLOW_DRAFT_EXISTS` com `meta.draftVersionId`, `warn workflow.draft_conflict`) e clona a
 * versão de origem (padrão: a publicada corrente; sem publicada nem origem informada → 422
 * `BUSINESS_RULE_VIOLATION` — RN-WF-47) em `DRAFT` nº máx + 1, com ids novos. Processos em
 * andamento não são afetados.
 */
@Injectable()
export class CreateWorkflowVersionCommand {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  async execute(input: {
    workflowId: string;
    body: WorkflowVersionCreate;
  }): Promise<WorkflowVersionDetailDto> {
    await this.editor.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    const userId = context.actor.userId;

    const created = await this.transactions.run(async (tx) => {
      const workflow = await this.workflows.lockWorkflow(tx, input.workflowId);
      if (!workflow) throw workflowNotFound();
      const draft = await this.workflows.findDraft(tx, workflow.id);
      if (draft) {
        this.logger.warn(
          {
            event: 'workflow.draft_conflict',
            workflowId: workflow.id,
            draftVersionId: draft.id,
            tenantId: context.tenantId,
            userId,
            correlationId: context.correlationId,
          },
          'workflow.draft_conflict',
        );
        throw workflowDraftExists(draft.id);
      }
      const last = await this.workflows.lastVersion(tx, workflow.id);
      let source: WorkflowVersion | null;
      if (input.body.sourceVersionId) {
        source = await this.workflows.findVersion(tx, input.body.sourceVersionId);
        if (source?.workflowId !== workflow.id) {
          throw validationError([
            {
              field: 'sourceVersionId',
              code: 'REFERENCE_NOT_FOUND',
              message: 'Selecione uma versão deste workflow.',
            },
          ]);
        }
      } else {
        // RN-WF-47: sem origem informada, só a publicada corrente serve de base.
        if (!workflow.currentPublishedVersionId) throw workflowNothingToCopy();
        source = await this.workflows.findVersion(tx, workflow.currentPublishedVersionId);
      }
      let inserted;
      try {
        inserted = await insertDraft(this.workflows, tx, {
          workflow,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          source,
          now,
          userId,
        });
      } catch (error) {
        if (error instanceof WorkflowDraftExistsError) {
          const winner = await this.workflows.findDraft(tx, workflow.id);
          throw workflowDraftExists(winner?.id ?? '');
        }
        throw error;
      }
      await this.audit.record(tx, {
        action: 'workflow.version_create',
        entityType: 'WorkflowVersion',
        entityId: inserted.version.id,
        metadata: {
          workflowId: workflow.id,
          versionNumber: inserted.version.versionNumber,
          sourceVersionId: source?.id ?? null,
          newVersionId: inserted.version.id,
        },
      });
      return { ...inserted, sourceVersionId: source?.id ?? null };
    });

    this.logger.log(
      {
        event: 'workflow.version_created',
        workflowId: input.workflowId,
        versionNumber: created.version.versionNumber,
        sourceVersionId: created.sourceVersionId,
        tenantId: context.tenantId,
        userId,
        correlationId: context.correlationId,
      },
      'workflow.version_created',
    );
    return toVersionDetailDto(created.version, created.definition);
  }
}

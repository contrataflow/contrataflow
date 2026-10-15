import { WORKFLOW_LIMITS, workflowTransitionIssues } from '@contrataflow/validation';
import type {
  FieldError,
  WorkflowTransitionCreate,
  WorkflowTransitionDto,
  WorkflowTransitionFields,
  WorkflowTransitionUpdate,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { WORKFLOW_REPOSITORY } from './ports.js';
import type { WorkflowRepository } from './ports.js';
import { changedFields, WorkflowDraftEditor } from './workflow-draft-editor.js';
import type { DraftContext } from './workflow-draft-editor.js';
import { definedEntries, limitExceeded } from './workflow-stage.commands.js';
import {
  workflowItemNotFound,
  workflowKeyTaken,
  workflowVersionConflict,
} from './workflow.errors.js';
import { toTransitionDto } from './workflow.view.js';
import {
  actionAllowedFrom,
  actionAllowedTo,
  forcedRequiresComment,
  stageTypeLabel,
} from '../domain/workflow-definition.js';
import type { WorkflowDefinition, WorkflowTransition } from '../domain/workflow-definition.js';

export const TRANSITION_FIELDS = [
  'key',
  'name',
  'description',
  'fromStageId',
  'toStageId',
  'action',
  'displayOrder',
  'isPrimary',
  'requiresComment',
  'allowDueDateOverride',
] as const satisfies readonly (keyof WorkflowTransitionFields)[];

/**
 * Validações locais da transição (RN-WF-09/10 · V-05/V-06): origem e destino existem NA VERSÃO
 * (etapa de outra versão ou de outro tenant = `REFERENCE_NOT_FOUND`), a ação é compatível com os
 * tipos e a aresta `(origem, destino, ação)` é única. "Anterior" (RETURN/REJECT) é do validador.
 */
function transitionProblems(
  transition: WorkflowTransitionFields & { readonly id?: string },
  definition: WorkflowDefinition,
): FieldError[] | ApiError {
  const errors: FieldError[] = [...workflowTransitionIssues(transition)];
  if (errors.length > 0) return errors;
  const from = definition.stages.find((stage) => stage.id === transition.fromStageId);
  const to = definition.stages.find((stage) => stage.id === transition.toStageId);
  const missing = (field: string): FieldError => ({
    field,
    code: 'REFERENCE_NOT_FOUND',
    message: 'Selecione uma etapa desta versão.',
  });
  if (!from) errors.push(missing('fromStageId'));
  if (!to) errors.push(missing('toStageId'));
  if (!from || !to) return errors;
  if (!actionAllowedFrom(transition.action, from.type)) {
    errors.push({
      field: 'action',
      code: 'NOT_ALLOWED',
      message: `Esta ação não é permitida a partir de uma etapa ${stageTypeLabel(from.type)}.`,
    });
  } else if (!actionAllowedTo(transition.action, to.type)) {
    errors.push({
      field: 'action',
      code: 'NOT_ALLOWED',
      message: `Esta ação não pode levar a uma etapa ${stageTypeLabel(to.type)}.`,
    });
  }
  if (errors.length > 0) return errors;
  const duplicated = definition.transitions.some(
    (other) =>
      other.id !== transition.id &&
      other.fromStageId === transition.fromStageId &&
      other.toStageId === transition.toStageId &&
      other.action === transition.action,
  );
  if (duplicated) {
    return new ApiError('CONFLICT', {
      detail: `Já existe uma transição de ${from.name} para ${to.name} com esta ação.`,
      extensions: { conflictField: 'action' },
    });
  }
  return [];
}

function assertTransition(
  transition: WorkflowTransitionFields & { readonly id?: string },
  definition: WorkflowDefinition,
): void {
  const problems = transitionProblems(transition, definition);
  if (problems instanceof ApiError) throw problems;
  if (problems.length > 0) throw validationError(problems);
}

/**
 * `CreateWorkflowTransitionCommand` — WF-13 (US-040 · fluxo principal, passo 4): chave única na
 * versão (409), limite de 200 (RN-WF-18), validações locais e `requiresComment` forçado em
 * `RETURN`/`REJECT`.
 */
@Injectable()
export class CreateWorkflowTransitionCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  execute(input: {
    versionId: string;
    body: WorkflowTransitionCreate;
  }): Promise<WorkflowTransitionDto> {
    const { body } = input;
    return this.editor.edit(input.versionId, async ({ tx, version, now, userId }) => {
      const definition = await this.workflows.loadDefinition(tx, version.id);
      if (definition.transitions.length >= WORKFLOW_LIMITS.transitions) {
        throw limitExceeded(WORKFLOW_LIMITS.transitions, 'transições');
      }
      if (definition.transitions.some((transition) => transition.key === body.key)) {
        throw workflowKeyTaken(body.key);
      }
      const fields: WorkflowTransitionFields = {
        ...body,
        description: body.description ?? null,
        requiresComment: forcedRequiresComment(body.action, body.requiresComment),
      };
      assertTransition(fields, definition);
      const transition: WorkflowTransition = {
        ...fields,
        id: newId(),
        tenantId: version.tenantId,
        workflowVersionId: version.id,
        createdAt: now,
        updatedAt: now,
        createdById: userId,
        updatedById: userId,
        version: 1,
      };
      await this.workflows.insertTransition(tx, transition);
      return {
        result: toTransitionDto(transition),
        written: true,
        entityType: 'WorkflowTransition',
        entityId: transition.id,
        operation: 'CREATE',
        changes: changedFields(null, transition, TRANSITION_FIELDS),
        metadata: { transitionKey: transition.key },
      };
    });
  }
}

function transitionLocator(workflows: WorkflowRepository, transitionId: string) {
  return async (tx: TenantTx) => {
    const transition = await workflows.findTransition(tx, transitionId);
    if (!transition) throw workflowItemNotFound('transição');
    return transition.workflowVersionId;
  };
}

async function currentTransition(
  workflows: WorkflowRepository,
  { tx }: DraftContext,
  transitionId: string,
  expectedVersion: number,
): Promise<WorkflowTransition> {
  const transition = await workflows.findTransition(tx, transitionId);
  if (!transition) throw workflowItemNotFound('transição');
  if (transition.version !== expectedVersion) {
    throw workflowVersionConflict(transition.version);
  }
  return transition;
}

/** `UpdateWorkflowTransitionCommand` — WF-14: `key` imutável; as validações locais valem sobre o resultado. */
@Injectable()
export class UpdateWorkflowTransitionCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  execute(input: {
    transitionId: string;
    patch: WorkflowTransitionUpdate;
    expectedVersion: number;
  }): Promise<WorkflowTransitionDto> {
    return this.editor.edit(
      transitionLocator(this.workflows, input.transitionId),
      async (context) => {
        const { tx, now, userId } = context;
        const current = await currentTransition(
          this.workflows,
          context,
          input.transitionId,
          input.expectedVersion,
        );
        const patched = { ...current, ...definedEntries(input.patch) };
        const merged: WorkflowTransition = {
          ...patched,
          requiresComment: forcedRequiresComment(patched.action, patched.requiresComment),
        };
        const changes = changedFields(current, merged, TRANSITION_FIELDS);
        const base = {
          entityType: 'WorkflowTransition',
          entityId: current.id,
          operation: 'UPDATE',
          metadata: { transitionKey: current.key },
        } as const;
        if (changes.length === 0) {
          return { ...base, result: toTransitionDto(current), written: false, changes };
        }
        assertTransition(
          merged,
          await this.workflows.loadDefinition(tx, current.workflowVersionId),
        );
        const next: WorkflowTransition = {
          ...merged,
          updatedAt: now,
          updatedById: userId,
          version: current.version + 1,
        };
        await this.workflows.updateTransition(tx, next, input.expectedVersion);
        return { ...base, result: toTransitionDto(next), written: true, changes };
      },
    );
  }
}

/** `DeleteWorkflowTransitionCommand` — WF-15: remove em cascata as regras da transição. */
@Injectable()
export class DeleteWorkflowTransitionCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  execute(input: { transitionId: string; expectedVersion: number }): Promise<void> {
    return this.editor.edit(
      transitionLocator(this.workflows, input.transitionId),
      async (context) => {
        const current = await currentTransition(
          this.workflows,
          context,
          input.transitionId,
          input.expectedVersion,
        );
        await this.workflows.deleteTransition(context.tx, current.id, input.expectedVersion);
        return {
          result: undefined,
          written: true,
          entityType: 'WorkflowTransition',
          entityId: current.id,
          operation: 'DELETE',
          changes: changedFields(current, null, ['key', 'name', 'action']),
          metadata: { transitionKey: current.key },
        };
      },
    );
  }
}

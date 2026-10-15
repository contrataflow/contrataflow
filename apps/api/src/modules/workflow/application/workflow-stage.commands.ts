import { WORKFLOW_LIMITS, workflowStageIssues } from '@contrataflow/validation';
import type {
  WorkflowStageCreate,
  WorkflowStageDto,
  WorkflowStageFields,
  WorkflowStageUpdate,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { WORKFLOW_REPOSITORY } from './ports.js';
import type { WorkflowRepository } from './ports.js';
import { changedFields, WorkflowDraftEditor } from './workflow-draft-editor.js';
import type { DraftContext } from './workflow-draft-editor.js';
import { WorkflowReferenceService } from './workflow-references.js';
import {
  workflowItemNotFound,
  workflowKeyTaken,
  workflowVersionConflict,
} from './workflow.errors.js';
import { toStageDto } from './workflow.view.js';
import type { WorkflowStage } from '../domain/workflow-definition.js';

/** Campos de definição da etapa (auditoria campo a campo). */
export const STAGE_FIELDS = [
  'key',
  'name',
  'instructions',
  'type',
  'groupLabel',
  'displayOrder',
  'departmentResolution',
  'fixedDepartmentId',
  'assignmentPolicy',
  'approverType',
  'approverUserId',
  'approverRoleId',
  'approverDepartmentResolution',
  'approverFixedDepartmentId',
  'allowDeputy',
  'approvalDocumentTypeCodes',
  'documentTypeCodes',
  'slaDays',
  'slaType',
  'color',
] as const satisfies readonly (keyof WorkflowStageFields)[];

/** Só as chaves informadas (o PATCH não apaga o que não veio). */
export function definedEntries<T extends object>(
  patch: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export function limitExceeded(limit: number, items: string): ApiError {
  return new ApiError('BUSINESS_RULE_VIOLATION', {
    detail: `O fluxo excede o limite de ${limit} ${items}.`,
  });
}

const secondStart = () =>
  validationError([
    { field: 'type', code: 'NOT_ALLOWED', message: 'A versão já possui uma etapa inicial.' },
  ]);

async function stagesOf(
  workflows: WorkflowRepository,
  tx: TenantTx,
  versionId: string,
): Promise<readonly WorkflowStage[]> {
  return (await workflows.loadDefinition(tx, versionId)).stages;
}

/**
 * `CreateWorkflowStageCommand` — WF-10 (US-040 · fluxo principal, passo 3): valida os condicionais
 * por tipo (RN-WF-08, no schema), a chave única na versão (409 `CONFLICT`), a segunda `START` (422
 * `NOT_ALLOWED` em `type` — RN-WF-07), o limite de 50 etapas (RN-WF-18) e as referências (V-05);
 * a etapa `START` passa a ser a `initialStageId` da versão.
 */
@Injectable()
export class CreateWorkflowStageCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
    private readonly references: WorkflowReferenceService,
  ) {}

  execute(input: { versionId: string; body: WorkflowStageCreate }): Promise<WorkflowStageDto> {
    const { body } = input;
    return this.editor.edit(input.versionId, async ({ tx, version, now, userId }) => {
      const stages = await stagesOf(this.workflows, tx, version.id);
      if (stages.length >= WORKFLOW_LIMITS.stages)
        throw limitExceeded(WORKFLOW_LIMITS.stages, 'etapas');
      if (stages.some((stage) => stage.key === body.key)) throw workflowKeyTaken(body.key);
      if (body.type === 'START' && stages.some((stage) => stage.type === 'START')) {
        throw secondStart();
      }
      const fields: WorkflowStageFields = {
        ...body,
        instructions: body.instructions ?? null,
        groupLabel: body.groupLabel ?? null,
        displayOrder:
          body.displayOrder ??
          stages.reduce((max, stage) => Math.max(max, stage.displayOrder + 1), 0),
      };
      const errors = await this.references.stageReferenceErrors(
        tx,
        fields,
        new Set(Object.keys(fields)),
        now,
      );
      if (errors.length > 0) throw validationError(errors);

      const stage: WorkflowStage = {
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
      await this.workflows.insertStage(tx, stage);
      return {
        result: toStageDto(stage),
        written: true,
        entityType: 'WorkflowStage',
        entityId: stage.id,
        operation: 'CREATE',
        changes: changedFields(null, stage, STAGE_FIELDS),
        metadata: { stageKey: stage.key },
        ...(stage.type === 'START' ? { initialStageId: stage.id } : {}),
      };
    });
  }
}

/** Localiza a versão da etapa (404 se inexistente ou de outro tenant). */
function stageLocator(workflows: WorkflowRepository, stageId: string) {
  return async (tx: TenantTx) => {
    const stage = await workflows.findStage(tx, stageId);
    if (!stage) throw workflowItemNotFound('etapa');
    return stage.workflowVersionId;
  };
}

/** Relê o item sob a trava da versão e confere o `If-Match` (412). */
async function currentStage(
  workflows: WorkflowRepository,
  { tx }: DraftContext,
  stageId: string,
  expectedVersion: number,
): Promise<WorkflowStage> {
  const stage = await workflows.findStage(tx, stageId);
  if (!stage) throw workflowItemNotFound('etapa');
  if (stage.version !== expectedVersion) {
    throw workflowVersionConflict(stage.version);
  }
  return stage;
}

/**
 * `UpdateWorkflowStageCommand` — WF-11: `key` imutável; os condicionais (RN-WF-08) valem sobre o
 * resultado do PATCH; trocar a `START` por outro tipo limpa a `initialStageId` (FA-03); só as
 * referências alteradas são conferidas. Nada alterado → 200 sem nova versão nem auditoria.
 */
@Injectable()
export class UpdateWorkflowStageCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
    private readonly references: WorkflowReferenceService,
  ) {}

  execute(input: {
    stageId: string;
    patch: WorkflowStageUpdate;
    expectedVersion: number;
  }): Promise<WorkflowStageDto> {
    return this.editor.edit(stageLocator(this.workflows, input.stageId), async (context) => {
      const { tx, now, userId } = context;
      const current = await currentStage(
        this.workflows,
        context,
        input.stageId,
        input.expectedVersion,
      );
      const merged: WorkflowStage = { ...current, ...definedEntries(input.patch) };
      const changes = changedFields(current, merged, STAGE_FIELDS);
      const base = {
        entityType: 'WorkflowStage',
        entityId: current.id,
        operation: 'UPDATE',
        metadata: { stageKey: current.key },
      } as const;
      if (changes.length === 0) {
        return { ...base, result: toStageDto(current), written: false, changes };
      }
      const issues = workflowStageIssues(merged);
      if (issues.length > 0) throw validationError(issues);
      if (merged.type === 'START' && current.type !== 'START') {
        const stages = await stagesOf(this.workflows, tx, current.workflowVersionId);
        if (stages.some((stage) => stage.type === 'START')) throw secondStart();
      }
      const errors = await this.references.stageReferenceErrors(
        tx,
        merged,
        new Set(changes.map((change) => change.path)),
        now,
      );
      if (errors.length > 0) throw validationError(errors);

      const next: WorkflowStage = {
        ...merged,
        updatedAt: now,
        updatedById: userId,
        version: current.version + 1,
      };
      await this.workflows.updateStage(tx, next, input.expectedVersion);
      const initialStageId =
        next.type === 'START' ? next.id : current.type === 'START' ? null : undefined;
      return {
        ...base,
        result: toStageDto(next),
        written: true,
        changes,
        ...(initialStageId === undefined ? {} : { initialStageId }),
      };
    });
  }
}

/**
 * `DeleteWorkflowStageCommand` — WF-12: só em rascunho; remove em cascata as transições e regras da
 * etapa (FKs `ON DELETE CASCADE`). Regra `REQUIRED_APPROVAL` de outra etapa que a referencie por
 * chave continua e o validador acusa `WF_RULE_SCOPE_INVALID` (FA-04).
 */
@Injectable()
export class DeleteWorkflowStageCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  execute(input: { stageId: string; expectedVersion: number }): Promise<void> {
    return this.editor.edit(stageLocator(this.workflows, input.stageId), async (context) => {
      const current = await currentStage(
        this.workflows,
        context,
        input.stageId,
        input.expectedVersion,
      );
      await this.workflows.deleteStage(context.tx, current.id, input.expectedVersion);
      return {
        result: undefined,
        written: true,
        entityType: 'WorkflowStage',
        entityId: current.id,
        operation: 'DELETE',
        changes: changedFields(current, null, ['key', 'name', 'type']),
        metadata: { stageKey: current.key },
        ...(current.type === 'START' ? { initialStageId: null } : {}),
      };
    });
  }
}

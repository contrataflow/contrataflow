import {
  normalizeApproverLine,
  STAGE_SINGLE_APPROVER_FIELDS,
  WORKFLOW_LIMITS,
  workflowStageIssues,
} from '@contrataflow/validation';
import type {
  FieldError,
  WorkflowStageApproversDto,
  WorkflowStageApproversSet,
  WorkflowStageCreate,
  WorkflowStageDto,
  WorkflowStageFields,
  WorkflowStageUpdate,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AuditChange } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { WORKFLOW_REPOSITORY } from './ports.js';
import type { WorkflowRepository } from './ports.js';
import { changedFields, WorkflowDraftEditor } from './workflow-draft-editor.js';
import type { DraftContext, DraftEdit } from './workflow-draft-editor.js';
import { WorkflowReferenceService } from './workflow-references.js';
import {
  workflowDeleteBlocked,
  workflowItemNotFound,
  workflowKeyTaken,
  workflowVersionConflict,
} from './workflow.errors.js';
import { toApproverLineDto, toStageDto } from './workflow.view.js';
import {
  approversAuditValue,
  approversOf,
  buildStageApprovers,
  decisionPolicyOf,
  mirrorFirstLine,
  sameDecisionConfiguration,
} from '../domain/stage-approvers.js';
import type { WorkflowStage } from '../domain/workflow-definition.js';
import { stageDeleteBlockers } from '../domain/workflow-delete-guard.js';

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
        metadata: { stageKey: stage.key, stageType: stage.type },
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
      // US-132 (RN-APV-08 · V-09): com lista, o aprovador único é o espelho da linha 1.
      if (approversOf(current).length > 0) {
        const mirrored = changes.filter((change) =>
          (STAGE_SINGLE_APPROVER_FIELDS as readonly string[]).includes(change.path),
        );
        if (mirrored.length > 0) {
          throw validationError(
            mirrored.map((change) => ({
              field: change.path,
              code: 'NOT_ALLOWED',
              message: 'O aprovador desta etapa é definido pela lista de aprovadores.',
            })),
          );
        }
      }
      const base = {
        entityType: 'WorkflowStage',
        entityId: current.id,
        operation: 'UPDATE',
        metadata: { stageKey: current.key, stageType: merged.type },
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

const NOT_APPROVAL_POLICY = 'Só etapas de aprovação têm política de decisão.';

/** Motivo do `warn workflow.stage_approvers_rejected` (US-132 · Logs). */
function rejectionReason(error: ApiError): 'NOT_DRAFT' | 'DUPLICATE' | 'REFERENCE' | null {
  if (error.code === 'WORKFLOW_VERSION_NOT_DRAFT') return 'NOT_DRAFT';
  if (error.errors.some((item) => item.code === 'DUPLICATE_IN_LIST')) return 'DUPLICATE';
  if (error.errors.some((item) => item.code.startsWith('REFERENCE_'))) return 'REFERENCE';
  return null;
}

interface SetStageApproversInput {
  readonly stageId: string;
  readonly body: WorkflowStageApproversSet;
  readonly expectedVersion: number;
}

/**
 * `SetStageApproversCommand` — WF-65 (US-132 · RN-APV-01..10): na transação do rascunho (versão
 * travada, `DRAFT`, `WORKFLOW_MANAGE` + MFA), confere o `If-Match` da etapa (412), recusa política
 * ou linhas fora de etapa `APPROVAL` (`NOT_ALLOWED`), confere as referências por linha (V-06),
 * substitui a lista de forma atômica (`sequence` 1..n, ids novos, alçada preservada), espelha a
 * linha 1 no aprovador único (RN-APV-08), incrementa a etapa e a versão e audita `workflow.update`.
 * O mesmo conteúdo já gravado é *no-op* (200 sem versão nova nem auditoria). O rascunho tolera
 * `ALL`/`SEQUENTIAL` com menos de duas linhas (FA-03): o mínimo é da validação/publicação.
 */
@Injectable()
export class SetStageApproversCommand {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
    private readonly references: WorkflowReferenceService,
  ) {}

  async execute(input: SetStageApproversInput): Promise<WorkflowStageApproversDto> {
    try {
      return await this.editor.edit(stageLocator(this.workflows, input.stageId), (context) =>
        this.apply(context, input),
      );
    } catch (error) {
      this.logFailure(input.stageId, error);
      throw error;
    }
  }

  private async apply(
    context: DraftContext,
    input: SetStageApproversInput,
  ): Promise<DraftEdit<WorkflowStageApproversDto>> {
    const { tx, now, userId } = context;
    const current = await currentStage(
      this.workflows,
      context,
      input.stageId,
      input.expectedVersion,
    );
    const policy = input.body.decisionPolicy;
    const lines = input.body.approvers.map((line) => normalizeApproverLine(line));
    if (current.type !== 'APPROVAL') {
      const issues: FieldError[] = [];
      if (policy !== 'ANY') {
        issues.push({ field: 'decisionPolicy', code: 'NOT_ALLOWED', message: NOT_APPROVAL_POLICY });
      }
      if (lines.length > 0) {
        issues.push({ field: 'approvers', code: 'NOT_ALLOWED', message: NOT_APPROVAL_POLICY });
      }
      if (issues.length > 0) throw validationError(issues);
    }
    const base = {
      entityType: 'WorkflowStage',
      entityId: current.id,
      operation: 'UPDATE',
    } as const;
    if (sameDecisionConfiguration(current, policy, lines)) {
      return { ...base, result: await this.dto(context, current), written: false, changes: [] };
    }
    const errors = await this.references.approverLineErrors(tx, lines, now);
    if (errors.length > 0) throw validationError(errors);

    const approvers = buildStageApprovers(lines, approversOf(current), {
      tenantId: current.tenantId,
      workflowVersionId: current.workflowVersionId,
      workflowStageId: current.id,
      now,
      userId,
      newId,
    });
    const next: WorkflowStage = {
      ...current,
      ...mirrorFirstLine(current, lines),
      decisionPolicy: policy,
      approvers,
      updatedAt: now,
      updatedById: userId,
      version: current.version + 1,
    };
    await this.workflows.updateStage(tx, next, input.expectedVersion);
    await this.workflows.replaceStageApprovers(tx, next, approvers);

    const changes: AuditChange[] = [];
    if (decisionPolicyOf(current) !== policy) {
      changes.push({ path: 'decisionPolicy', old: decisionPolicyOf(current), new: policy });
    }
    const before = approversAuditValue(approversOf(current));
    const after = approversAuditValue(lines);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ path: 'approvers', old: before, new: after });
    }
    changes.push(...changedFields(current, next, STAGE_SINGLE_APPROVER_FIELDS));
    return {
      ...base,
      result: await this.dto(context, next),
      written: true,
      changes,
      metadata: {
        stageId: current.id,
        stageKey: current.key,
        decisionPolicy: policy,
        approversCount: lines.length,
      },
      log: {
        event: 'workflow.stage_approvers_set',
        fields: { stageId: current.id, decisionPolicy: policy, approversCount: lines.length },
      },
    };
  }

  private async dto(
    { tx, now }: DraftContext,
    stage: WorkflowStage,
  ): Promise<WorkflowStageApproversDto> {
    const lines = approversOf(stage);
    const resolved = await this.references.resolveApproverLines(tx, lines, now);
    return {
      stageId: stage.id,
      decisionPolicy: decisionPolicyOf(stage),
      approvers: lines.map((line, index) => toApproverLineDto(line, resolved[index])),
      version: stage.version,
    };
  }

  private logFailure(stageId: string, error: unknown): void {
    const context = requireRequestContext();
    const common = {
      stageId,
      tenantId: context.tenantId,
      userId: context.actor.userId,
      correlationId: context.correlationId,
    };
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      this.logger.warn(
        { event: 'workflow.stage_approvers_conflict', ...common },
        'workflow.stage_approvers_conflict',
      );
      return;
    }
    if (error instanceof ApiError && error.status < 500) {
      const reason = rejectionReason(error);
      if (reason) {
        this.logger.warn(
          { event: 'workflow.stage_approvers_rejected', reason, ...common },
          'workflow.stage_approvers_rejected',
        );
      }
      return;
    }
    this.logger.error(
      {
        event: 'workflow.stage_approvers_write_failed',
        cause:
          error instanceof ApiError ? error.code : error instanceof Error ? error.name : 'unknown',
        ...common,
      },
      'workflow.stage_approvers_write_failed',
    );
  }
}

/**
 * `DeleteWorkflowStageCommand` — WF-12: só em rascunho e sempre restritiva (US-043 · RN-WF-50 ·
 * FA-01): com transições ou regras ainda apontando para a etapa → 422 `BUSINESS_RULE_VIOLATION`,
 * uma violação por item (a UI lista). As FKs `ON DELETE CASCADE` ficam só como rede do banco. Regra
 * `REQUIRED_APPROVAL` de outra etapa que a referencie por chave não bloqueia e o validador acusa
 * `WF_RULE_SCOPE_INVALID` (FA-04 da US-040).
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
      const blockers = stageDeleteBlockers(
        await this.workflows.loadDefinition(context.tx, current.workflowVersionId),
        current.id,
      );
      if (blockers.length > 0) throw workflowDeleteBlocked('etapa', blockers);
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

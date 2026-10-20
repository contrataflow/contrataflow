import { WORKFLOW_LIMITS, workflowRuleIssues } from '@contrataflow/validation';
import type {
  FieldError,
  WorkflowRuleCreate,
  WorkflowRuleDto,
  WorkflowRuleFields,
  WorkflowRuleUpdate,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';

import { WORKFLOW_REPOSITORY } from './ports.js';
import type { WorkflowRepository } from './ports.js';
import { auditDigest, changedFields, WorkflowDraftEditor } from './workflow-draft-editor.js';
import type { DraftContext } from './workflow-draft-editor.js';
import { WorkflowReferenceService } from './workflow-references.js';
import { definedEntries, limitExceeded } from './workflow-stage.commands.js';
import { workflowItemNotFound, workflowVersionConflict } from './workflow.errors.js';
import { toRuleDto } from './workflow.view.js';
import { RULE_TRANSITION_ACTIONS } from '../domain/workflow-definition.js';
import type { WorkflowDefinition, WorkflowRule } from '../domain/workflow-definition.js';

export const RULE_FIELDS = [
  'scope',
  'stageId',
  'transitionId',
  'type',
  'name',
  'description',
  'severity',
  'config',
  'message',
  'isActive',
  'displayOrder',
] as const satisfies readonly (keyof WorkflowRuleFields)[];

/**
 * RN-WF-17 (referências): alvo na versão (`stageId`/`transitionId` de outra versão ou tenant =
 * `REFERENCE_NOT_FOUND`), `STAGE_EXIT` fora da `END`, `TRANSITION` só em encaminhar/concluir/aprovar,
 * `REQUIRED_APPROVAL.stageKey` de etapa `APPROVAL` da versão e `REQUIRED_DOCUMENT` com tipo ativo.
 */
async function ruleReferenceErrors(
  references: WorkflowReferenceService,
  tx: TenantTx,
  rule: WorkflowRuleFields,
  definition: WorkflowDefinition,
): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  if (rule.scope === 'STAGE_EXIT' && rule.stageId) {
    const stage = definition.stages.find((candidate) => candidate.id === rule.stageId);
    if (!stage) {
      errors.push({
        field: 'stageId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione uma etapa desta versão.',
      });
    } else if (stage.type === 'END') {
      errors.push({
        field: 'stageId',
        code: 'NOT_ALLOWED',
        message: 'A etapa final não tem regra de saída.',
      });
    }
  }
  if (rule.scope === 'TRANSITION' && rule.transitionId) {
    const transition = definition.transitions.find(
      (candidate) => candidate.id === rule.transitionId,
    );
    if (!transition) {
      errors.push({
        field: 'transitionId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione uma transição desta versão.',
      });
    } else if (!RULE_TRANSITION_ACTIONS.includes(transition.action)) {
      errors.push({
        field: 'transitionId',
        code: 'NOT_ALLOWED',
        message: 'Regras de transição só valem para encaminhar, concluir ou aprovar.',
      });
    }
  }
  const config = rule.config as Record<string, unknown>;
  if (rule.type === 'REQUIRED_DOCUMENT' && typeof config.documentTypeCode === 'string') {
    const error = await references.documentTypeCodeError(
      tx,
      config.documentTypeCode,
      'config.documentTypeCode',
    );
    if (error) errors.push(error);
  }
  if (rule.type === 'REQUIRED_APPROVAL' && typeof config.stageKey === 'string') {
    const approval = definition.stages.find(
      (stage) => stage.key === config.stageKey && stage.type === 'APPROVAL',
    );
    if (!approval) {
      errors.push({
        field: 'config.stageKey',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione uma etapa de aprovação desta versão.',
      });
    }
  }
  return errors;
}

function ruleMetadata(rule: WorkflowRule): Record<string, unknown> {
  return {
    ruleId: rule.id,
    type: rule.type,
    scope: rule.scope,
    stageId: rule.stageId,
    transitionId: rule.transitionId,
    config: auditDigest(rule.config),
  };
}

/** `CreateWorkflowRuleCommand` — WF-16 (US-040 · fluxo principal, passo 5). */
@Injectable()
export class CreateWorkflowRuleCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
    private readonly references: WorkflowReferenceService,
  ) {}

  execute(input: { versionId: string; body: WorkflowRuleCreate }): Promise<WorkflowRuleDto> {
    const { body } = input;
    return this.editor.edit(input.versionId, async ({ tx, version, now, userId }) => {
      const definition = await this.workflows.loadDefinition(tx, version.id);
      if (definition.rules.length >= WORKFLOW_LIMITS.rules) {
        throw limitExceeded(WORKFLOW_LIMITS.rules, 'regras');
      }
      const fields: WorkflowRuleFields = { ...body, description: body.description ?? null };
      const errors = await ruleReferenceErrors(this.references, tx, fields, definition);
      if (errors.length > 0) throw validationError(errors);
      const rule: WorkflowRule = {
        ...fields,
        config: body.config,
        id: newId(),
        tenantId: version.tenantId,
        workflowVersionId: version.id,
        createdAt: now,
        updatedAt: now,
        createdById: userId,
        updatedById: userId,
        version: 1,
      };
      await this.workflows.insertRule(tx, rule);
      return {
        result: toRuleDto(rule),
        written: true,
        entityType: 'WorkflowRule',
        entityId: rule.id,
        operation: 'CREATE',
        changes: changedFields(null, rule, RULE_FIELDS),
        metadata: ruleMetadata(rule),
      };
    });
  }
}

function ruleLocator(workflows: WorkflowRepository, ruleId: string) {
  return async (tx: TenantTx) => {
    const rule = await workflows.findRule(tx, ruleId);
    if (!rule) throw workflowItemNotFound('regra');
    return rule.workflowVersionId;
  };
}

async function currentRule(
  workflows: WorkflowRepository,
  { tx }: DraftContext,
  ruleId: string,
  expectedVersion: number,
): Promise<WorkflowRule> {
  const rule = await workflows.findRule(tx, ruleId);
  if (!rule) throw workflowItemNotFound('regra');
  if (rule.version !== expectedVersion) {
    throw workflowVersionConflict(rule.version);
  }
  return rule;
}

/** `UpdateWorkflowRuleCommand` — WF-17: escopo, `config` e referências valem sobre o resultado. */
@Injectable()
export class UpdateWorkflowRuleCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
    private readonly references: WorkflowReferenceService,
  ) {}

  execute(input: {
    ruleId: string;
    patch: WorkflowRuleUpdate;
    expectedVersion: number;
  }): Promise<WorkflowRuleDto> {
    return this.editor.edit(ruleLocator(this.workflows, input.ruleId), async (context) => {
      const { tx, now, userId } = context;
      const current = await currentRule(
        this.workflows,
        context,
        input.ruleId,
        input.expectedVersion,
      );
      const merged: WorkflowRule = { ...current, ...definedEntries(input.patch) };
      const changes = changedFields(current, merged, RULE_FIELDS);
      const base = {
        entityType: 'WorkflowRule',
        entityId: current.id,
        operation: 'UPDATE',
        metadata: ruleMetadata(merged),
      } as const;
      if (changes.length === 0) {
        return { ...base, result: toRuleDto(current), written: false, changes };
      }
      const issues = workflowRuleIssues(merged);
      if (issues.length > 0) throw validationError(issues);
      const definition = await this.workflows.loadDefinition(tx, current.workflowVersionId);
      const errors = await ruleReferenceErrors(this.references, tx, merged, definition);
      if (errors.length > 0) throw validationError(errors);
      const next: WorkflowRule = {
        ...merged,
        updatedAt: now,
        updatedById: userId,
        version: current.version + 1,
      };
      await this.workflows.updateRule(tx, next, input.expectedVersion);
      return { ...base, result: toRuleDto(next), written: true, changes };
    });
  }
}

/** `DeleteWorkflowRuleCommand` — WF-18. */
@Injectable()
export class DeleteWorkflowRuleCommand {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    private readonly editor: WorkflowDraftEditor,
  ) {}

  execute(input: { ruleId: string; expectedVersion: number }): Promise<void> {
    return this.editor.edit(ruleLocator(this.workflows, input.ruleId), async (context) => {
      const current = await currentRule(
        this.workflows,
        context,
        input.ruleId,
        input.expectedVersion,
      );
      await this.workflows.deleteRule(context.tx, current.id, input.expectedVersion);
      return {
        result: undefined,
        written: true,
        entityType: 'WorkflowRule',
        entityId: current.id,
        operation: 'DELETE',
        changes: changedFields(current, null, ['name', 'type', 'config']),
        metadata: ruleMetadata(current),
      };
    });
  }
}

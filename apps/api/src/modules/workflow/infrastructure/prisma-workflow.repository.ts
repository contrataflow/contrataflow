import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { withLockTiming } from '#shared/database/row-lock.js';
import type { DocumentTypeUsage } from '#shared/document/document-type-usage.js';

import {
  WorkflowDraftExistsError,
  WorkflowImmutableError,
  WorkflowKeyTakenError,
} from '../application/ports.js';
import type {
  DefaultSwitch,
  PageWindow,
  PublishVersionData,
  WorkflowListFilter,
  WorkflowRepository,
  WorkflowTransactions,
} from '../application/ports.js';
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
  WorkflowVersion,
} from '../domain/workflow-definition.js';
import { workflowSnapshotSchema } from '../domain/workflow-snapshot.js';

type WorkflowRow = Prisma.WorkflowGetPayload<object>;
type VersionRow = Prisma.WorkflowVersionGetPayload<object>;
type StageRow = Prisma.WorkflowStageGetPayload<object>;
type TransitionRow = Prisma.WorkflowTransitionGetPayload<object>;
type RuleRow = Prisma.WorkflowRuleGetPayload<object>;

const IMMUTABLE_MARKERS = /cf_wf_version_not_draft|cf_wf_version_immutable/;

/** Mensagens da cadeia do erro (Prisma 7: `cause`, `meta.driverAdapterError.cause`…). */
function* messagesOf(error: unknown, depth = 0): Generator<string> {
  if (depth > 6 || error === null || typeof error !== 'object') return;
  const record = error as Record<string, unknown>;
  for (const key of ['message', 'originalMessage']) {
    if (typeof record[key] === 'string') yield record[key];
  }
  for (const key of ['cause', 'meta', 'driverAdapterError']) {
    yield* messagesOf(record[key], depth + 1);
  }
}

/** Escrita barrada pelos gatilhos de imutabilidade (RN-WF-05/21). */
function rethrowImmutable(error: unknown, table: string): never {
  for (const message of messagesOf(error)) {
    if (IMMUTABLE_MARKERS.test(message)) throw new WorkflowImmutableError(table);
  }
  throw error;
}

async function guarded<T>(table: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    rethrowImmutable(error, table);
  }
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    isDefault: row.isDefault,
    applicabilityRule: row.applicabilityRule ?? null,
    applicabilityPriority: row.applicabilityPriority,
    currentPublishedVersionId: row.currentPublishedVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toVersion(row: VersionRow): WorkflowVersion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workflowId: row.workflowId,
    versionNumber: row.versionNumber,
    status: row.status,
    initialStageId: row.initialStageId,
    changeNotes: row.changeNotes,
    publishedAt: row.publishedAt,
    publishedById: row.publishedById,
    retiredAt: row.retiredAt,
    retiredById: row.retiredById,
    definitionSnapshot:
      row.definitionSnapshot === null ? null : workflowSnapshotSchema.parse(row.definitionSnapshot),
    definitionHash: row.definitionHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toStage(row: StageRow): WorkflowStage {
  return {
    ...row,
    // O check de RN-WF-08 nunca grava `CHOSEN_ON_FORWARD` no aprovador (enum compartilhado).
    approverDepartmentResolution:
      row.approverDepartmentResolution as WorkflowStage['approverDepartmentResolution'],
  };
}

function toTransition(row: TransitionRow): WorkflowTransition {
  return { ...row };
}

function toRule(row: RuleRow): WorkflowRule {
  return { ...row, config: row.config as Record<string, unknown> };
}

function stageData(stage: WorkflowStage) {
  return {
    key: stage.key,
    name: stage.name,
    instructions: stage.instructions,
    type: stage.type,
    groupLabel: stage.groupLabel,
    displayOrder: stage.displayOrder,
    departmentResolution: stage.departmentResolution,
    fixedDepartmentId: stage.fixedDepartmentId,
    assignmentPolicy: stage.assignmentPolicy,
    approverType: stage.approverType,
    approverUserId: stage.approverUserId,
    approverRoleId: stage.approverRoleId,
    approverDepartmentResolution: stage.approverDepartmentResolution,
    approverFixedDepartmentId: stage.approverFixedDepartmentId,
    allowDeputy: stage.allowDeputy,
    approvalDocumentTypeCodes: [...stage.approvalDocumentTypeCodes],
    documentTypeCodes: [...stage.documentTypeCodes],
    slaDays: stage.slaDays,
    slaType: stage.slaType,
    color: stage.color,
    updatedAt: stage.updatedAt,
    updatedById: stage.updatedById,
  };
}

function stageCreate(stage: WorkflowStage): Prisma.WorkflowStageUncheckedCreateInput {
  return {
    ...stageData(stage),
    id: stage.id,
    tenantId: stage.tenantId,
    workflowVersionId: stage.workflowVersionId,
    createdAt: stage.createdAt,
    createdById: stage.createdById,
    version: stage.version,
  };
}

function transitionData(transition: WorkflowTransition) {
  return {
    key: transition.key,
    name: transition.name,
    description: transition.description,
    fromStageId: transition.fromStageId,
    toStageId: transition.toStageId,
    action: transition.action,
    displayOrder: transition.displayOrder,
    isPrimary: transition.isPrimary,
    requiresComment: transition.requiresComment,
    allowDueDateOverride: transition.allowDueDateOverride,
    updatedAt: transition.updatedAt,
    updatedById: transition.updatedById,
  };
}

function transitionCreate(
  transition: WorkflowTransition,
): Prisma.WorkflowTransitionUncheckedCreateInput {
  return {
    ...transitionData(transition),
    id: transition.id,
    tenantId: transition.tenantId,
    workflowVersionId: transition.workflowVersionId,
    createdAt: transition.createdAt,
    createdById: transition.createdById,
    version: transition.version,
  };
}

function ruleData(rule: WorkflowRule) {
  return {
    scope: rule.scope,
    stageId: rule.stageId,
    transitionId: rule.transitionId,
    type: rule.type,
    name: rule.name,
    description: rule.description,
    severity: rule.severity,
    config: rule.config as Prisma.InputJsonObject,
    message: rule.message,
    isActive: rule.isActive,
    displayOrder: rule.displayOrder,
    updatedAt: rule.updatedAt,
    updatedById: rule.updatedById,
  };
}

function ruleCreate(rule: WorkflowRule): Prisma.WorkflowRuleUncheckedCreateInput {
  return {
    ...ruleData(rule),
    id: rule.id,
    tenantId: rule.tenantId,
    workflowVersionId: rule.workflowVersionId,
    createdAt: rule.createdAt,
    createdById: rule.createdById,
    version: rule.version,
  };
}

function tenantOf(): string {
  const { tenantId } = requireRequestContext();
  if (tenantId === null) throw new Error('Workflow exige o tenant do contexto.');
  return tenantId;
}

const STAGE_ORDER = [{ displayOrder: 'asc' as const }, { key: 'asc' as const }];
/** Ordem da aplicabilidade (RN-WF-39 · FA-03). */
const APPLICABILITY_ORDER = [
  { applicabilityPriority: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

/**
 * Tabelas de definição de workflow no PostgreSQL (US-040): leituras e escritas no `tx` do caso de
 * uso, sob a RLS do tenant e a extensão de isolamento. As travas pessimistas da versão/workflow são
 * `SELECT … FOR UPDATE` com `tenant_id` explícito; os gatilhos de imutabilidade viram
 * `WorkflowImmutableError`.
 */
@Injectable()
export class PrismaWorkflowRepository implements WorkflowRepository {
  async findWorkflow(tx: TenantTx, id: string): Promise<Workflow | null> {
    const row = await tx.workflow.findFirst({ where: { id } });
    return row === null ? null : toWorkflow(row);
  }

  async listWorkflows(
    tx: TenantTx,
    filter: WorkflowListFilter,
    window: PageWindow,
  ): Promise<{ items: Workflow[]; total: number }> {
    const where: Prisma.WorkflowWhereInput = filter.search
      ? {
          OR: [
            { name: { contains: filter.search, mode: 'insensitive' } },
            { key: { contains: filter.search, mode: 'insensitive' } },
          ],
        }
      : {};
    const rows = await tx.workflow.findMany({
      where,
      orderBy: APPLICABILITY_ORDER,
      skip: window.skip,
      take: window.take,
    });
    const total = await tx.workflow.count({ where });
    return { items: rows.map(toWorkflow), total };
  }

  async listAllWorkflows(tx: TenantTx): Promise<Workflow[]> {
    const rows = await tx.workflow.findMany({ orderBy: APPLICABILITY_ORDER });
    return rows.map(toWorkflow);
  }

  async lockAllWorkflows(tx: TenantTx): Promise<Workflow[]> {
    const tenantId = tenantOf();
    await withLockTiming(
      { lockType: 'FOR UPDATE', tableName: 'workflows' },
      () =>
        tx.$queryRaw`SELECT id FROM workflows WHERE tenant_id = ${tenantId}::uuid ORDER BY id FOR UPDATE`,
    );
    return this.listAllWorkflows(tx);
  }

  async switchDefault(tx: TenantTx, change: DefaultSwitch): Promise<void> {
    const tenantId = tenantOf();
    const stamp = { updatedAt: change.now, updatedById: change.userId };
    await tx.workflow.updateMany({
      where: { tenantId, isDefault: true, NOT: { id: change.workflowId } },
      data: { isDefault: false, ...stamp },
    });
    await tx.workflow.updateMany({
      where: { tenantId, id: change.workflowId },
      data: { isDefault: true, ...stamp },
    });
    await tx.workflow.updateMany({ where: { tenantId }, data: { version: { increment: 1 } } });
  }

  async lockWorkflow(tx: TenantTx, id: string): Promise<Workflow | null> {
    const tenantId = tenantOf();
    await withLockTiming(
      { lockType: 'FOR UPDATE', tableName: 'workflows' },
      () =>
        tx.$queryRaw`SELECT id FROM workflows WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`,
    );
    return this.findWorkflow(tx, id);
  }

  async findWorkflowByKey(tx: TenantTx, key: string): Promise<Workflow | null> {
    const row = await tx.workflow.findFirst({ where: { key } });
    return row === null ? null : toWorkflow(row);
  }

  async insertWorkflow(tx: TenantTx, workflow: Workflow): Promise<void> {
    try {
      await tx.workflow.create({
        data: {
          id: workflow.id,
          tenantId: workflow.tenantId,
          key: workflow.key,
          name: workflow.name,
          description: workflow.description,
          isActive: workflow.isActive,
          isDefault: workflow.isDefault,
          applicabilityRule:
            workflow.applicabilityRule === null
              ? Prisma.DbNull
              : (workflow.applicabilityRule as Prisma.InputJsonObject),
          applicabilityPriority: workflow.applicabilityPriority,
          currentPublishedVersionId: workflow.currentPublishedVersionId,
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
          createdById: workflow.createdById,
          updatedById: workflow.updatedById,
          version: workflow.version,
        },
      });
    } catch (error) {
      // Corrida de duas criações com a mesma chave: o índice único decide (V-04).
      if (isUniqueViolation(error)) throw new WorkflowKeyTakenError(workflow.key);
      throw error;
    }
  }

  async updateWorkflow(tx: TenantTx, workflow: Workflow, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'Workflow', aggregateId: workflow.id, expectedVersion },
      () =>
        tx.workflow.updateMany({
          where: { id: workflow.id, version: expectedVersion },
          data: {
            name: workflow.name,
            description: workflow.description,
            updatedAt: workflow.updatedAt,
            updatedById: workflow.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async setCurrentPublished(
    tx: TenantTx,
    workflowId: string,
    versionId: string,
    change: { readonly now: Date; readonly userId: string | null },
  ): Promise<void> {
    await tx.workflow.updateMany({
      where: { id: workflowId },
      data: {
        currentPublishedVersionId: versionId,
        updatedAt: change.now,
        updatedById: change.userId,
        version: { increment: 1 },
      },
    });
  }

  async findVersion(tx: TenantTx, id: string): Promise<WorkflowVersion | null> {
    const row = await tx.workflowVersion.findFirst({ where: { id } });
    return row === null ? null : toVersion(row);
  }

  async lockVersion(tx: TenantTx, id: string): Promise<WorkflowVersion | null> {
    const tenantId = tenantOf();
    await withLockTiming(
      { lockType: 'FOR UPDATE', tableName: 'workflow_versions' },
      () =>
        tx.$queryRaw`SELECT id FROM workflow_versions WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`,
    );
    return this.findVersion(tx, id);
  }

  async listVersions(
    tx: TenantTx,
    workflowId: string,
    window: PageWindow,
  ): Promise<{ items: WorkflowVersion[]; total: number }> {
    // Consultas em sequência: o `tx` interativo é uma única conexão.
    const rows = await tx.workflowVersion.findMany({
      where: { workflowId },
      orderBy: { versionNumber: 'desc' },
      skip: window.skip,
      take: window.take,
    });
    const total = await tx.workflowVersion.count({ where: { workflowId } });
    return { items: rows.map(toVersion), total };
  }

  async findDraft(tx: TenantTx, workflowId: string): Promise<WorkflowVersion | null> {
    const row = await tx.workflowVersion.findFirst({ where: { workflowId, status: 'DRAFT' } });
    return row === null ? null : toVersion(row);
  }

  async lastVersion(tx: TenantTx, workflowId: string): Promise<WorkflowVersion | null> {
    const row = await tx.workflowVersion.findFirst({
      where: { workflowId },
      orderBy: { versionNumber: 'desc' },
    });
    return row === null ? null : toVersion(row);
  }

  async insertVersion(tx: TenantTx, version: WorkflowVersion): Promise<void> {
    try {
      await tx.workflowVersion.create({
        data: {
          id: version.id,
          tenantId: version.tenantId,
          workflowId: version.workflowId,
          versionNumber: version.versionNumber,
          status: version.status,
          initialStageId: version.initialStageId,
          changeNotes: version.changeNotes,
          createdAt: version.createdAt,
          updatedAt: version.updatedAt,
          createdById: version.createdById,
          updatedById: version.updatedById,
          version: version.version,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new WorkflowDraftExistsError(version.workflowId);
      throw error;
    }
  }

  async touchVersion(
    tx: TenantTx,
    versionId: string,
    change: {
      readonly initialStageId: string | null;
      readonly now: Date;
      readonly userId: string | null;
    },
  ): Promise<number> {
    const row = await guarded('workflow_versions', () =>
      tx.workflowVersion.update({
        where: { id: versionId },
        data: {
          initialStageId: change.initialStageId,
          updatedAt: change.now,
          updatedById: change.userId,
          version: { increment: 1 },
        },
        select: { version: true },
      }),
    );
    return row.version;
  }

  async publishVersion(tx: TenantTx, data: PublishVersionData): Promise<void> {
    await guarded('workflow_versions', () =>
      tx.workflowVersion.update({
        where: { id: data.id },
        data: {
          status: 'PUBLISHED',
          initialStageId: data.initialStageId,
          changeNotes: data.changeNotes,
          definitionSnapshot: data.snapshot as unknown as Prisma.InputJsonObject,
          definitionHash: data.hash,
          publishedAt: data.publishedAt,
          publishedById: data.publishedById,
          updatedAt: data.publishedAt,
          updatedById: data.publishedById,
          version: { increment: 1 },
        },
      }),
    );
  }

  async retireVersion(
    tx: TenantTx,
    versionId: string,
    change: { readonly now: Date; readonly userId: string | null },
  ): Promise<void> {
    await guarded('workflow_versions', () =>
      tx.workflowVersion.update({
        where: { id: versionId },
        data: {
          status: 'RETIRED',
          retiredAt: change.now,
          retiredById: change.userId,
          updatedAt: change.now,
          updatedById: change.userId,
          version: { increment: 1 },
        },
      }),
    );
  }

  async loadDefinition(tx: TenantTx, versionId: string): Promise<WorkflowDefinition> {
    const where = { workflowVersionId: versionId };
    const stages = await tx.workflowStage.findMany({ where, orderBy: STAGE_ORDER });
    const transitions = await tx.workflowTransition.findMany({ where, orderBy: STAGE_ORDER });
    const rules = await tx.workflowRule.findMany({
      where,
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    });
    return {
      stages: stages.map(toStage),
      transitions: transitions.map(toTransition),
      rules: rules.map(toRule),
    };
  }

  async insertDefinition(tx: TenantTx, definition: WorkflowDefinition): Promise<void> {
    await guarded('workflow_stages', async () => {
      if (definition.stages.length > 0) {
        await tx.workflowStage.createMany({ data: definition.stages.map(stageCreate) });
      }
      if (definition.transitions.length > 0) {
        await tx.workflowTransition.createMany({
          data: definition.transitions.map(transitionCreate),
        });
      }
      if (definition.rules.length > 0) {
        await tx.workflowRule.createMany({ data: definition.rules.map(ruleCreate) });
      }
    });
  }

  async findStage(tx: TenantTx, id: string): Promise<WorkflowStage | null> {
    const row = await tx.workflowStage.findFirst({ where: { id } });
    return row === null ? null : toStage(row);
  }

  async insertStage(tx: TenantTx, stage: WorkflowStage): Promise<void> {
    await guarded('workflow_stages', () => tx.workflowStage.create({ data: stageCreate(stage) }));
  }

  async updateStage(tx: TenantTx, stage: WorkflowStage, expectedVersion: number): Promise<void> {
    await guarded('workflow_stages', () =>
      updateVersioned(
        { aggregateType: 'WorkflowStage', aggregateId: stage.id, expectedVersion },
        () =>
          tx.workflowStage.updateMany({
            where: { id: stage.id, version: expectedVersion },
            data: { ...stageData(stage), version: { increment: 1 } },
          }),
      ),
    );
  }

  async deleteStage(tx: TenantTx, id: string, expectedVersion: number): Promise<void> {
    await guarded('workflow_stages', () =>
      updateVersioned({ aggregateType: 'WorkflowStage', aggregateId: id, expectedVersion }, () =>
        tx.workflowStage.deleteMany({ where: { id, version: expectedVersion } }),
      ),
    );
  }

  async findTransition(tx: TenantTx, id: string): Promise<WorkflowTransition | null> {
    const row = await tx.workflowTransition.findFirst({ where: { id } });
    return row === null ? null : toTransition(row);
  }

  async insertTransition(tx: TenantTx, transition: WorkflowTransition): Promise<void> {
    await guarded('workflow_transitions', () =>
      tx.workflowTransition.create({ data: transitionCreate(transition) }),
    );
  }

  async updateTransition(
    tx: TenantTx,
    transition: WorkflowTransition,
    expectedVersion: number,
  ): Promise<void> {
    await guarded('workflow_transitions', () =>
      updateVersioned(
        { aggregateType: 'WorkflowTransition', aggregateId: transition.id, expectedVersion },
        () =>
          tx.workflowTransition.updateMany({
            where: { id: transition.id, version: expectedVersion },
            data: { ...transitionData(transition), version: { increment: 1 } },
          }),
      ),
    );
  }

  async deleteTransition(tx: TenantTx, id: string, expectedVersion: number): Promise<void> {
    await guarded('workflow_transitions', () =>
      updateVersioned(
        { aggregateType: 'WorkflowTransition', aggregateId: id, expectedVersion },
        () => tx.workflowTransition.deleteMany({ where: { id, version: expectedVersion } }),
      ),
    );
  }

  async findRule(tx: TenantTx, id: string): Promise<WorkflowRule | null> {
    const row = await tx.workflowRule.findFirst({ where: { id } });
    return row === null ? null : toRule(row);
  }

  async insertRule(tx: TenantTx, rule: WorkflowRule): Promise<void> {
    await guarded('workflow_rules', () => tx.workflowRule.create({ data: ruleCreate(rule) }));
  }

  async updateRule(tx: TenantTx, rule: WorkflowRule, expectedVersion: number): Promise<void> {
    await guarded('workflow_rules', () =>
      updateVersioned(
        { aggregateType: 'WorkflowRule', aggregateId: rule.id, expectedVersion },
        () =>
          tx.workflowRule.updateMany({
            where: { id: rule.id, version: expectedVersion },
            data: { ...ruleData(rule), version: { increment: 1 } },
          }),
      ),
    );
  }

  async deleteRule(tx: TenantTx, id: string, expectedVersion: number): Promise<void> {
    await guarded('workflow_rules', () =>
      updateVersioned({ aggregateType: 'WorkflowRule', aggregateId: id, expectedVersion }, () =>
        tx.workflowRule.deleteMany({ where: { id, version: expectedVersion } }),
      ),
    );
  }

  async documentTypeUsage(tx: TenantTx, documentTypeCode: string): Promise<DocumentTypeUsage> {
    const published = await tx.workflowVersion.findMany({
      where: { status: 'PUBLISHED' },
      select: { id: true, workflowId: true },
    });
    if (published.length === 0) return { blockingRules: [], referencingWorkflows: 0 };
    const versionIds = published.map((version) => version.id);
    const workflowOf = new Map(published.map((version) => [version.id, version.workflowId]));
    const stages = await tx.workflowStage.findMany({
      where: { workflowVersionId: { in: versionIds } },
    });
    const rules = await tx.workflowRule.findMany({
      where: {
        workflowVersionId: { in: versionIds },
        type: 'REQUIRED_DOCUMENT',
        config: { path: ['documentTypeCode'], equals: documentTypeCode },
      },
    });
    const workflows = await tx.workflow.findMany({
      where: { id: { in: [...new Set(workflowOf.values())] } },
      select: { id: true, name: true },
    });
    const transitions = await tx.workflowTransition.findMany({
      where: {
        id: { in: rules.flatMap((rule) => (rule.transitionId ? [rule.transitionId] : [])) },
      },
      select: { id: true, fromStageId: true },
    });
    return documentTypeUsageOf(documentTypeCode, {
      stages: stages.map(toStage),
      rules: rules.map(toRule),
      transitions,
      workflowOf,
      workflowNames: new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    });
  }
}

/** Uso calculado sobre as linhas publicadas (compartilhado com o adaptador em memória). */
export function documentTypeUsageOf(
  code: string,
  input: {
    readonly stages: readonly WorkflowStage[];
    readonly rules: readonly WorkflowRule[];
    readonly transitions: readonly { readonly id: string; readonly fromStageId: string }[];
    readonly workflowOf: ReadonlyMap<string, string>;
    readonly workflowNames: ReadonlyMap<string, string>;
  },
): DocumentTypeUsage {
  const stagesById = new Map(input.stages.map((stage) => [stage.id, stage]));
  const fromStage = new Map(
    input.transitions.map((transition) => [transition.id, transition.fromStageId]),
  );
  const referencing = new Set<string>();
  for (const stage of input.stages) {
    if (stage.documentTypeCodes.includes(code) || stage.approvalDocumentTypeCodes.includes(code)) {
      referencing.add(input.workflowOf.get(stage.workflowVersionId) ?? '');
    }
  }
  const blockingRules = [];
  for (const rule of input.rules) {
    if (rule.type !== 'REQUIRED_DOCUMENT' || rule.config.documentTypeCode !== code) continue;
    const workflowId = input.workflowOf.get(rule.workflowVersionId) ?? '';
    referencing.add(workflowId);
    if (!rule.isActive || rule.severity !== 'BLOCKING') continue;
    const stageId = rule.stageId ?? fromStage.get(rule.transitionId ?? '') ?? '';
    blockingRules.push({
      workflowName: input.workflowNames.get(workflowId) ?? '',
      stageName: stagesById.get(stageId)?.name ?? '',
    });
  }
  referencing.delete('');
  return { blockingRules, referencingWorkflows: referencing.size };
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaWorkflowTransactions implements WorkflowTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

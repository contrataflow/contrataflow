import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { DocumentTypeUsage } from '#shared/document/document-type-usage.js';

import { documentTypeUsageOf } from './prisma-workflow.repository.js';
import {
  WorkflowDraftExistsError,
  WorkflowImmutableError,
  WorkflowKeyTakenError,
} from '../application/ports.js';
import type {
  DefaultSwitch,
  PageWindow,
  PublishVersionData,
  ReleasedStage,
  WorkflowListFilter,
  WorkflowRepository,
  WorkflowTransactions,
} from '../application/ports.js';
import { compareApplicability } from '../domain/workflow-applicability.js';
import type {
  Audited,
  Workflow,
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
  WorkflowVersion,
} from '../domain/workflow-definition.js';

type Table<T extends Audited> = Map<string, T>;

/**
 * Definições de workflow em memória (testes e modo de identidade fake de local/dev/test): mesma
 * semântica do adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`),
 * unicidades, concorrência otimista, cascata da exclusão de etapa/transição e a imutabilidade fora
 * de `DRAFT` (o papel dos gatilhos). As travas pessimistas não existem aqui (testes de integração).
 */
@Injectable()
export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly workflows: Table<Workflow> = new Map();
  readonly versions: Table<WorkflowVersion> = new Map();
  readonly stages: Table<WorkflowStage> = new Map();
  readonly transitions: Table<WorkflowTransition> = new Map();
  readonly rules: Table<WorkflowRule> = new Map();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private visible<T extends Audited>(table: Table<T>, id: string): T | null {
    const row = table.get(id);
    return row?.tenantId === this.tenantId() ? row : null;
  }

  private rowsOf<T extends Audited>(table: Table<T>): T[] {
    const tenantId = this.tenantId();
    return [...table.values()].filter((row) => row.tenantId === tenantId);
  }

  /** O papel do gatilho `trg_wf_definition_immutable`. */
  private assertDraft(versionId: string, table: string): void {
    const version = this.versions.get(versionId);
    if (version && version.status !== 'DRAFT') throw new WorkflowImmutableError(table);
  }

  private replaceVersioned<T extends Audited>(
    table: Table<T>,
    row: T,
    expectedVersion: number,
    aggregateType: string,
  ): void {
    const current = this.visible(table, row.id);
    if (current?.version !== expectedVersion) {
      throw new VersionConflictError({ aggregateType, aggregateId: row.id, expectedVersion });
    }
    table.set(row.id, { ...row, version: expectedVersion + 1 });
  }

  private removeVersioned<T extends Audited>(
    table: Table<T>,
    id: string,
    expectedVersion: number,
    aggregateType: string,
  ): T {
    const current = this.visible(table, id);
    if (current?.version !== expectedVersion) {
      throw new VersionConflictError({ aggregateType, aggregateId: id, expectedVersion });
    }
    table.delete(id);
    return current;
  }

  findWorkflow(_tx: TenantTx, id: string): Promise<Workflow | null> {
    return Promise.resolve(this.visible(this.workflows, id));
  }

  listWorkflows(
    tx: TenantTx,
    filter: WorkflowListFilter,
    window: PageWindow,
  ): Promise<{ items: Workflow[]; total: number }> {
    const search = filter.search?.toLowerCase();
    return this.listAllWorkflows(tx).then((rows) => {
      const matching = rows.filter(
        (row) =>
          (filter.isActive === undefined || row.isActive === filter.isActive) &&
          (!search ||
            row.name.toLowerCase().includes(search) ||
            row.key.toLowerCase().includes(search)),
      );
      return {
        items: matching.slice(window.skip, window.skip + window.take),
        total: matching.length,
      };
    });
  }

  listAllWorkflows(_tx: TenantTx): Promise<Workflow[]> {
    return Promise.resolve(this.rowsOf(this.workflows).sort(compareApplicability));
  }

  lockAllWorkflows(tx: TenantTx): Promise<Workflow[]> {
    return this.listAllWorkflows(tx);
  }

  switchDefault(_tx: TenantTx, change: DefaultSwitch): Promise<void> {
    for (const row of this.rowsOf(this.workflows)) {
      const isDefault = row.id === change.workflowId;
      const changed = row.isDefault !== isDefault;
      this.workflows.set(row.id, {
        ...row,
        isDefault,
        ...(changed ? { updatedAt: change.now, updatedById: change.userId } : {}),
        version: row.version + 1,
      });
    }
    return Promise.resolve();
  }

  lockWorkflow(tx: TenantTx, id: string): Promise<Workflow | null> {
    return this.findWorkflow(tx, id);
  }

  findWorkflowByKey(_tx: TenantTx, key: string): Promise<Workflow | null> {
    return Promise.resolve(this.rowsOf(this.workflows).find((row) => row.key === key) ?? null);
  }

  insertWorkflow(_tx: TenantTx, workflow: Workflow): Promise<void> {
    const rows = this.rowsOf(this.workflows);
    // Índices únicos `(tenant_id, key)` e `(tenant_id) WHERE is_default` (ambos violação única).
    if (rows.some((row) => row.key === workflow.key || (workflow.isDefault && row.isDefault))) {
      return Promise.reject(new WorkflowKeyTakenError(workflow.key));
    }
    this.workflows.set(workflow.id, workflow);
    return Promise.resolve();
  }

  updateWorkflow(_tx: TenantTx, workflow: Workflow, expectedVersion: number): Promise<void> {
    this.replaceVersioned(this.workflows, workflow, expectedVersion, 'Workflow');
    return Promise.resolve();
  }

  setCurrentPublished(
    _tx: TenantTx,
    workflowId: string,
    versionId: string,
    change: { readonly now: Date; readonly userId: string | null },
  ): Promise<void> {
    const current = this.visible(this.workflows, workflowId);
    if (current) {
      this.workflows.set(workflowId, {
        ...current,
        currentPublishedVersionId: versionId,
        updatedAt: change.now,
        updatedById: change.userId,
        version: current.version + 1,
      });
    }
    return Promise.resolve();
  }

  findVersion(_tx: TenantTx, id: string): Promise<WorkflowVersion | null> {
    return Promise.resolve(this.visible(this.versions, id));
  }

  lockVersion(tx: TenantTx, id: string): Promise<WorkflowVersion | null> {
    return this.findVersion(tx, id);
  }

  listVersions(
    _tx: TenantTx,
    workflowId: string,
    window: PageWindow,
  ): Promise<{ items: WorkflowVersion[]; total: number }> {
    const all = this.rowsOf(this.versions)
      .filter((row) => row.workflowId === workflowId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return Promise.resolve({
      items: all.slice(window.skip, window.skip + window.take),
      total: all.length,
    });
  }

  findDraft(_tx: TenantTx, workflowId: string): Promise<WorkflowVersion | null> {
    return Promise.resolve(
      this.rowsOf(this.versions).find(
        (row) => row.workflowId === workflowId && row.status === 'DRAFT',
      ) ?? null,
    );
  }

  lastVersion(_tx: TenantTx, workflowId: string): Promise<WorkflowVersion | null> {
    const [last] = this.rowsOf(this.versions)
      .filter((row) => row.workflowId === workflowId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return Promise.resolve(last ?? null);
  }

  insertVersion(_tx: TenantTx, version: WorkflowVersion): Promise<void> {
    const conflict = this.rowsOf(this.versions).some(
      (row) =>
        row.workflowId === version.workflowId &&
        (row.versionNumber === version.versionNumber ||
          (row.status === 'DRAFT' && version.status === 'DRAFT')),
    );
    if (conflict) return Promise.reject(new WorkflowDraftExistsError(version.workflowId));
    this.versions.set(version.id, version);
    return Promise.resolve();
  }

  touchVersion(
    _tx: TenantTx,
    versionId: string,
    change: {
      readonly initialStageId: string | null;
      readonly now: Date;
      readonly userId: string | null;
    },
  ): Promise<number> {
    const current = this.visible(this.versions, versionId);
    if (!current) return Promise.reject(new Error('Versão inexistente.'));
    if (current.status !== 'DRAFT') {
      return Promise.reject(new WorkflowImmutableError('workflow_versions'));
    }
    const version = current.version + 1;
    this.versions.set(versionId, {
      ...current,
      initialStageId: change.initialStageId,
      updatedAt: change.now,
      updatedById: change.userId,
      version,
    });
    return Promise.resolve(version);
  }

  publishVersion(_tx: TenantTx, data: PublishVersionData): Promise<void> {
    const current = this.visible(this.versions, data.id);
    if (current?.status !== 'DRAFT') {
      return Promise.reject(new WorkflowImmutableError('workflow_versions'));
    }
    this.versions.set(data.id, {
      ...current,
      status: 'PUBLISHED',
      initialStageId: data.initialStageId,
      changeNotes: data.changeNotes,
      definitionSnapshot: structuredClone(data.snapshot),
      definitionHash: data.hash,
      publishedAt: data.publishedAt,
      publishedById: data.publishedById,
      updatedAt: data.publishedAt,
      updatedById: data.publishedById,
      version: current.version + 1,
    });
    return Promise.resolve();
  }

  retireVersion(
    _tx: TenantTx,
    versionId: string,
    change: { readonly now: Date; readonly userId: string | null },
  ): Promise<void> {
    const current = this.visible(this.versions, versionId);
    if (current?.status !== 'PUBLISHED') {
      return Promise.reject(new WorkflowImmutableError('workflow_versions'));
    }
    this.versions.set(versionId, {
      ...current,
      status: 'RETIRED',
      retiredAt: change.now,
      retiredById: change.userId,
      updatedAt: change.now,
      updatedById: change.userId,
      version: current.version + 1,
    });
    return Promise.resolve();
  }

  loadDefinition(_tx: TenantTx, versionId: string): Promise<WorkflowDefinition> {
    const inVersion = <T extends Audited & { workflowVersionId: string }>(table: Table<T>) =>
      this.rowsOf(table).filter((row) => row.workflowVersionId === versionId);
    return Promise.resolve({
      stages: inVersion(this.stages).sort(
        (a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key),
      ),
      transitions: inVersion(this.transitions),
      rules: inVersion(this.rules),
    });
  }

  insertDefinition(_tx: TenantTx, definition: WorkflowDefinition): Promise<void> {
    for (const stage of definition.stages) this.stages.set(stage.id, stage);
    for (const transition of definition.transitions)
      this.transitions.set(transition.id, transition);
    for (const rule of definition.rules) this.rules.set(rule.id, rule);
    return Promise.resolve();
  }

  findStage(_tx: TenantTx, id: string): Promise<WorkflowStage | null> {
    return Promise.resolve(this.visible(this.stages, id));
  }

  listReleasedStages(_tx: TenantTx): Promise<ReleasedStage[]> {
    const released = new Set(
      this.rowsOf(this.versions)
        .filter((version) => version.status === 'PUBLISHED' || version.status === 'RETIRED')
        .map((version) => version.id),
    );
    return Promise.resolve(
      this.rowsOf(this.stages)
        .filter((stage) => released.has(stage.workflowVersionId))
        .sort((a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key))
        .map(({ id, workflowVersionId, key, name, groupLabel, displayOrder }) => ({
          id,
          workflowVersionId,
          key,
          name,
          groupLabel,
          displayOrder,
        })),
    );
  }

  insertStage(_tx: TenantTx, stage: WorkflowStage): Promise<void> {
    this.assertDraft(stage.workflowVersionId, 'workflow_stages');
    this.stages.set(stage.id, stage);
    return Promise.resolve();
  }

  updateStage(_tx: TenantTx, stage: WorkflowStage, expectedVersion: number): Promise<void> {
    this.assertDraft(stage.workflowVersionId, 'workflow_stages');
    this.replaceVersioned(this.stages, stage, expectedVersion, 'WorkflowStage');
    return Promise.resolve();
  }

  deleteStage(_tx: TenantTx, id: string, expectedVersion: number): Promise<void> {
    const current = this.visible(this.stages, id);
    if (current) this.assertDraft(current.workflowVersionId, 'workflow_stages');
    this.removeVersioned(this.stages, id, expectedVersion, 'WorkflowStage');
    for (const transition of [...this.transitions.values()]) {
      if (transition.fromStageId === id || transition.toStageId === id) {
        this.cascadeTransition(transition.id);
      }
    }
    for (const rule of [...this.rules.values()]) {
      if (rule.stageId === id) this.rules.delete(rule.id);
    }
    return Promise.resolve();
  }

  private cascadeTransition(id: string): void {
    this.transitions.delete(id);
    for (const rule of [...this.rules.values()]) {
      if (rule.transitionId === id) this.rules.delete(rule.id);
    }
  }

  findTransition(_tx: TenantTx, id: string): Promise<WorkflowTransition | null> {
    return Promise.resolve(this.visible(this.transitions, id));
  }

  insertTransition(_tx: TenantTx, transition: WorkflowTransition): Promise<void> {
    this.assertDraft(transition.workflowVersionId, 'workflow_transitions');
    this.transitions.set(transition.id, transition);
    return Promise.resolve();
  }

  updateTransition(
    _tx: TenantTx,
    transition: WorkflowTransition,
    expectedVersion: number,
  ): Promise<void> {
    this.assertDraft(transition.workflowVersionId, 'workflow_transitions');
    this.replaceVersioned(this.transitions, transition, expectedVersion, 'WorkflowTransition');
    return Promise.resolve();
  }

  deleteTransition(_tx: TenantTx, id: string, expectedVersion: number): Promise<void> {
    const current = this.visible(this.transitions, id);
    if (current) this.assertDraft(current.workflowVersionId, 'workflow_transitions');
    this.removeVersioned(this.transitions, id, expectedVersion, 'WorkflowTransition');
    this.cascadeTransition(id);
    return Promise.resolve();
  }

  findRule(_tx: TenantTx, id: string): Promise<WorkflowRule | null> {
    return Promise.resolve(this.visible(this.rules, id));
  }

  insertRule(_tx: TenantTx, rule: WorkflowRule): Promise<void> {
    this.assertDraft(rule.workflowVersionId, 'workflow_rules');
    this.rules.set(rule.id, rule);
    return Promise.resolve();
  }

  updateRule(_tx: TenantTx, rule: WorkflowRule, expectedVersion: number): Promise<void> {
    this.assertDraft(rule.workflowVersionId, 'workflow_rules');
    this.replaceVersioned(this.rules, rule, expectedVersion, 'WorkflowRule');
    return Promise.resolve();
  }

  deleteRule(_tx: TenantTx, id: string, expectedVersion: number): Promise<void> {
    const current = this.visible(this.rules, id);
    if (current) this.assertDraft(current.workflowVersionId, 'workflow_rules');
    this.removeVersioned(this.rules, id, expectedVersion, 'WorkflowRule');
    return Promise.resolve();
  }

  documentTypeUsage(_tx: TenantTx, documentTypeCode: string): Promise<DocumentTypeUsage> {
    const published = this.rowsOf(this.versions).filter((row) => row.status === 'PUBLISHED');
    const workflowOf = new Map(published.map((version) => [version.id, version.workflowId]));
    const inPublished = <T extends Audited & { workflowVersionId: string }>(table: Table<T>) =>
      this.rowsOf(table).filter((row) => workflowOf.has(row.workflowVersionId));
    return Promise.resolve(
      documentTypeUsageOf(documentTypeCode, {
        stages: inPublished(this.stages),
        rules: inPublished(this.rules),
        transitions: inPublished(this.transitions),
        workflowOf,
        workflowNames: new Map(this.rowsOf(this.workflows).map((row) => [row.id, row.name])),
      }),
    );
  }
}

/** Transações simuladas: um `tx` sentinela ativo só durante o trabalho (sem rollback). */
@Injectable()
export class InMemoryWorkflowTransactions implements WorkflowTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

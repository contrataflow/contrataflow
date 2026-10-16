import { WorkflowCreated } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS, WorkflowKeyTakenError } from './ports.js';
import type { WorkflowRepository, WorkflowTransactions } from './ports.js';
import { WorkflowVersionPublisher } from './workflow-version.publisher.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import {
  AUTHORITY_ROLE_KEY,
  DEFAULT_WORKFLOWS,
  DEFAULT_WORKFLOWS_VERSION,
  materializeSeedDefinition,
} from '../domain/default-workflows.js';
import type { SeedWorkflow } from '../domain/default-workflows.js';
import type { Workflow, WorkflowVersion } from '../domain/workflow-definition.js';

/** Corrida de duas execuções no mesmo tenant: a outra criou o workflow primeiro (RN-WF-34). */
class SeedRaceLost extends Error {
  constructor() {
    super('Workflow semeado por outra execução.');
    this.name = 'SeedRaceLost';
  }
}

interface SeededWorkflow {
  readonly key: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly definitionHash: string;
}

/**
 * Seeder `workflow.seedWorkflows` (US-042 · `SeedDefaultWorkflowsOnProvisioning` · RN-WF-34..38 ·
 * DEC-015): cria os dois workflows de DEC-015 — um por `TenantTransaction` — com a versão 1 já
 * `PUBLISHED` pela MESMA rotina de publicação do editor (`publishIn`: validação, snapshot e
 * `definitionHash` — DEC-084). Idempotente pela chave estável (`UNIQUE (tenant_id, key)`): chave
 * existente é mantida como está (nem conteúdo nem padrão são tocados — FA-05). `DEFAULT_PREPARATORY`
 * só nasce padrão se o tenant ainda não tiver um (RN-WF-40). Audita `workflow.create` e
 * `workflow.version_publish` como ator `SYSTEM`; não emite `WorkflowDefaultChanged` (RN-WF-36).
 */
@Injectable()
export class DefaultWorkflowsSeeder implements TenantSeeder {
  readonly key = 'workflow.seedWorkflows';
  readonly module = 'workflow';
  readonly version = DEFAULT_WORKFLOWS_VERSION;
  /** Tipos de documento das regras, o perfil aprovador e as modalidades da aplicabilidade. */
  readonly dependsOn: readonly string[] = [
    'document.systemTypes',
    'access.defaultRoles',
    'catalog.items',
  ];
  readonly applyToExistingTenants = true;

  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly publisher: WorkflowVersionPublisher,
    private readonly access: AccessFacade,
  ) {}

  async seed(ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const startedAt = performance.now();
    const context = requireRequestContext();
    const seeded: SeededWorkflow[] = [];
    const skipped: string[] = [];
    try {
      for (const spec of DEFAULT_WORKFLOWS) {
        const result = await this.seedOne(ctx, spec);
        if (result === null) skipped.push(spec.key);
        else seeded.push(result);
      }
    } catch (error) {
      this.logger.error(
        {
          event: 'workflow.seed_failed',
          tenantId: ctx.tenantId,
          cause: error instanceof Error ? error.name : 'erro',
          correlationId: context.correlationId,
        },
        'workflow.seed_failed',
      );
      throw error;
    }
    if (skipped.length > 0) {
      this.logger.warn(
        {
          event: 'workflow.seed_skipped_existing',
          tenantId: ctx.tenantId,
          keys: skipped,
          correlationId: context.correlationId,
        },
        'workflow.seed_skipped_existing',
      );
    }
    if (seeded.length > 0) {
      this.logger.log(
        {
          event: 'workflow.seeded',
          tenantId: ctx.tenantId,
          workflows: seeded,
          durationMs: Math.round(performance.now() - startedAt),
          correlationId: context.correlationId,
        },
        'workflow.seeded',
      );
    }
    return { created: seeded.length, skipped: skipped.length };
  }

  async verify(_ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const published = await this.transactions.read(async (tx) => {
      let count = 0;
      for (const spec of DEFAULT_WORKFLOWS) {
        const workflow = await this.workflows.findWorkflowByKey(tx, spec.key);
        if (workflow?.currentPublishedVersionId) count += 1;
      }
      return count;
    });
    return {
      status: published === DEFAULT_WORKFLOWS.length ? 'DONE' : 'PENDING',
      details: { workflows: published },
    };
  }

  /** Um workflow numa transação própria; `null` = já existia (reexecução). */
  private async seedOne(
    ctx: TenantSeedContext,
    spec: SeedWorkflow,
  ): Promise<SeededWorkflow | null> {
    try {
      return await this.transactions.run((tx) => this.create(tx, ctx, spec));
    } catch (error) {
      // A transação abortada pela violação única já foi desfeita; a outra execução venceu.
      if (error instanceof SeedRaceLost) return null;
      throw error;
    }
  }

  private async create(
    tx: TenantTx,
    ctx: TenantSeedContext,
    spec: SeedWorkflow,
  ): Promise<SeededWorkflow | null> {
    if (await this.workflows.findWorkflowByKey(tx, spec.key)) return null;
    const authority = await this.access.findRoleByKey(tx, AUTHORITY_ROLE_KEY);
    if (!authority) {
      throw new Error(`Perfil ${AUTHORITY_ROLE_KEY} ausente: rode o seeder access.defaultRoles.`);
    }
    const hasDefault = (await this.workflows.listAllWorkflows(tx)).some((row) => row.isDefault);
    const now = ctx.now;
    const workflow: Workflow = {
      id: newId(),
      tenantId: ctx.tenantId,
      key: spec.key,
      name: spec.name,
      description: spec.description,
      isActive: true,
      isDefault: spec.isDefault && !hasDefault,
      applicabilityRule: spec.applicabilityRule,
      applicabilityPriority: spec.applicabilityPriority,
      currentPublishedVersionId: null,
      createdAt: now,
      updatedAt: now,
      createdById: null,
      updatedById: null,
      version: 1,
    };
    try {
      await this.workflows.insertWorkflow(tx, workflow);
    } catch (error) {
      if (error instanceof WorkflowKeyTakenError) throw new SeedRaceLost();
      throw error;
    }
    const versionId = newId();
    const definition = materializeSeedDefinition(spec, {
      tenantId: ctx.tenantId,
      workflowVersionId: versionId,
      now,
      newId,
      roleIdOf: () => authority.id,
    });
    const version: WorkflowVersion = {
      id: versionId,
      tenantId: ctx.tenantId,
      workflowId: workflow.id,
      versionNumber: 1,
      status: 'DRAFT',
      initialStageId: definition.stages.find((stage) => stage.type === 'START')?.id ?? null,
      changeNotes: null,
      publishedAt: null,
      publishedById: null,
      retiredAt: null,
      retiredById: null,
      definitionSnapshot: null,
      definitionHash: null,
      createdAt: now,
      updatedAt: now,
      createdById: null,
      updatedById: null,
      version: 1,
    };
    await this.workflows.insertVersion(tx, version);
    await this.workflows.insertDefinition(tx, definition);
    await this.audit.record(tx, {
      action: 'workflow.create',
      entityType: 'Workflow',
      entityId: workflow.id,
      changes: [
        { path: 'key', old: null, new: workflow.key },
        { path: 'name', old: null, new: workflow.name },
      ],
      metadata: {
        key: workflow.key,
        seeded: true,
        seedVersion: DEFAULT_WORKFLOWS_VERSION,
        isDefault: workflow.isDefault,
        draftVersionId: versionId,
      },
    });
    await this.outbox.record(
      tx,
      WorkflowCreated.of({
        aggregateId: workflow.id,
        payload: { workflowId: workflow.id, key: workflow.key },
      }),
    );
    // RN-WF-36: carga inicial publicada na mesma transação — o rascunho nunca é visível.
    const published = await this.publisher.publishIn(tx, { versionId });
    return {
      key: workflow.key,
      workflowId: workflow.id,
      versionId,
      definitionHash: published.definitionHash,
    };
  }
}

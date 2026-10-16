import type { WorkflowValidationResult } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { TenantCache } from '#shared/cache/tenant-cache.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { WORKFLOW_CLOCK, WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './ports.js';
import type { WorkflowClock, WorkflowRepository, WorkflowTransactions } from './ports.js';
import { WorkflowReferenceService } from './workflow-references.js';
import { recordDefinitionCache, recordValidation } from './workflow-telemetry.js';
import { workflowVersionNotFound } from './workflow.errors.js';
import type { WorkflowDefinition, WorkflowVersion } from '../domain/workflow-definition.js';
import { WorkflowDefinitionValidator } from '../domain/workflow-definition.validator.js';
import { workflowSnapshotSchema } from '../domain/workflow-snapshot.js';
import type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

/** `cf:{env}:t:{tenantId}:workflow:def:{workflowVersionId}` — a definição publicada é imutável. */
export const WORKFLOW_CACHE_MODULE = 'workflow';
export const WORKFLOW_DEFINITION_CACHE_TTL_SECONDS = 24 * 60 * 60;

export function definitionCacheKey(versionId: string): string {
  return `def:${versionId}`;
}

export interface ValidatedVersion {
  readonly version: WorkflowVersion;
  readonly definition: WorkflowDefinition;
  readonly result: WorkflowValidationResult;
}

/**
 * Validação completa e leitura da definição publicada (US-040 · V-11 · FA-07): o validador roda
 * sobre as tabelas da versão com os catálogos lidos no mesmo `tx`; a definição publicada vem do
 * `definitionSnapshot` (uma linha), com cache Redis sem invalidação por ser imutável — Redis fora
 * cai no banco com `warn workflow.definition_cache_unavailable`.
 */
@Injectable()
export class WorkflowDefinitionService {
  private readonly logger = new Logger('Workflows');
  private readonly validator = new WorkflowDefinitionValidator();

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
    private readonly references: WorkflowReferenceService,
    private readonly cache: TenantCache,
  ) {}

  /** Valida a versão no `tx` do chamador (publicação e WF-20). */
  async validateIn(tx: TenantTx, version: WorkflowVersion): Promise<ValidatedVersion> {
    const startedAt = performance.now();
    const definition = await this.workflows.loadDefinition(tx, version.id);
    const references = await this.references.resolve(tx, definition, this.clock());
    const result = this.validator.validate(definition, references);
    const durationMs = performance.now() - startedAt;
    recordValidation(durationMs, result.valid);
    this.logger.log(
      {
        event: 'workflow.validation_completed',
        workflowVersionId: version.id,
        errorsCount: result.errors.length,
        warningsCount: result.warnings.length,
        durationMs: Math.round(durationMs),
        correlationId: currentRequestContext()?.correlationId,
      },
      'workflow.validation_completed',
    );
    return { version, definition, result };
  }

  /** `WorkflowDefinitionValidator.validate(versionId)` numa leitura própria (404 se não existe). */
  validate(versionId: string): Promise<WorkflowValidationResult> {
    return this.transactions.read(async (tx) => {
      const version = await this.workflows.findVersion(tx, versionId);
      if (!version) throw workflowVersionNotFound();
      return (await this.validateIn(tx, version)).result;
    });
  }

  /**
   * Snapshot da versão publicada/aposentada (o que o motor lê — US-041), ou `null` para rascunho
   * ou versão inexistente no tenant.
   */
  publishedDefinition(versionId: string): Promise<WorkflowSnapshot | null> {
    return this.cachedSnapshot(versionId, () =>
      this.transactions.read((tx) => this.snapshotIn(tx, versionId)),
    );
  }

  /**
   * Como `publishedDefinition`, mas o banco é lido no `tx` do chamador (US-001: a criação do
   * processo não abre uma segunda conexão por requisição — o pool aguenta criações simultâneas).
   */
  publishedDefinitionIn(tx: TenantTx, versionId: string): Promise<WorkflowSnapshot | null> {
    return this.cachedSnapshot(versionId, () => this.snapshotIn(tx, versionId));
  }

  /** Workflow e número da versão (US-001: cartão "fluxo" do processo), ou `null` no tenant. */
  async describeVersion(
    tx: TenantTx,
    versionId: string,
  ): Promise<{ workflowId: string; name: string; versionNumber: number } | null> {
    const version = await this.workflows.findVersion(tx, versionId);
    if (!version) return null;
    const workflow = await this.workflows.findWorkflow(tx, version.workflowId);
    return workflow
      ? { workflowId: workflow.id, name: workflow.name, versionNumber: version.versionNumber }
      : null;
  }

  private async cachedSnapshot(
    versionId: string,
    load: () => Promise<WorkflowSnapshot | null>,
  ): Promise<WorkflowSnapshot | null> {
    const key = definitionCacheKey(versionId);
    try {
      const cached = await this.cache.get(WORKFLOW_CACHE_MODULE, key, workflowSnapshotSchema);
      if (cached !== null) {
        recordDefinitionCache('hit');
        return cached;
      }
    } catch (error) {
      recordDefinitionCache('unavailable');
      this.cacheUnavailable(versionId, error);
      return load();
    }
    recordDefinitionCache('miss');
    const snapshot = await load();
    if (snapshot === null) return null;
    try {
      await this.cache.set(WORKFLOW_CACHE_MODULE, key, snapshot, {
        ttlSeconds: WORKFLOW_DEFINITION_CACHE_TTL_SECONDS,
      });
    } catch (error) {
      this.cacheUnavailable(versionId, error);
    }
    return snapshot;
  }

  private async snapshotIn(tx: TenantTx, versionId: string): Promise<WorkflowSnapshot | null> {
    const version = await this.workflows.findVersion(tx, versionId);
    return version?.status === 'DRAFT' ? null : (version?.definitionSnapshot ?? null);
  }

  private cacheUnavailable(versionId: string, error: unknown): void {
    this.logger.warn(
      {
        event: 'workflow.definition_cache_unavailable',
        workflowVersionId: versionId,
        cause: error instanceof Error ? error.name : 'unknown',
        correlationId: currentRequestContext()?.correlationId,
      },
      'workflow.definition_cache_unavailable',
    );
  }
}

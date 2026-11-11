import type {
  PageQuery,
  WorkflowDto,
  WorkflowListQuery,
  WorkflowVersionBranchesDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { pageResult, pageWindow } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';

import { WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './ports.js';
import type { WorkflowRepository, WorkflowTransactions } from './ports.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import { workflowNotFound, workflowVersionNotFound } from './workflow.errors.js';
import {
  toVersionDetailDto,
  toVersionDetailFromSnapshot,
  toVersionSummaryDto,
  toWorkflowDto,
} from './workflow.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { analyzeParallelStructure } from '../domain/parallel-graph.js';
import type { ParallelIssue, ParallelStructure } from '../domain/parallel-graph.js';
import type { WorkflowVersion } from '../domain/workflow-definition.js';

const MAX_PAGE_SIZE = 100;

/** `WORKFLOW_VIEW` (leituras WF-03/07/09 — permissions.md §1.1). */
async function authorizeView(access: AccessFacade, identity: IdentityFacade): Promise<void> {
  access.assertCan('WORKFLOW_VIEW', { mfaPolicy: await identity.mfaPolicy() });
}

/** `GetWorkflowQuery` — WF-03: workflow com a publicada corrente e o rascunho (`ETag` = versão). */
@Injectable()
export class GetWorkflowQuery {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(id: string): Promise<WorkflowDto> {
    await authorizeView(this.access, this.identity);
    return this.transactions.read(async (tx) => {
      const workflow = await this.workflows.findWorkflow(tx, id);
      if (!workflow) throw workflowNotFound();
      const published = workflow.currentPublishedVersionId
        ? await this.workflows.findVersion(tx, workflow.currentPublishedVersionId)
        : null;
      return toWorkflowDto(workflow, published, await this.workflows.findDraft(tx, workflow.id));
    });
  }
}

/**
 * `ListWorkflowsQuery` — WF-01 (US-042 · SCR-034): workflows do tenant na ordem da aplicabilidade
 * (RN-WF-39), com o selo de padrão, a publicada corrente (sem ela, "Tornar padrão" fica
 * desabilitado — RN-WF-41) e o rascunho; filtros `q` e `status` (`ACTIVE`/`INACTIVE` — US-043).
 */
@Injectable()
export class ListWorkflowsQuery {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(query: WorkflowListQuery): Promise<PageResult<WorkflowDto>> {
    await authorizeView(this.access, this.identity);
    const window = pageWindow(query, MAX_PAGE_SIZE);
    return this.transactions.read(async (tx) => {
      const { items, total } = await this.workflows.listWorkflows(
        tx,
        {
          ...(query.q ? { search: query.q } : {}),
          ...(query.status ? { isActive: query.status === 'ACTIVE' } : {}),
        },
        window,
      );
      const dtos: WorkflowDto[] = [];
      // Consultas em sequência: o `tx` interativo é uma única conexão.
      for (const workflow of items) {
        const published = workflow.currentPublishedVersionId
          ? await this.workflows.findVersion(tx, workflow.currentPublishedVersionId)
          : null;
        dtos.push(
          toWorkflowDto(workflow, published, await this.workflows.findDraft(tx, workflow.id)),
        );
      }
      return pageResult(dtos, window, total);
    });
  }
}

/**
 * `ListWorkflowVersionsQuery` — WF-07 (RN-WF-69): versões por número decrescente, paginadas, com o
 * nome de quem publicou/aposentou (aba "Versões" do SCR-034 — US-045).
 */
@Injectable()
export class ListWorkflowVersionsQuery {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(
    workflowId: string,
    query: PageQuery,
  ): Promise<PageResult<WorkflowVersionSummaryDto>> {
    await authorizeView(this.access, this.identity);
    const window = pageWindow(query, MAX_PAGE_SIZE);
    return this.transactions.read(async (tx) => {
      const workflow = await this.workflows.findWorkflow(tx, workflowId);
      if (!workflow) throw workflowNotFound();
      const { items, total } = await this.workflows.listVersions(tx, workflowId, window);
      const authorIds = new Set<string>();
      for (const item of items) {
        if (item.publishedById) authorIds.add(item.publishedById);
        if (item.retiredById) authorIds.add(item.retiredById);
      }
      const names =
        authorIds.size > 0
          ? await this.identity.userDisplayNames(tx, [...authorIds])
          : new Map<string, string>();
      const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
      return pageResult(
        items.map((item) => ({
          ...toVersionSummaryDto(item),
          publishedByName: nameOf(item.publishedById),
          retiredByName: nameOf(item.retiredById),
        })),
        window,
        total,
      );
    });
  }
}

/**
 * `GetWorkflowVersionQuery` — WF-09 (FA-07): rascunho lido das tabelas; publicada/aposentada
 * servida do `definitionSnapshot` (cache imutável por versão).
 */
@Injectable()
export class GetWorkflowVersionQuery {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly definitions: WorkflowDefinitionService,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(versionId: string): Promise<WorkflowVersionDetailDto> {
    await authorizeView(this.access, this.identity);
    // Snapshot consistente (US-046 · Concorrência): versão e definição do rascunho lidas no mesmo
    // instante (`REPEATABLE READ READ ONLY`) — as etapas e o ETag nunca são de instantes diferentes,
    // sem retentativa nem 503 quando etapas são salvas em paralelo (leitura não falha por serialização).
    const { version, definition } = await this.transactions.snapshot(async (tx) => {
      const found = await this.workflows.findVersion(tx, versionId);
      if (found?.status !== 'DRAFT') return { version: found, definition: null };
      return { version: found, definition: await this.workflows.loadDefinition(tx, found.id) };
    });
    if (!version) throw workflowVersionNotFound();
    if (definition === null) return this.immutable(version);
    return toVersionDetailDto(version, definition);
  }

  /** Publicada/aposentada: o snapshot imutável (ou as linhas, já imutáveis pelos gatilhos). */
  private async immutable(version: WorkflowVersion): Promise<WorkflowVersionDetailDto> {
    const snapshot = await this.definitions.publishedDefinition(version.id);
    if (snapshot) return toVersionDetailFromSnapshot(version, snapshot);
    const definition = await this.transactions.read((tx) =>
      this.workflows.loadDefinition(tx, version.id),
    );
    return toVersionDetailDto(version, definition);
  }
}

function toBranchIssueDto(issue: ParallelIssue): WorkflowVersionBranchesDto['issues'][number] {
  return {
    code: 'WF_PARALLEL_INVALID',
    reason: issue.reason,
    message: issue.message,
    stageKey: issue.stageKey,
    transitionKey: issue.transitionKey,
  };
}

/** Estrutura de ramos → resposta do WF-24. */
export function toVersionBranchesDto(
  structure: ParallelStructure,
  stageBranch: ReadonlyMap<string, string> = structure.stageBranch,
): WorkflowVersionBranchesDto {
  return {
    blocks: structure.blocks.map((block) => ({
      splitStageKey: block.splitStageKey,
      joinStageKey: block.joinStageKey,
      branches: block.branches.map((branch) => ({
        branchKey: branch.branchKey,
        entryStageKey: branch.entryStageKey,
        stageKeys: [...branch.stageKeys],
        exitTransitionKey: branch.exitTransitionKey,
      })),
      issues: block.issues.map(toBranchIssueDto),
    })),
    issues: structure.issues.map(toBranchIssueDto),
    stageBranch: Object.fromEntries(stageBranch),
  };
}

/**
 * `GetVersionBranchesQuery` — WF-24 (US-123 · painel "Ramificações" do SCR-034): blocos, ramos e
 * problemas de paralelismo. Rascunho: calculado na hora sobre as tabelas lidas num instante único
 * (o mesmo `analyzeParallelStructure` da validação); publicada/aposentada: sobre o
 * `definitionSnapshot`, com o `branchKey` gravado na publicação. Leitura: sem auditoria nem evento.
 */
@Injectable()
export class GetVersionBranchesQuery {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    private readonly definitions: WorkflowDefinitionService,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(
    versionId: string,
  ): Promise<{ readonly etag: number; readonly branches: WorkflowVersionBranchesDto }> {
    await authorizeView(this.access, this.identity);
    const { version, definition } = await this.transactions.snapshot(async (tx) => {
      const found = await this.workflows.findVersion(tx, versionId);
      if (found?.status !== 'DRAFT') return { version: found, definition: null };
      return { version: found, definition: await this.workflows.loadDefinition(tx, found.id) };
    });
    if (!version) throw workflowVersionNotFound();
    if (definition !== null) {
      return {
        etag: version.version,
        branches: toVersionBranchesDto(analyzeParallelStructure(definition)),
      };
    }
    const snapshot = await this.definitions.publishedDefinition(version.id);
    const graph =
      snapshot ??
      (await this.transactions.read((tx) => this.workflows.loadDefinition(tx, version.id)));
    const stageBranch = new Map<string, string>();
    for (const stage of graph.stages) {
      if (stage.branchKey) stageBranch.set(stage.key, stage.branchKey);
    }
    return {
      etag: version.version,
      branches: toVersionBranchesDto(analyzeParallelStructure(graph), stageBranch),
    };
  }
}

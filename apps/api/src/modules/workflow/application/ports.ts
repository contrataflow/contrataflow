import type { TenantTx } from '#shared/database/prisma.js';
import type { DocumentTypeUsage } from '#shared/document/document-type-usage.js';

import type {
  Workflow,
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
  WorkflowVersion,
} from '../domain/workflow-definition.js';
import type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

/*
 * Portas da aplicação do módulo `workflow` (US-040): implementadas em `infrastructure/` (Prisma) e
 * em memória nos testes e no modo de identidade fake (local/dev/test sem banco). Toda leitura e
 * escrita acontece no `tx` do caso de uso, sob a RLS do tenant: id de outro tenant = `null`.
 */

/** Chave de workflow já usada no tenant (índice único `(tenant_id, key)` — V-04). */
export class WorkflowKeyTakenError extends Error {
  constructor(readonly key: string) {
    super('Chave de workflow já usada no tenant.');
    this.name = 'WorkflowKeyTakenError';
  }
}

/** Segundo rascunho do mesmo workflow (índice parcial — RN-WF-04). */
export class WorkflowDraftExistsError extends Error {
  constructor(readonly workflowId: string) {
    super('O workflow já tem uma versão em rascunho.');
    this.name = 'WorkflowDraftExistsError';
  }
}

/** Escrita barrada pelo gatilho `trg_wf_definition_immutable`/`trg_wf_version_immutable`. */
export class WorkflowImmutableError extends Error {
  constructor(readonly table: string) {
    super('Versão de workflow imutável.');
    this.name = 'WorkflowImmutableError';
  }
}

export interface PageWindow {
  readonly skip: number;
  readonly take: number;
}

export interface PublishVersionData {
  readonly id: string;
  readonly initialStageId: string;
  readonly changeNotes: string | null;
  readonly snapshot: WorkflowSnapshot;
  readonly hash: string;
  readonly publishedAt: Date;
  readonly publishedById: string | null;
}

export interface WorkflowListFilter {
  /** Contém, no nome ou na chave, sem diferenciar maiúsculas (WF-01). */
  readonly search?: string;
  /** Situação do workflow (`isActive`); ausente = todos (WF-01 · US-043). */
  readonly isActive?: boolean;
}

export interface DefaultSwitch {
  /** Workflow que passa a ser o padrão (RN-WF-40). */
  readonly workflowId: string;
  readonly now: Date;
  readonly userId: string | null;
}

/** Etapa de versão publicada/aposentada (imutável — RN-WF-08). */
export interface ReleasedStage {
  readonly id: string;
  readonly workflowVersionId: string;
  readonly key: string;
  readonly name: string;
  readonly groupLabel: string | null;
  readonly displayOrder: number;
}

export interface WorkflowRepository {
  // Workflow --------------------------------------------------------------------------------
  findWorkflow(tx: TenantTx, id: string): Promise<Workflow | null>;
  /**
   * WF-01: workflows do tenant na ordem da aplicabilidade (`applicabilityPriority`, `createdAt`,
   * id — RN-WF-39), paginados.
   */
  listWorkflows(
    tx: TenantTx,
    filter: WorkflowListFilter,
    window: PageWindow,
  ): Promise<{ readonly items: Workflow[]; readonly total: number }>;
  /** Todos os workflows do tenant na ordem da aplicabilidade (resolução — WF-06). */
  listAllWorkflows(tx: TenantTx): Promise<Workflow[]>;
  /**
   * `SELECT … FOR UPDATE` de TODOS os workflows do tenant, por id (troca do padrão — RN-WF-40/42):
   * serializa trocas concorrentes; a leitura devolvida é posterior à trava.
   */
  lockAllWorkflows(tx: TenantTx): Promise<Workflow[]>;
  /**
   * Troca atômica do padrão (RN-WF-40): desmarca o anterior, marca o novo (nessa ordem, por causa
   * do índice único parcial) e incrementa a `version` de todos os workflows do tenant (RN-WF-42).
   */
  switchDefault(tx: TenantTx, change: DefaultSwitch): Promise<void>;
  /** `SELECT … FOR UPDATE` (nova versão e publicação). */
  lockWorkflow(tx: TenantTx, id: string): Promise<Workflow | null>;
  findWorkflowByKey(tx: TenantTx, key: string): Promise<Workflow | null>;
  /** @throws WorkflowKeyTakenError */
  insertWorkflow(tx: TenantTx, workflow: Workflow): Promise<void>;
  /** Nome/descrição com `version + 1` condicionado a `expectedVersion`. @throws VersionConflictError */
  updateWorkflow(tx: TenantTx, workflow: Workflow, expectedVersion: number): Promise<void>;
  /** Aponta a versão publicada corrente (RN-WF-20); `version + 1`. */
  setCurrentPublished(
    tx: TenantTx,
    workflowId: string,
    versionId: string,
    change: { readonly now: Date; readonly userId: string | null },
  ): Promise<void>;

  // Versões ---------------------------------------------------------------------------------
  findVersion(tx: TenantTx, id: string): Promise<WorkflowVersion | null>;
  /** `SELECT … FOR UPDATE` da versão (toda escrita no rascunho e a publicação). */
  lockVersion(tx: TenantTx, id: string): Promise<WorkflowVersion | null>;
  /** Versões do workflow por `versionNumber` decrescente. */
  listVersions(
    tx: TenantTx,
    workflowId: string,
    window: PageWindow,
  ): Promise<{ readonly items: WorkflowVersion[]; readonly total: number }>;
  findDraft(tx: TenantTx, workflowId: string): Promise<WorkflowVersion | null>;
  /** Maior `versionNumber` do workflow (sem reaproveitamento — RN-WF-04). */
  lastVersion(tx: TenantTx, workflowId: string): Promise<WorkflowVersion | null>;
  /** @throws WorkflowDraftExistsError */
  insertVersion(tx: TenantTx, version: WorkflowVersion): Promise<void>;
  /**
   * RN-WF-06/07: incrementa `version` da versão e grava a etapa inicial derivada. Devolve o novo
   * `version`.
   */
  touchVersion(
    tx: TenantTx,
    versionId: string,
    change: {
      readonly initialStageId: string | null;
      readonly now: Date;
      readonly userId: string | null;
    },
  ): Promise<number>;
  publishVersion(tx: TenantTx, data: PublishVersionData): Promise<void>;
  retireVersion(
    tx: TenantTx,
    versionId: string,
    change: { readonly now: Date; readonly userId: string | null },
  ): Promise<void>;

  // Definição -------------------------------------------------------------------------------
  loadDefinition(tx: TenantTx, versionId: string): Promise<WorkflowDefinition>;
  insertDefinition(tx: TenantTx, definition: WorkflowDefinition): Promise<void>;

  findStage(tx: TenantTx, id: string): Promise<WorkflowStage | null>;
  /**
   * Etapas das versões publicadas e aposentadas do tenant (US-002: filtro "Etapa" por chave em
   * qualquer versão — RN-PROC-22 — e nomes da etapa atual na lista de processos).
   */
  listReleasedStages(tx: TenantTx): Promise<ReleasedStage[]>;
  insertStage(tx: TenantTx, stage: WorkflowStage): Promise<void>;
  /** @throws VersionConflictError */
  updateStage(tx: TenantTx, stage: WorkflowStage, expectedVersion: number): Promise<void>;
  /** Remove a etapa e, em cascata, as transições e regras ligadas a ela. @throws VersionConflictError */
  deleteStage(tx: TenantTx, id: string, expectedVersion: number): Promise<void>;

  findTransition(tx: TenantTx, id: string): Promise<WorkflowTransition | null>;
  insertTransition(tx: TenantTx, transition: WorkflowTransition): Promise<void>;
  updateTransition(
    tx: TenantTx,
    transition: WorkflowTransition,
    expectedVersion: number,
  ): Promise<void>;
  deleteTransition(tx: TenantTx, id: string, expectedVersion: number): Promise<void>;

  findRule(tx: TenantTx, id: string): Promise<WorkflowRule | null>;
  insertRule(tx: TenantTx, rule: WorkflowRule): Promise<void>;
  updateRule(tx: TenantTx, rule: WorkflowRule, expectedVersion: number): Promise<void>;
  deleteRule(tx: TenantTx, id: string, expectedVersion: number): Promise<void>;

  /** Uso do tipo de documento pelas versões `PUBLISHED` (US-061 · RN-DOC-09). */
  documentTypeUsage(tx: TenantTx, documentTypeCode: string): Promise<DocumentTypeUsage>;
}

export const WORKFLOW_REPOSITORY = Symbol('WorkflowRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface WorkflowTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const WORKFLOW_TRANSACTIONS = Symbol('WorkflowTransactions');

export type WorkflowClock = () => Date;

export const WORKFLOW_CLOCK = Symbol('WorkflowClock');

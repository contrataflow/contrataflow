import type {
  ActionEntry,
  ChecklistViolation,
  WorkflowResolutionDto,
  WorkflowValidationResult,
} from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { ReleasedStage } from './ports.js';
import { RuleContextContributorRegistry } from './rule-context.js';
import type { RuleContextContributor } from './rule-context.js';
import { WorkflowApplicabilityService } from './workflow-applicability.service.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import { WorkflowEngineService } from './workflow-engine.service.js';
import type { ProcessExecutionState } from './workflow-engine.service.js';
import { RuleTestProcessSourceRegistry } from './workflow-rule-test.js';
import type { RuleTestProcessSource } from './workflow-rule-test.js';
import { WorkflowVersionPublisher } from './workflow-version.publisher.js';
import type {
  PublishWorkflowVersionInput,
  PublishWorkflowVersionResult,
} from './workflow-version.publisher.js';
import { resolveStageAssignee, resolveStageDepartment } from '../domain/stage-destination.js';
import type {
  AssigneeCandidates,
  DestinationStage,
  RequestingUnits,
  ResolvedDepartment,
} from '../domain/stage-destination.js';
import type { ApplicabilityProcess } from '../domain/workflow-applicability.js';
import type {
  CompletionChoice,
  DecisionAction,
  DecisionChoice,
  DecisionTarget,
  EngineViewer,
  ReturnEvaluation,
  TransitionEvaluation,
} from '../domain/workflow-engine.js';
import type { WorkflowSnapshot, WorkflowSnapshotStage } from '../domain/workflow-snapshot.js';

export type {
  RuleContextContribution,
  RuleContextContributor,
  RuleContextRequest,
} from './rule-context.js';
export type { ReleasedStage } from './ports.js';
export type { RuleTestProcess, RuleTestProcessSource } from './workflow-rule-test.js';
export type { ProcessExecutionState } from './workflow-engine.service.js';
export type {
  PublishWorkflowVersionInput,
  PublishWorkflowVersionResult,
} from './workflow-version.publisher.js';
export type { RuleDocumentFact, StageApprovalFact, StagePassFact } from '../domain/rule-facts.js';
export type {
  AssigneeCandidates,
  DestinationStage,
  RequestingUnits,
  ResolvedDepartment,
} from '../domain/stage-destination.js';
export type { ApplicabilityProcess } from '../domain/workflow-applicability.js';
export type {
  CompletionChoice,
  DecisionAction,
  DecisionChoice,
  DecisionEvaluation,
  DecisionTarget,
  EngineViewer,
  ProcessActionPermission,
  ReturnEvaluation,
  TransitionEvaluation,
} from '../domain/workflow-engine.js';
export type { WorkflowSnapshot, WorkflowSnapshotStage } from '../domain/workflow-snapshot.js';

/**
 * API pública do módulo `workflow` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-042: resolução do workflow aplicável. US-040: validação completa, publicação interna (seeder — US-042;
 * WF-21 — US-045) e a definição publicada. US-041: o motor de execução — `getAvailableActions` e
 * `evaluateRules` (PRC-08/PRC-09 e, antes de aceitar uma transição, os comandos de tramitação),
 * a resolução de destino (RN-WF-30/31) e o registro dos contribuidores do `RuleContext` v1. A
 * autorização é de quem chama.
 */
@Injectable()
export class WorkflowFacade {
  constructor(
    private readonly definitions: WorkflowDefinitionService,
    private readonly publisher: WorkflowVersionPublisher,
    private readonly engine: WorkflowEngineService,
    private readonly contributors: RuleContextContributorRegistry,
    private readonly applicability: WorkflowApplicabilityService,
    private readonly ruleTestProcesses: RuleTestProcessSourceRegistry,
  ) {}

  /**
   * RN-WF-39 · RN-PROC-06 (US-042): workflow aplicável aos dados do processo, no `tx` do chamador
   * (a criação do processo — US-001 — fixa `workflowVersionId` e a etapa inicial devolvidos). Sem
   * nenhum aplicável nem padrão → 422 `NO_APPLICABLE_WORKFLOW`.
   */
  resolveApplicable(tx: TenantTx, process: ApplicabilityProcess): Promise<WorkflowResolutionDto> {
    return this.applicability.resolveIn(tx, process);
  }

  /** `WorkflowDefinitionValidator.validate(versionId)`: todos os erros e avisos (V-11). */
  validate(versionId: string): Promise<WorkflowValidationResult> {
    return this.definitions.validate(versionId);
  }

  /** Publica numa transação própria (422 `WORKFLOW_INVALID` com os problemas). */
  publish(input: PublishWorkflowVersionInput): Promise<PublishWorkflowVersionResult> {
    return this.publisher.publish(input);
  }

  /** Publica no `tx` do chamador (seeder dos workflows padrão — US-042). */
  publishIn(
    tx: TenantTx,
    input: PublishWorkflowVersionInput,
  ): Promise<PublishWorkflowVersionResult> {
    return this.publisher.publishIn(tx, input);
  }

  /** Snapshot da versão publicada/aposentada (cache imutável; Redis fora → banco). */
  publishedDefinition(versionId: string): Promise<WorkflowSnapshot | null> {
    return this.definitions.publishedDefinition(versionId);
  }

  /**
   * Como `publishedDefinition`, lendo o banco no `tx` do chamador (US-001: etapa inicial, SLA e
   * políticas de destino na transação da criação — sem segunda conexão por requisição).
   */
  publishedDefinitionIn(tx: TenantTx, versionId: string): Promise<WorkflowSnapshot | null> {
    return this.definitions.publishedDefinitionIn(tx, versionId);
  }

  /**
   * Etapas das versões publicadas e aposentadas do tenant (US-002): o filtro "Etapa" por chave em
   * qualquer versão (RN-PROC-22), as opções do filtro sem `WORKFLOW_VIEW` e os nomes da etapa atual.
   * Somente leitura; a autorização é de quem chama.
   */
  releasedStages(tx: TenantTx): Promise<ReleasedStage[]> {
    return this.definitions.releasedStages(tx);
  }

  /** Nome do workflow e número da versão fixada no processo (`null` = inexistente no tenant). */
  describeVersion(
    tx: TenantTx,
    versionId: string,
  ): Promise<{ workflowId: string; name: string; versionNumber: number } | null> {
    return this.definitions.describeVersion(tx, versionId);
  }

  /**
   * RN-WF-23/24/32: ações da etapa atual — avanços por transição (`enabled` só sem regra
   * `BLOCKING` pendente), devoluções às etapas percorridas e ciclo de vida — com `reasons[]`.
   */
  getAvailableActions(
    tx: TenantTx,
    state: ProcessExecutionState,
    viewer: EngineViewer,
  ): Promise<ActionEntry[]> {
    return this.engine.getAvailableActions(tx, state, viewer);
  }

  /**
   * RN-WF-24..29: regras `STAGE_EXIT` da etapa e `TRANSITION` das saídas não satisfeitas, como
   * `violations[]` (`WORKFLOW_RULE`) — bloqueantes antes dos avisos.
   */
  evaluateRules(tx: TenantTx, state: ProcessExecutionState): Promise<ChecklistViolation[]> {
    return this.engine.evaluateRules(tx, state);
  }

  /**
   * RN-TRAM-04/05 (US-047): a transição escolhida pelo comando — da versão fixada, partindo da
   * etapa atual e com a ação pedida — e as regras `STAGE_EXIT` + `TRANSITION` não satisfeitas.
   * `null` = indisponível. O mesmo cálculo de `getAvailableActions`/`evaluateRules`.
   */
  evaluateTransition(
    tx: TenantTx,
    state: ProcessExecutionState,
    request: { readonly transitionId: string; readonly action: 'FORWARD' | 'COMPLETE' },
  ): Promise<TransitionEvaluation | null> {
    return this.engine.evaluateTransition(tx, state, request);
  }

  /**
   * US-010 (POL-08 · RN-PROC-111/113): a saída de conclusão da etapa atual — a transição `COMPLETE`
   * (a principal ou a primeira) ou a etapa `END` já ativa (FA-03) — com as regras `STAGE_EXIT` +
   * `TRANSITION` não satisfeitas. `UNAVAILABLE` = a etapa não conclui.
   */
  evaluateCompletion(tx: TenantTx, state: ProcessExecutionState): Promise<CompletionChoice> {
    return this.engine.evaluateCompletion(tx, state);
  }

  /**
   * RN-TRAM-24 (US-048): o destino `targetStageId` da devolução — etapa já percorrida e configurada
   * numa `RETURN` da etapa atual —, com a transição e a última passagem. `null` = indisponível.
   */
  evaluateReturn(
    tx: TenantTx,
    state: ProcessExecutionState,
    request: { readonly targetStageId: string },
  ): Promise<ReturnEvaluation | null> {
    return this.engine.evaluateReturn(tx, state, request);
  }

  /**
   * RN-TRAM-56 (US-052): a saída da decisão da aprovação de etapa — `transitionId` informada ou a
   * única da ação; mais de uma devolução sem escolha = `CHOICE_REQUIRED`; indisponível (etapa não
   * percorrida, sem saída) = `UNAVAILABLE`. Com as regras `TRANSITION` não satisfeitas.
   */
  evaluateDecision(
    tx: TenantTx,
    state: ProcessExecutionState,
    request: { readonly action: DecisionAction; readonly transitionId: string | null },
  ): Promise<DecisionChoice> {
    return this.engine.evaluateDecision(tx, state, request);
  }

  /** US-052 (APV-02): todas as saídas de decisão da etapa `APPROVAL` atual, com as regras. */
  decisionTargets(tx: TenantTx, state: ProcessExecutionState): Promise<DecisionTarget[]> {
    return this.engine.decisionTargets(tx, state);
  }

  /**
   * RN-TRAM-32 (US-049): a etapa da passagem ativa na versão fixada no processo (`null` = sem
   * passagem ativa ou fora da versão) — o "Assumir" não vale em etapa `APPROVAL`.
   */
  currentStage(state: ProcessExecutionState): Promise<WorkflowSnapshotStage | null> {
    return this.engine.currentStage(state);
  }

  /** RN-WF-30: unidade responsável da etapa alcançada. */
  resolveStageDepartment(
    stage: DestinationStage,
    process: RequestingUnits,
    chosenDepartmentId: string | null = null,
  ): ResolvedDepartment {
    return resolveStageDepartment(stage, process, chosenDepartmentId);
  }

  /** RN-WF-31: responsável inicial da etapa alcançada (`null` = fila da unidade). */
  resolveStageAssignee(stage: DestinationStage, candidates: AssigneeCandidates): string | null {
    return resolveStageAssignee(stage, candidates);
  }

  /**
   * Registra um contribuidor do `RuleContext` v1 (módulos de artefatos, no `onModuleInit`): a sua
   * seção entra em toda avaliação, sem que `workflow`/`process` dependam do módulo.
   */
  registerRuleContextContributor(contributor: RuleContextContributor): void {
    this.contributors.register(contributor);
  }

  /**
   * Registra a fonte do processo de referência de "Testar regra" (WF-23 · US-044): o módulo
   * `process` carrega o runtime VISÍVEL ao usuário (DEC-024) no `tx` do teste.
   */
  registerRuleTestProcessSource(source: RuleTestProcessSource): void {
    this.ruleTestProcesses.register(source);
  }
}

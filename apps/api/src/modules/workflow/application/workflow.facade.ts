import type {
  ActionEntry,
  ChecklistViolation,
  WorkflowResolutionDto,
  WorkflowValidationResult,
} from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { RuleContextContributorRegistry } from './rule-context.js';
import type { RuleContextContributor } from './rule-context.js';
import { WorkflowApplicabilityService } from './workflow-applicability.service.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import { WorkflowEngineService } from './workflow-engine.service.js';
import type { ProcessExecutionState } from './workflow-engine.service.js';
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
import type { EngineViewer } from '../domain/workflow-engine.js';
import type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

export type {
  RuleContextContribution,
  RuleContextContributor,
  RuleContextRequest,
} from './rule-context.js';
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
export type { EngineViewer, ProcessActionPermission } from '../domain/workflow-engine.js';
export type { WorkflowSnapshot } from '../domain/workflow-snapshot.js';

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
}

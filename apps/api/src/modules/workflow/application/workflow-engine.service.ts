import { withSpan } from '@contrataflow/observability';
import type {
  ActionEntry,
  ChecklistViolation,
  ProcessStatus,
  RuleContextV1,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { WORKFLOW_CLOCK } from './ports.js';
import type { WorkflowClock } from './ports.js';
import { RuleContextBuilder } from './rule-context.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import { recordEngine, recordRuleFailure } from './workflow-telemetry.js';
import type {
  RuleDocumentFact,
  RuleFacts,
  StageApprovalFact,
  StagePassFact,
} from '../domain/rule-facts.js';
import { testRule } from '../domain/rule-test.js';
import type { RuleTestInput, RuleTestOutcome } from '../domain/rule-test.js';
import {
  activePassOf,
  availableActions,
  checklistOf,
  evaluateReturn,
  evaluateStage,
  evaluateTransition,
} from '../domain/workflow-engine.js';
import type {
  EngineInput,
  EngineProcess,
  EngineViewer,
  ReturnEvaluation,
  StageEvaluation,
  TransitionEvaluation,
} from '../domain/workflow-engine.js';
import type { WorkflowSnapshot, WorkflowSnapshotStage } from '../domain/workflow-snapshot.js';

/*
 * Motor de execução (US-041 · RN-WF-23..33): o mesmo cálculo para PRC-08/PRC-09 e, antes de aceitar
 * uma transição, para os comandos de tramitação (US-047/US-048) — UI e backend nunca divergem.
 * Somente leitura: carrega o snapshot da versão FIXADA no processo (cache imutável — nunca o
 * rascunho, RN-WF-33), monta o `RuleContext` v1 no `tx` do chamador e roda o motor puro.
 */

/** O processo como o módulo `process` o entrega ao motor (já carregado no `tx` da consulta). */
export interface ProcessExecutionState {
  readonly processId: string;
  /** `Process.workflowVersionId` (fixada na criação; imutável). */
  readonly workflowVersionId: string;
  readonly status: ProcessStatus;
  readonly createdById: string;
  readonly currentDepartmentId: string;
  readonly currentResponsibleId: string | null;
  /** Já tem número (US-009 — `DISCARD` só no rascunho sem número); ausente = numerado. */
  readonly numbered?: boolean;
  /** `process.*` do RuleContext v1 (o `status` acima prevalece). */
  readonly ruleProcess: RuleContextV1['process'];
  /** Todas as passagens do processo (`ProcessStage`), a ativa inclusive. */
  readonly passes: readonly StagePassFact[];
  /** Decisões das aprovações de etapa (`REQUIRED_APPROVAL`). */
  readonly approvals: readonly StageApprovalFact[];
  /** Documentos do processo (parte genérica de `documents.*`). */
  readonly documents: readonly RuleDocumentFact[];
}

/** A versão fixada não está publicada/visível: dado inconsistente (FK garante) → 500. */
export class PinnedWorkflowVersionUnavailableError extends Error {
  constructor(readonly workflowVersionId: string) {
    super('Versão de workflow do processo indisponível.');
    this.name = 'PinnedWorkflowVersionUnavailableError';
  }
}

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger('WorkflowEngine');

  constructor(
    private readonly definitions: WorkflowDefinitionService,
    private readonly contexts: RuleContextBuilder,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
  ) {}

  /** `evaluateRules` — checklist da etapa atual (PRC-09). */
  evaluateRules(tx: TenantTx, state: ProcessExecutionState): Promise<ChecklistViolation[]> {
    return withSpan('workflow.evaluate_rules', this.spanAttributes(state), async () => {
      const startedAt = performance.now();
      const { evaluation } = await this.evaluate(tx, state);
      const checklist = checklistOf(evaluation);
      recordEngine('checklist', performance.now() - startedAt);
      return checklist;
    });
  }

  /** `getAvailableActions` — ações com motivos de indisponibilidade (PRC-08). */
  getAvailableActions(
    tx: TenantTx,
    state: ProcessExecutionState,
    viewer: EngineViewer,
  ): Promise<ActionEntry[]> {
    return withSpan('workflow.available_actions', this.spanAttributes(state), async () => {
      const startedAt = performance.now();
      const { input, evaluation } = await this.evaluate(tx, state);
      const actions = availableActions(input, viewer, evaluation);
      const durationMs = performance.now() - startedAt;
      recordEngine('actions', durationMs);
      const enabled = actions.filter((action) => action.enabled).length;
      this.logger.log(
        {
          event: 'workflow.actions_computed',
          processId: state.processId,
          workflowVersionId: state.workflowVersionId,
          stageKey: evaluation.stage?.key ?? null,
          enabledCount: enabled,
          disabledCount: actions.length - enabled,
          durationMs: Math.round(durationMs),
          correlationId: currentRequestContext()?.correlationId,
        },
        'workflow.actions_computed',
      );
      return actions;
    });
  }

  /**
   * `evaluateTransition` (US-047 · RN-TRAM-04/05): a transição pedida pelo comando de tramitação,
   * avaliada sobre o MESMO cálculo de PRC-08/09 (UI e backend nunca divergem). `null` = transição
   * indisponível para a etapa atual. O `state` deve ter sido lido DEPOIS do bloqueio do processo.
   */
  evaluateTransition(
    tx: TenantTx,
    state: ProcessExecutionState,
    request: { readonly transitionId: string; readonly action: 'FORWARD' | 'COMPLETE' },
  ): Promise<TransitionEvaluation | null> {
    return withSpan('workflow.evaluate_transition', this.spanAttributes(state), async () => {
      const startedAt = performance.now();
      const { input, evaluation } = await this.evaluate(tx, state);
      const result = evaluateTransition(input, request, evaluation);
      recordEngine('transition', performance.now() - startedAt);
      return result;
    });
  }

  /**
   * `evaluateReturn` (US-048 · RN-TRAM-24): o destino da devolução sobre o MESMO cálculo das
   * entradas `RETURN` de PRC-08. `null` = etapa não percorrida ou sem `RETURN` configurada na etapa
   * atual. O `state` deve ter sido lido DEPOIS do bloqueio do processo.
   */
  evaluateReturn(
    tx: TenantTx,
    state: ProcessExecutionState,
    request: { readonly targetStageId: string },
  ): Promise<ReturnEvaluation | null> {
    return withSpan('workflow.evaluate_return', this.spanAttributes(state), async () => {
      const startedAt = performance.now();
      const { input, evaluation } = await this.evaluate(tx, state);
      const result = evaluateReturn(input, request, evaluation);
      recordEngine('transition', performance.now() - startedAt);
      return result;
    });
  }

  /**
   * `currentStage` (US-049 · RN-TRAM-32): a etapa da passagem ativa na versão FIXADA no processo
   * (só o tipo importa ao "Assumir"), sem montar o RuleContext. `null` = sem passagem ativa ou
   * etapa fora da versão.
   */
  async currentStage(state: ProcessExecutionState): Promise<WorkflowSnapshotStage | null> {
    const definition = await this.definitions.publishedDefinition(state.workflowVersionId);
    if (definition === null)
      throw new PinnedWorkflowVersionUnavailableError(state.workflowVersionId);
    const active = activePassOf(state.passes);
    if (active === null) return null;
    return definition.stages.find((candidate) => candidate.id === active.workflowStageId) ?? null;
  }

  private spanAttributes(state: ProcessExecutionState) {
    return {
      'cf.process.id': state.processId,
      'cf.workflow.version_id': state.workflowVersionId,
    };
  }

  private async evaluate(
    tx: TenantTx,
    state: ProcessExecutionState,
  ): Promise<{ readonly input: EngineInput; readonly evaluation: StageEvaluation }> {
    const definition = await withSpan('workflow.load_definition', this.spanAttributes(state), () =>
      this.definitions.publishedDefinition(state.workflowVersionId),
    );
    if (definition === null) {
      this.logger.error(
        {
          event: 'workflow.pinned_version_unavailable',
          processId: state.processId,
          workflowVersionId: state.workflowVersionId,
          correlationId: currentRequestContext()?.correlationId,
        },
        'workflow.pinned_version_unavailable',
      );
      throw new PinnedWorkflowVersionUnavailableError(state.workflowVersionId);
    }
    const facts = await this.factsOf(tx, state, definition);
    const process: EngineProcess = {
      status: state.status,
      createdById: state.createdById,
      currentDepartmentId: state.currentDepartmentId,
      currentResponsibleId: state.currentResponsibleId,
      numbered: state.numbered ?? true,
      requestingDepartmentId: state.ruleProcess.requestingDepartmentId,
      requestingSecretariatId: state.ruleProcess.requestingSecretariatId,
    };
    const input: EngineInput = { definition, process, facts };
    const evaluation = evaluateStage(input);
    const active = activePassOf(state.passes);
    if (active !== null && evaluation.stage === null) {
      this.logger.error(
        {
          event: 'workflow.stage_not_in_version',
          processId: state.processId,
          workflowVersionId: state.workflowVersionId,
          workflowStageId: active.workflowStageId,
          correlationId: currentRequestContext()?.correlationId,
        },
        'workflow.stage_not_in_version',
      );
    }
    this.reportProblems(state, evaluation);
    return { input, evaluation };
  }

  /**
   * "Testar regra" (US-044 · WF-23 · RN-WF-59): a regra avulsa sobre o RuleContext v1 do processo,
   * montado como no runtime (semente + contribuidores, na versão FIXADA no processo). Somente
   * leitura; quem chama autoriza e confere a forma da `config`.
   */
  testRule(
    tx: TenantTx,
    state: ProcessExecutionState,
    rule: RuleTestInput['rule'],
    budgetVisible: boolean,
  ): Promise<RuleTestOutcome> {
    return withSpan('workflow.test_rule', this.spanAttributes(state), async () => {
      const definition = await this.definitions.publishedDefinition(state.workflowVersionId);
      const facts = await this.factsOf(tx, state, definition);
      return testRule({ definition, facts, rule, budgetVisible });
    });
  }

  /** RuleContext v1 + listas do processo; a etapa ativa é resolvida na versão informada. */
  private async factsOf(
    tx: TenantTx,
    state: ProcessExecutionState,
    definition: WorkflowSnapshot | null,
  ): Promise<RuleFacts> {
    const active = activePassOf(state.passes);
    const stage =
      active === null || definition === null
        ? null
        : (definition.stages.find((candidate) => candidate.id === active.workflowStageId) ?? null);
    const built = await withSpan('workflow.build_rule_context', this.spanAttributes(state), () =>
      this.contexts.build(tx, {
        processId: state.processId,
        now: this.clock(),
        process: { ...state.ruleProcess, status: state.status },
        stage:
          active === null || stage === null
            ? null
            : { key: stage.key, enteredAt: new Date(active.enteredAt) },
        documents: state.documents,
      }),
    );
    return {
      context: built.context,
      documents: built.documents,
      passes: state.passes,
      approvals: state.approvals,
    };
  }

  /** FA-03: regra não avaliável = não satisfeita, com log (nunca o conteúdo nem valores). */
  private reportProblems(state: ProcessExecutionState, evaluation: StageEvaluation): void {
    for (const { rule, outcome } of evaluation.results) {
      const { problem } = outcome;
      if (problem === undefined) continue;
      recordRuleFailure(rule.type, problem.kind);
      const fields = {
        processId: state.processId,
        workflowVersionId: state.workflowVersionId,
        ruleId: rule.id,
        ruleType: rule.type,
        cause: problem.kind,
        detail: problem.detail,
        correlationId: currentRequestContext()?.correlationId,
      };
      if (problem.kind === 'MISSING_PATH') {
        this.logger.warn(
          { event: 'workflow.rule_context_missing_path', ...fields },
          'workflow.rule_context_missing_path',
        );
      } else {
        this.logger.error(
          { event: 'workflow.rule_evaluation_failed', ...fields },
          'workflow.rule_evaluation_failed',
        );
      }
    }
  }
}

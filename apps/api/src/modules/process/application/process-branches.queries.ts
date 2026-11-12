import type {
  ActionEntry,
  ActionStageDto,
  ActiveStageDto,
  ProcessBranchesDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { joinStateOf } from './branch-engine.js';
import { executionStateOf } from './execution-state.js';
import { PROCESS_CLOCK } from './ports.js';
import type { ProcessAggregateRows, ProcessClock, ProcessStageRow } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { EngineViewer, WorkflowSnapshot } from '../../workflow/application/workflow.facade.js';
import {
  activeSplitOf,
  activeStagesOf,
  isControlStageType,
  stageStatusOf,
} from '../domain/process-branches.js';
import type { ProcessRuntime, ProcessStagePass } from '../domain/process-runtime.js';

/** Ações que dizem respeito a UMA etapa ativa (as demais valem para o processo inteiro). */
const STAGE_ACTIONS: ReadonlySet<ActionEntry['action']> = new Set([
  'FORWARD',
  'COMPLETE',
  'RETURN',
  'CLAIM',
  'ASSIGN',
]);

/** PRC-08 no paralelismo: as ações de cada etapa ativa e o resumo das etapas (`stages[]`). */
export interface ParallelActions {
  readonly actions: ActionEntry[];
  /** `null` fora da ramificação (a resposta do MVP 1 não muda — DEC-108). */
  readonly stages: ActionStageDto[] | null;
}

/**
 * Leituras do runtime de ramos (US-124 · RN-WF2-15 · api.md MVP 2 PRC-04/PRC-08/PRC-39): as ações
 * por etapa ativa (o motor roda sobre a visão focada de cada uma — custódia por ramo; no último
 * ramo `OPEN`, a entrada para a junção já traz as regras do join), as etapas ativas do processo
 * (`activeStages[]`) e a visão dos ramos de uma rodada. Somente leitura, no `tx` de quem chama.
 */
@Injectable()
export class ProcessBranchReader {
  constructor(
    private readonly workflow: WorkflowFacade,
    private readonly organization: OrganizationFacade,
    private readonly identity: IdentityFacade,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
  ) {}

  /** PRC-08: fora da ramificação, o motor do MVP 1; nela, uma rodada do motor por etapa ativa. */
  async actions(
    tx: TenantTx,
    runtime: ProcessRuntime,
    viewer: EngineViewer,
  ): Promise<ParallelActions> {
    const split = runtime.passes.find(
      (pass) => pass.status === 'ACTIVE' && pass.stageType === 'PARALLEL_SPLIT',
    );
    if (split === undefined) {
      return {
        actions: await this.workflow.getAvailableActions(tx, executionStateOf(runtime), viewer),
        stages: null,
      };
    }
    const definition = await this.workflow.publishedDefinitionIn(tx, runtime.workflowVersionId);
    const actives = runtime.passes
      .filter((pass) => pass.status === 'ACTIVE' && !isControlStageType(pass.stageType ?? 'TASK'))
      .sort((left, right) => left.sequence - right.sequence);
    const lastOpen = actives.filter((pass) => (pass.branchKey ?? null) !== null).length === 1;
    const actions: ActionEntry[] = [];
    const processWide = new Map<ActionEntry['action'], ActionEntry>();
    const stages: ActionStageDto[] = [];
    for (const pass of actives) {
      const isMine =
        pass.assigneeId === null
          ? viewer.departmentIds.includes(pass.departmentId)
          : pass.assigneeId === viewer.userId;
      const stage = definition?.stages.find((candidate) => candidate.id === pass.workflowStageId);
      stages.push({
        processStageId: pass.processStageId,
        branchKey: pass.branchKey ?? null,
        stageKey: stage?.key ?? '',
        stageName: stage?.name ?? '',
        isMine,
      });
      const focused = focusRuntime(runtime, pass);
      let entries = await this.workflow.getAvailableActions(tx, executionStateOf(focused), viewer);
      if (lastOpen && definition !== null && pass.branchKey !== null) {
        entries = await this.withJoinRules(tx, runtime, pass, definition, entries);
      }
      for (const entry of entries) {
        if (STAGE_ACTIONS.has(entry.action)) {
          actions.push({
            ...entry,
            processStageId: pass.processStageId,
            branchKey: pass.branchKey ?? null,
          });
        } else if (!processWide.has(entry.action) || (isMine && entry.enabled)) {
          // FA-05: ações do processo inteiro — vale a da etapa de que o usuário tem a custódia.
          processWide.set(entry.action, entry);
        }
      }
    }
    return { actions: [...actions, ...processWide.values()], stages };
  }

  /** `activeStages[]` (PRC-04 · RN-WF2-15): as etapas ativas `TASK`/`APPROVAL`… do processo. */
  async activeStages(tx: TenantTx, rows: ProcessAggregateRows): Promise<ActiveStageDto[]> {
    const actives = activeStagesOf(rows.stages);
    if (actives.length === 0) return [];
    const definition = await this.workflow.publishedDefinitionIn(
      tx,
      rows.process.workflowVersionId,
    );
    return this.describe(tx, actives, definition);
  }

  /** PRC-39 — a rodada `round` (ou a mais recente) do bloco paralelo; `null` fora dele. */
  async branches(
    tx: TenantTx,
    rows: ProcessAggregateRows,
    round: string | null,
  ): Promise<ProcessBranchesDto | null> {
    const splits = rows.stages
      .filter((stage) => stage.stageType === 'PARALLEL_SPLIT')
      .sort((left, right) => right.sequence - left.sequence);
    const split =
      round === null
        ? (activeSplitOf(rows.stages) ?? splits[0])
        : splits.find((candidate) => candidate.id === round);
    if (split === undefined) return null;
    const definition = await this.workflow.publishedDefinitionIn(
      tx,
      rows.process.workflowVersionId,
    );
    const splitStage = definition?.stages.find((stage) => stage.id === split.workflowStageId);
    const joinStageKey = joinKeyOf(definition, split.workflowStageId);
    const branchStages = rows.stages.filter((stage) => stage.splitProcessStageId === split.id);
    const described = await this.describe(tx, branchStages, definition);
    const branches = rows.branches.filter((branch) => branch.splitProcessStageId === split.id);
    return {
      splitProcessStageId: split.id,
      splitStageKey: splitStage?.key ?? '',
      joinStageKey,
      status: split.status,
      openBranchesLeft: branches.filter((branch) => branch.status === 'OPEN').length,
      branches: branches.map((branch) => {
        const own = branchStages
          .filter((stage) => stage.branchKey === branch.branchKey)
          .sort((left, right) => left.sequence - right.sequence);
        const active = own.find((stage) => stage.status === 'ACTIVE');
        return {
          branchKey: branch.branchKey,
          status: branch.status,
          arrivedAt: branch.arrivedAt?.toISOString() ?? null,
          canceledAt: branch.canceledAt?.toISOString() ?? null,
          cancellationReason: branch.cancellationReason,
          activeStage:
            active === undefined
              ? null
              : (described.find((stage) => stage.processStageId === active.id) ?? null),
          passes: own.map((stage) => {
            const named = definition?.stages.find((s) => s.id === stage.workflowStageId);
            return {
              processStageId: stage.id,
              stageKey: named?.key ?? '',
              stageName: named?.name ?? '',
              status: stage.status,
              enteredAt: stage.enteredAt.toISOString(),
              exitedAt: stage.exitedAt?.toISOString() ?? null,
            };
          }),
        };
      }),
      previousRounds: splits
        .filter((candidate) => candidate.id !== split.id)
        .map((candidate) => ({ splitProcessStageId: candidate.id, status: candidate.status })),
    };
  }

  private async describe(
    tx: TenantTx,
    stages: readonly ProcessStageRow[],
    definition: WorkflowSnapshot | null,
  ): Promise<ActiveStageDto[]> {
    const departments = await this.organization.departmentNames(tx, [
      ...new Set(stages.map((stage) => stage.departmentId)),
    ]);
    const userIds = [
      ...new Set(stages.map((stage) => stage.assigneeId).filter((id): id is string => id !== null)),
    ];
    const users = await this.identity.userDisplayNames(tx, userIds);
    const now = this.clock();
    return stages
      .filter((stage) => stage.status === 'ACTIVE')
      .map((stage) => {
        const named = definition?.stages.find(
          (candidate) => candidate.id === stage.workflowStageId,
        );
        return {
          processStageId: stage.id,
          stageKey: named?.key ?? '',
          stageName: named?.name ?? '',
          stageType: stage.stageType,
          branchKey: stage.branchKey,
          department: { id: stage.departmentId, name: departments.get(stage.departmentId) ?? '' },
          responsible:
            stage.assigneeId === null
              ? null
              : { id: stage.assigneeId, name: users.get(stage.assigneeId) ?? '' },
          enteredAt: stage.enteredAt.toISOString(),
          dueAt: stage.dueAt?.toISOString() ?? null,
          isOverdue: stage.dueAt !== null && stage.pausedAt === null && stage.dueAt < now,
          openedByReturn: stage.openedByReturn,
        };
      });
  }

  /**
   * RN-WF2-20 (FA-03): no último ramo `OPEN`, a entrada para a junção já mostra as regras `BLOCKING`
   * do join sobre o processo inteiro (o mesmo cálculo do comando).
   */
  private async withJoinRules(
    tx: TenantTx,
    runtime: ProcessRuntime,
    pass: ProcessStagePass,
    definition: WorkflowSnapshot,
    entries: ActionEntry[],
  ): Promise<ActionEntry[]> {
    const toJoin = entries.filter(
      (entry) => entry.action === 'FORWARD' && entry.toStageType === 'PARALLEL_JOIN',
    );
    if (toJoin.length === 0) return entries;
    const joinStageId = definition.stages.find(
      (stage) => stage.key === toJoin[0]?.toStageKey && stage.type === 'PARALLEL_JOIN',
    )?.id;
    const joinStage = definition.stages.find((stage) => stage.id === joinStageId);
    const exit = definition.transitions.find(
      (transition) => transition.fromStageId === joinStageId && transition.action === 'FORWARD',
    );
    if (joinStage === undefined || exit === undefined) return entries;
    const evaluation = await this.workflow.evaluateTransition(
      tx,
      joinStateOf(
        runtime,
        {
          id: pass.processStageId,
          workflowStageId: pass.workflowStageId,
          sequence: pass.sequence,
          departmentId: pass.departmentId,
          assigneeId: pass.assigneeId,
          enteredAt: new Date(pass.enteredAt),
          splitProcessStageId: pass.splitProcessStageId ?? null,
        },
        joinStage,
        this.clock(),
      ),
      { transitionId: exit.id, action: 'FORWARD' },
    );
    const blocking = (evaluation?.violations ?? []).filter(
      (violation) => violation.severity === 'BLOCKING',
    );
    if (blocking.length === 0) return entries;
    return entries.map((entry) =>
      toJoin.includes(entry)
        ? {
            ...entry,
            enabled: false,
            reasons: [
              ...entry.reasons,
              ...blocking.map((violation) => ({
                code: 'TRANSITION_BLOCKED' as const,
                message: violation.message,
                ruleId: violation.ruleId,
              })),
            ],
          }
        : entry,
    );
  }
}

/** Visão focada do runtime numa passagem ativa (RN-WF2-17 — custódia e status da etapa). */
function focusRuntime(runtime: ProcessRuntime, pass: ProcessStagePass): ProcessRuntime {
  return {
    ...runtime,
    status: stageStatusOf(runtime.status, {
      stageType: pass.stageType ?? 'TASK',
      openedByReturn: pass.openedByReturn ?? false,
    }),
    currentDepartmentId: pass.departmentId,
    currentResponsibleId: pass.assigneeId,
    passes: runtime.passes.filter(
      (candidate) =>
        candidate.status !== 'ACTIVE' || candidate.processStageId === pass.processStageId,
    ),
  };
}

/** A junção do bloco: a primeira `PARALLEL_JOIN` alcançada a partir dos ramos do split. */
function joinKeyOf(definition: WorkflowSnapshot | null, splitStageId: string): string | null {
  if (definition === null) return null;
  const seen = new Set<string>([splitStageId]);
  const queue = definition.transitions
    .filter((transition) => transition.fromStageId === splitStageId)
    .map((transition) => transition.toStageId);
  while (queue.length > 0) {
    const stageId = queue.shift() ?? '';
    if (seen.has(stageId)) continue;
    seen.add(stageId);
    const stage = definition.stages.find((candidate) => candidate.id === stageId);
    if (stage?.type === 'PARALLEL_JOIN') return stage.key;
    for (const transition of definition.transitions) {
      if (transition.fromStageId === stageId && transition.action !== 'RETURN') {
        queue.push(transition.toStageId);
      }
    }
  }
  return null;
}
